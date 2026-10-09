/**
 * ask_user - Let the agent pause and hand a decision to the human.
 *
 * The model calls this tool when it hits a choice it cannot resolve from the
 * request, the code, or sensible defaults. The user sees the question, the
 * reason the agent is stuck, a list of selectable options, and (optionally) a
 * free-form "write your own answer" entry. The agent's turn is blocked until
 * the user answers or cancels.
 *
 * Install: copy to ~/.pi/agent/extensions/ask-user.ts (global) or
 * .pi/extensions/ask-user.ts (project), or run `pi -e ./ask-user.ts`.
 *
 * Modes:
 *   - tui:  full custom component (arrow keys, number shortcuts, inline editor)
 *   - rpc:  falls back to ctx.ui.select / ctx.ui.input dialogs
 *   - none: returns a result telling the model no human is available
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

const FREEFORM_LABEL = "Write my own answer…";

interface AskOption {
	label: string;
	description?: string;
}

type DisplayOption = AskOption & { isFreeform?: boolean; isRecommended?: boolean };

interface Answer {
	text: string;
	/** 1-based index of the chosen option; undefined for free-form answers */
	index?: number;
	wasFreeform: boolean;
	/** Extra note the user attached to a selected option */
	note?: string;
}

interface AskUserDetails {
	question: string;
	context?: string;
	options: string[];
	allowFreeform: boolean;
	answer: Answer | null;
	/** Why there is no answer: user cancelled, aborted, or no UI available */
	reason?: "cancelled" | "aborted" | "no-ui";
}

const OptionSchema = Type.Object({
	label: Type.String({ description: "Short, concrete choice (1-8 words)" }),
	description: Type.Optional(
		Type.String({ description: "What picking this option means: trade-offs, consequences" }),
	),
});

const AskUserParams = Type.Object({
	question: Type.String({
		description: "The decision to resolve, phrased as a clear question ending with '?'",
	}),
	context: Type.Optional(
		Type.String({
			description: "Why you cannot decide this yourself: what you found and what the choice depends on. Keep it brief.",
		}),
	),
	options: Type.Array(OptionSchema, {
		description: "2-5 mutually exclusive choices. May be empty only if allowFreeform is true.",
		maxItems: 8,
	}),
	recommended: Type.Optional(
		Type.Integer({
			minimum: 1,
			description: "1-based index of the option you recommend, if any. It is shown first-selected and marked.",
		}),
	),
	allowFreeform: Type.Optional(
		Type.Boolean({ description: "Offer a free-form text answer in addition to the options (default: true)" }),
	),
});

function result(text: string, details: AskUserDetails) {
	return { content: [{ type: "text" as const, text }], details };
}

/** Text the model receives for a given answer. */
function describeAnswer(question: string, answer: Answer): string {
	const lines = [`Question: ${question}`];
	if (answer.wasFreeform) {
		lines.push(`The user wrote their own answer: ${answer.text}`);
	} else {
		lines.push(`The user selected option ${answer.index}: ${answer.text}`);
		if (answer.note) lines.push(`User's note: ${answer.note}`);
	}
	lines.push("Proceed according to this decision.");
	return lines.join("\n");
}

export default function askUser(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description:
			"Pause and ask the human to resolve a decision you cannot make alone. Shows the question, your reasoning, " +
			"selectable options, and optionally a free-form answer. Blocks until the user responds.",
		promptSnippet: "ask_user: pause and ask the human to choose between options when a decision is genuinely theirs to make",
		promptGuidelines: [
			"Use ask_user only when blocked on a decision that is genuinely the user's to make (preferences, product direction, ambiguous requirements, destructive or irreversible choices). Do not use it for facts you can find in the code or for choices with an obvious conventional default.",
			"When calling ask_user, give 2-5 concrete, mutually exclusive options with short labels and descriptions of their trade-offs; set `recommended` when you have a preference.",
			"Ask one decision per ask_user call. Never ask 'should I proceed?' or 'is this OK?' — just proceed.",
			"If ask_user reports the user cancelled, do not ask the same question again; stop and explain what you need.",
		],
		parameters: AskUserParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const allowFreeform = params.allowFreeform !== false;
			const options = params.options ?? [];
			const base: Omit<AskUserDetails, "answer"> = {
				question: params.question,
				context: params.context,
				options: options.map((o) => o.label),
				allowFreeform,
			};

			if (options.length === 0 && !allowFreeform) {
				throw new Error("ask_user needs at least one option, or allowFreeform must be true");
			}
			const recommended =
				params.recommended && params.recommended <= options.length ? params.recommended : undefined;

			if (!ctx.hasUI) {
				return result(
					"No human is available to answer (non-interactive mode). Make the most reasonable choice yourself, " +
						"state the assumption clearly, and continue.",
					{ ...base, answer: null, reason: "no-ui" },
				);
			}

			const answer =
				ctx.mode === "tui"
					? await askInTui(ctx, params.question, params.context, options, recommended, allowFreeform, signal)
					: await askWithDialogs(ctx, params.question, params.context, options, recommended, allowFreeform, signal);

			if (signal?.aborted) {
				return result("The question was aborted before the user answered.", {
					...base,
					answer: null,
					reason: "aborted",
				});
			}
			if (!answer) {
				return result(
					"The user dismissed the question without answering. Do not ask it again; stop and explain what you need to continue.",
					{ ...base, answer: null, reason: "cancelled" },
				);
			}
			return result(describeAnswer(params.question, answer), { ...base, answer });
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("ask_user ")) + theme.fg("muted", args.question ?? "");
			const opts: AskOption[] = Array.isArray(args.options) ? args.options : [];
			if (opts.length) {
				const labels = opts.map((o, i) => `${i + 1}. ${o.label}${args.recommended === i + 1 ? " ★" : ""}`);
				if (args.allowFreeform !== false) labels.push("✎ free-form");
				text += `\n${theme.fg("dim", `  ${labels.join("  ")}`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(res, _options, theme) {
			const details = res.details as AskUserDetails | undefined;
			if (!details) {
				const first = res.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}
			if (!details.answer) {
				const label = details.reason === "no-ui" ? "No user available" : details.reason === "aborted" ? "Aborted" : "Cancelled";
				return new Text(theme.fg("warning", label), 0, 0);
			}
			const a = details.answer;
			let text = theme.fg("success", "✓ ");
			if (a.wasFreeform) {
				text += theme.fg("muted", "(wrote) ") + theme.fg("accent", a.text);
			} else {
				text += theme.fg("accent", `${a.index}. ${a.text}`);
				if (a.note) text += theme.fg("muted", ` — ${a.note}`);
			}
			return new Text(text, 0, 0);
		},
	});
}

type Ctx = Parameters<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[4];

/** RPC / non-terminal clients: use the standard select + input dialogs. */
async function askWithDialogs(
	ctx: Ctx,
	question: string,
	context: string | undefined,
	options: AskOption[],
	recommended: number | undefined,
	allowFreeform: boolean,
	signal: AbortSignal | undefined,
): Promise<Answer | null> {
	const title = context ? `${question}\n\n${context}` : question;

	if (options.length === 0) {
		const text = (await ctx.ui.input(title, "Your answer", { signal }))?.trim();
		return text ? { text, wasFreeform: true } : null;
	}

	const labels = options.map((o, i) => {
		const star = recommended === i + 1 ? " (recommended)" : "";
		return `${i + 1}. ${o.label}${star}${o.description ? ` — ${o.description}` : ""}`;
	});
	if (allowFreeform) labels.push(FREEFORM_LABEL);

	const picked = await ctx.ui.select(title, labels, { signal });
	if (picked === undefined) return null;

	const index = labels.indexOf(picked);
	if (index === options.length) {
		const text = (await ctx.ui.input(question, "Your answer", { signal }))?.trim();
		return text ? { text, wasFreeform: true } : null;
	}
	return { text: options[index].label, index: index + 1, wasFreeform: false };
}

/** Interactive terminal: custom component with options list and inline editor. */
function askInTui(
	ctx: Ctx,
	question: string,
	context: string | undefined,
	options: AskOption[],
	recommended: number | undefined,
	allowFreeform: boolean,
	signal: AbortSignal | undefined,
): Promise<Answer | null> {
	const all: DisplayOption[] = options.map((o, i) => ({ ...o, isRecommended: recommended === i + 1 }));
	if (allowFreeform) all.push({ label: FREEFORM_LABEL, isFreeform: true });

	return ctx.ui.custom<Answer | null>((tui, theme, _kb, done) => {
		let finished = false;
		const finish = (value: Answer | null) => {
			if (finished) return;
			finished = true;
			signal?.removeEventListener("abort", onAbort);
			done(value);
		};
		const onAbort = () => finish(null);
		if (signal?.aborted) queueMicrotask(onAbort);
		else signal?.addEventListener("abort", onAbort, { once: true });

		// With no options, go straight to the editor.
		let index = recommended ? recommended - 1 : 0;
		// "edit": free-form answer; "note": note attached to a selected option
		let mode: "list" | "edit" | "note" = all.length === 1 && all[0].isFreeform ? "edit" : "list";
		let cached: string[] | undefined;

		const editorTheme: EditorTheme = {
			borderColor: (s) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		};
		const editor = new Editor(tui, editorTheme);

		const refresh = () => {
			cached = undefined;
			tui.requestRender();
		};

		const backToList = () => {
			if (all.length === 1 && all[0].isFreeform) {
				finish(null); // nothing to go back to
				return;
			}
			mode = "list";
			editor.setText("");
			refresh();
		};

		editor.onSubmit = (value) => {
			const text = value.trim();
			if (mode === "note") {
				const opt = all[index];
				finish({ text: opt.label, index: index + 1, wasFreeform: false, note: text || undefined });
				return;
			}
			if (text) finish({ text, wasFreeform: true });
			else backToList();
		};

		const choose = (i: number, withNote: boolean) => {
			const opt = all[i];
			index = i;
			if (opt.isFreeform) {
				mode = "edit";
				refresh();
			} else if (withNote) {
				mode = "note";
				refresh();
			} else {
				finish({ text: opt.label, index: i + 1, wasFreeform: false });
			}
		};

		function handleInput(data: string) {
			if (mode !== "list") {
				if (matchesKey(data, Key.escape)) backToList();
				else {
					editor.handleInput(data);
					refresh();
				}
				return;
			}

			if (matchesKey(data, Key.up) || data === "k") {
				index = (index - 1 + all.length) % all.length;
				refresh();
			} else if (matchesKey(data, Key.down) || data === "j") {
				index = (index + 1) % all.length;
				refresh();
			} else if (matchesKey(data, Key.enter)) {
				choose(index, false);
			} else if (matchesKey(data, Key.tab)) {
				choose(index, true);
			} else if (matchesKey(data, Key.escape)) {
				finish(null);
			} else if (/^[1-9]$/.test(data) && Number(data) <= all.length) {
				choose(Number(data) - 1, false);
			}
		}

		function render(width: number): string[] {
			if (cached) return cached;
			const w = Math.max(1, width);
			const lines: string[] = [];

			const wrap = (prefix: string, text: string) => {
				const pw = visibleWidth(prefix);
				if (pw >= w) {
					lines.push(...wrapTextWithAnsi(prefix + text, w));
					return;
				}
				const pad = " ".repeat(pw);
				wrapTextWithAnsi(text, w - pw).forEach((line, i) => lines.push((i === 0 ? prefix : pad) + line));
			};

			lines.push(theme.fg("accent", "─".repeat(w)));
			wrap(" ", theme.fg("warning", theme.bold("⏸ Agent needs your decision")));
			lines.push("");
			wrap(" ", theme.fg("text", theme.bold(question)));
			if (context) {
				lines.push("");
				wrap(" ", theme.fg("muted", context));
			}
			lines.push("");

			all.forEach((opt, i) => {
				const selected = i === index;
				const active = selected && mode !== "list";
				const prefix = selected ? theme.fg("accent", "› ") : "  ";
				const num = opt.isFreeform ? "✎" : `${i + 1}.`;
				const star = opt.isRecommended ? theme.fg("success", " ★ recommended") : "";
				const color = selected ? "accent" : opt.isFreeform ? "muted" : "text";
				wrap(prefix, theme.fg(color, `${num} ${opt.label}${active ? " ◂" : ""}`) + star);
				if (opt.description) wrap("     ", theme.fg("muted", opt.description));
			});

			if (mode !== "list") {
				lines.push("");
				wrap(" ", theme.fg("muted", mode === "note" ? `Add a note to "${all[index].label}" (optional):` : "Your answer:"));
				for (const line of editor.render(Math.max(1, w - 2))) lines.push(` ${line}`);
			}

			lines.push("");
			const help =
				mode === "list"
					? "↑↓/jk move • 1-9 pick • Enter select • Tab select + note • Esc cancel"
					: mode === "note"
						? "Enter confirm (empty = no note) • Esc back"
						: "Enter submit • Esc back";
			wrap(" ", theme.fg("dim", help));
			lines.push(theme.fg("accent", "─".repeat(w)));

			cached = lines;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cached = undefined;
			},
			handleInput,
		};
	});
}
