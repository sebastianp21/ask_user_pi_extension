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

const FREEFORM_LABEL = "Write my own answer…";

// ---------------------------------------------------------------------------
// Self-contained terminal primitives
//
// Pi normally provides `@earendil-works/pi-tui` and `typebox` as host modules.
// This extension imports neither, so it can be loaded and tested with nothing
// installed: the small subset of TUI helpers it needs lives here, and the tool
// schema below is plain JSON Schema (validated by Pi's bundled TypeBox).
// ---------------------------------------------------------------------------

export const Key = {
	escape: "escape",
	esc: "esc",
	enter: "enter",
	return: "return",
	tab: "tab",
	backspace: "backspace",
	delete: "delete",
	home: "home",
	end: "end",
	up: "up",
	down: "down",
	left: "left",
	right: "right",
} as const;

const KEY_SEQUENCES: Record<string, string[]> = {
	escape: ["\x1b"],
	enter: ["\r", "\n", "\x1bOM"],
	tab: ["\t"],
	backspace: ["\x7f", "\b"],
	delete: ["\x1b[3~"],
	home: ["\x1b[H", "\x1bOH", "\x1b[1~", "\x1b[7~"],
	end: ["\x1b[F", "\x1bOF", "\x1b[4~", "\x1b[8~"],
	up: ["\x1b[A", "\x1bOA"],
	down: ["\x1b[B", "\x1bOB"],
	right: ["\x1b[C", "\x1bOC"],
	left: ["\x1b[D", "\x1bOD"],
};

const KITTY_CODEPOINTS: Record<string, number> = { escape: 27, tab: 9, enter: 13, backspace: 127 };
const KITTY_KP_ENTER = 57414;
const CSI_DIRECTIONS: Record<string, string> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };

/** True when raw terminal input matches a key identifier such as `Key.up`. */
export function matchesKey(data: string, key: string): boolean {
	if (data === key) return true;
	if (KEY_SEQUENCES[key]?.includes(data)) return true;
	const kitty = /^\x1b\[(\d+)(?:;\d+)?u$/.exec(data);
	if (kitty) {
		const codepoint = Number(kitty[1]);
		if (codepoint === KITTY_CODEPOINTS[key]) return true;
		if (key === "enter" && codepoint === KITTY_KP_ENTER) return true;
	}
	const csi = /^\x1b\[(?:1(?:;\d+)?)?([ABCDHF])$/.exec(data);
	if (csi && CSI_DIRECTIONS[csi[1]] === key) return true;
	return false;
}

const ANSI_ESCAPE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
const SGR = /^\x1b\[([0-9;]*)m/;

function stripAnsi(text: string): string {
	return text.replace(ANSI_ESCAPE, "");
}

function charWidth(codepoint: number): number {
	if (codepoint === 0 || codepoint < 32 || (codepoint >= 0x7f && codepoint < 0xa0)) return 0;
	if (
		(codepoint >= 0x0300 && codepoint <= 0x036f) ||
		(codepoint >= 0x1ab0 && codepoint <= 0x1aff) ||
		(codepoint >= 0x1dc0 && codepoint <= 0x1dff) ||
		(codepoint >= 0x20d0 && codepoint <= 0x20ff) ||
		(codepoint >= 0xfe20 && codepoint <= 0xfe2f)
	) {
		return 0;
	}
	if (
		(codepoint >= 0x1100 && codepoint <= 0x115f) ||
		(codepoint >= 0x2e80 && codepoint <= 0x303e) ||
		(codepoint >= 0x3041 && codepoint <= 0x33ff) ||
		(codepoint >= 0x3400 && codepoint <= 0x4dbf) ||
		(codepoint >= 0x4e00 && codepoint <= 0x9fff) ||
		(codepoint >= 0xa000 && codepoint <= 0xa4cf) ||
		(codepoint >= 0xac00 && codepoint <= 0xd7a3) ||
		(codepoint >= 0xf900 && codepoint <= 0xfaff) ||
		(codepoint >= 0xfe10 && codepoint <= 0xfe19) ||
		(codepoint >= 0xfe30 && codepoint <= 0xfe6f) ||
		(codepoint >= 0xff00 && codepoint <= 0xff60) ||
		(codepoint >= 0xffe0 && codepoint <= 0xffe6) ||
		(codepoint >= 0x1f300 && codepoint <= 0x1faff) ||
		(codepoint >= 0x20000 && codepoint <= 0x3fffd)
	) {
		return 2;
	}
	return 1;
}

/** Visible width of a string in terminal columns, ignoring ANSI escape codes. */
export function visibleWidth(text: string): number {
	if (!text) return 0;
	let width = 0;
	for (const ch of stripAnsi(text).replace(/\t/g, "   ")) width += charWidth(ch.codePointAt(0) ?? 0);
	return width;
}

type SgrGroup = number[];

function removeGroups(active: SgrGroup[], predicate: (group: SgrGroup) => boolean): void {
	for (let i = active.length - 1; i >= 0; i--) {
		if (predicate(active[i])) active.splice(i, 1);
	}
}

function isBasicFg(param: number): boolean {
	return (param >= 30 && param <= 37) || (param >= 90 && param <= 97);
}

function isBasicBg(param: number): boolean {
	return (param >= 40 && param <= 47) || (param >= 100 && param <= 107);
}

function applySgr(paramsText: string, active: SgrGroup[]): void {
	const params = paramsText === "" ? [0] : paramsText.split(";").map((value) => Number(value) || 0);
	let i = 0;
	while (i < params.length) {
		const param = params[i];
		if (param === 0) {
			active.length = 0;
			i += 1;
			continue;
		}
		if (param === 39) {
			removeGroups(active, (group) => group[0] === 38 || group[0] === 39 || isBasicFg(group[0]));
			i += 1;
			continue;
		}
		if (param === 49) {
			removeGroups(active, (group) => group[0] === 48 || group[0] === 49 || isBasicBg(group[0]));
			i += 1;
			continue;
		}
		if (param === 22) {
			removeGroups(active, (group) => group[0] === 1 || group[0] === 2);
			i += 1;
			continue;
		}
		if (param >= 23 && param <= 29) {
			removeGroups(active, (group) => group[0] === param - 20);
			i += 1;
			continue;
		}
		if (param === 38 || param === 48) {
			const isFg = param === 38;
			removeGroups(
				active,
				(group) => group[0] === param || (isFg ? isBasicFg(group[0]) : isBasicBg(group[0])),
			);
			if (params[i + 1] === 5) {
				active.push([param, 5, params[i + 2] ?? 0]);
				i += 3;
				continue;
			}
			if (params[i + 1] === 2) {
				active.push([param, 2, params[i + 2] ?? 0, params[i + 3] ?? 0, params[i + 4] ?? 0]);
				i += 5;
				continue;
			}
			active.push([param]);
			i += 1;
			continue;
		}
		if (isBasicFg(param)) {
			removeGroups(active, (group) => group[0] === 38 || isBasicFg(group[0]));
			active.push([param]);
			i += 1;
			continue;
		}
		if (isBasicBg(param)) {
			removeGroups(active, (group) => group[0] === 48 || isBasicBg(group[0]));
			active.push([param]);
			i += 1;
			continue;
		}
		if (!active.some((group) => group.length === 1 && group[0] === param)) active.push([param]);
		i += 1;
	}
}

function activeSequence(active: SgrGroup[]): string {
	return active.length ? `\x1b[${active.map((group) => group.join(";")).join(";")}m` : "";
}

interface WordAtom {
	text: string;
	width: number;
}

function splitWordAtoms(word: string): WordAtom[] {
	const atoms: WordAtom[] = [];
	let pending = "";
	let i = 0;
	while (i < word.length) {
		const sgr = SGR.exec(word.slice(i));
		if (sgr) {
			pending += sgr[0];
			i += sgr[0].length;
			continue;
		}
		const codepoint = word.codePointAt(i) ?? 0;
		const ch = String.fromCodePoint(codepoint);
		i += ch.length;
		atoms.push({ text: pending + ch, width: charWidth(codepoint) });
		pending = "";
	}
	if (pending) {
		if (atoms.length) atoms[atoms.length - 1].text += pending;
		else atoms.push({ text: pending, width: 0 });
	}
	return atoms;
}

/** Word-wrap text to `width` visible columns, preserving ANSI styling across lines. */
export function wrapTextWithAnsi(text: string, width: number): string[] {
	if (!text) return [""];
	const maxWidth = Math.max(1, width);
	const result: string[] = [];
	const active: SgrGroup[] = [];

	for (const inputLine of text.split(/\r\n|\r|\n/)) {
		let line = activeSequence(active);
		let lineWidth = 0;
		let word = "";
		let wordWidth = 0;
		let spaces = "";
		let spacesWidth = 0;

		const breakLine = () => {
			result.push(line + (active.length ? "\x1b[0m" : ""));
			line = activeSequence(active);
			lineWidth = 0;
		};
		const placeWord = () => {
			if (!word) return;
			if (lineWidth > 0 && lineWidth + spacesWidth + wordWidth > maxWidth) {
				breakLine();
				spaces = "";
				spacesWidth = 0;
			}
			if (wordWidth > maxWidth && lineWidth === 0) {
				for (const atom of splitWordAtoms(word)) {
					if (lineWidth > 0 && lineWidth + atom.width > maxWidth) breakLine();
					line += atom.text;
					lineWidth += atom.width;
				}
			} else {
				line += spaces + word;
				lineWidth += spacesWidth + wordWidth;
				spaces = "";
				spacesWidth = 0;
			}
			word = "";
			wordWidth = 0;
		};

		let i = 0;
		while (i < inputLine.length) {
			const sgr = SGR.exec(inputLine.slice(i));
			if (sgr) {
				applySgr(sgr[1], active);
				word += sgr[0];
				i += sgr[0].length;
				continue;
			}
			const codepoint = inputLine.codePointAt(i) ?? 0;
			const ch = String.fromCodePoint(codepoint);
			i += ch.length;
			if (ch === " " || ch === "\t") {
				placeWord();
				spaces += ch === "\t" ? "   " : ch;
				spacesWidth += ch === "\t" ? 3 : 1;
			} else {
				word += ch;
				wordWidth += charWidth(codepoint);
			}
		}
		placeWord();
		result.push(line + (active.length ? "\x1b[0m" : ""));
	}
	return result.length ? result : [""];
}

/** Minimal multi-line text component compatible with Pi's renderer. */
export class Text {
	text: string;
	paddingX: number;
	paddingY: number;

	constructor(text = "", paddingX = 1, paddingY = 1) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
	}

	setText(text: string): void {
		this.text = text;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (!this.text || this.text.trim() === "") return [];
		const w = Math.max(1, width);
		const paddingX = Math.min(this.paddingX, Math.max(0, Math.floor((w - 1) / 2)));
		const contentWidth = Math.max(1, w - paddingX * 2);
		const left = " ".repeat(paddingX);
		const right = " ".repeat(paddingX);
		const lines: string[] = [];
		for (const line of wrapTextWithAnsi(this.text.replace(/\t/g, "   "), contentWidth)) {
			const padded = left + line + right;
			lines.push(padded + " ".repeat(Math.max(0, w - visibleWidth(padded))));
		}
		if (this.paddingY > 0) {
			const empty = " ".repeat(w);
			const blank = Array.from({ length: this.paddingY }, () => empty);
			return [...blank, ...lines, ...blank];
		}
		return lines;
	}
}

function isIgnoredInput(data: string): boolean {
	if (data.startsWith("\x1b")) return true;
	for (const ch of data) {
		const code = ch.codePointAt(0) ?? 0;
		if (code < 32 && ch !== "\t" && ch !== "\n" && ch !== "\r") return true;
	}
	return false;
}

/** Minimal single-line editor compatible with the picker above. */
export class Editor {
	text = "";
	onSubmit: (value: string) => void = () => {};

	setText(text: string): void {
		this.text = text;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.enter)) {
			this.onSubmit(this.text);
			return;
		}
		if (matchesKey(data, Key.backspace)) {
			this.text = this.text.slice(0, -1);
			return;
		}
		if (isIgnoredInput(data)) return;
		this.text += data;
	}

	render(_width: number): string[] {
		return [this.text];
	}
}

export interface AskOption {
	label: string;
	description?: string;
	/** Value returned when this option is chosen. Defaults to the label. */
	value?: string;
}

type DisplayOption = AskOption & { isFreeform?: boolean; isRecommended?: boolean };

export interface Answer {
	/** Display text of the answer (the option label, or the free-form text) */
	text: string;
	/** Value the option returns; falls back to the label, and equals `text` for free-form answers */
	value: string;
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
	/** Why there is no answer: user cancelled, aborted, invalid input, or no UI available */
	reason?: "cancelled" | "aborted" | "no-ui" | "invalid";
}

const OptionSchema = {
	type: "object",
	required: ["label"],
	properties: {
		label: { type: "string", description: "Short, concrete choice (1-8 words)" },
		description: { type: "string", description: "What picking this option means: trade-offs, consequences" },
		value: { type: "string", description: "Value returned when this option is chosen. Defaults to the label." },
	},
};

const AskUserParams = {
	type: "object",
	required: ["question", "options"],
	properties: {
		question: { type: "string", description: "The decision to resolve, phrased as a clear question ending with '?'" },
		context: {
			type: "string",
			description: "Why you cannot decide this yourself: what you found and what the choice depends on. Keep it brief.",
		},
		options: {
			type: "array",
			items: OptionSchema,
			description: "2-5 mutually exclusive choices. May be empty only if allowFreeform is true.",
			maxItems: 8,
		},
		recommended: {
			type: "integer",
			minimum: 1,
			description: "1-based index of the option you recommend, if any. It is shown first-selected and marked.",
		},
		allowFreeform: { type: "boolean", description: "Offer a free-form text answer in addition to the options (default: true)" },
	},
};

function result(text: string, details: AskUserDetails) {
	return { content: [{ type: "text" as const, text }], details };
}

/** Text the model receives for a given answer. */
export function describeAnswer(question: string, answer: Answer): string {
	const lines = [`Question: ${question}`];
	if (answer.wasFreeform) {
		lines.push(`The user wrote their own answer: ${answer.text}`);
	} else {
		const value = answer.value ?? answer.text;
		lines.push(
			value === answer.text
				? `The user selected option ${answer.index}: ${value}`
				: `The user selected option ${answer.index}: ${value} (label: "${answer.text}")`,
		);
		if (answer.note) lines.push(`User's note: ${answer.note}`);
	}
	lines.push("Proceed according to this decision.");
	return lines.join("\n");
}

/**
 * Normalize the `options` argument, tolerating common model serialization
 * mistakes: a JSON-encoded string, a single option object, or plain strings.
 * Always returns an array of well-formed options.
 */
export function normalizeOptions(raw: unknown): AskOption[] {
	let value = raw;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return [];
		}
	}
	if (!Array.isArray(value)) value = value == null ? [] : [value];

	const options: AskOption[] = [];
	for (const entry of value) {
		if (typeof entry === "string") {
			const label = entry.trim();
			if (label) options.push({ label });
			continue;
		}
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		if (typeof record.label !== "string" || !record.label.trim()) continue;
		const option: AskOption = { label: record.label };
		if (typeof record.description === "string") option.description = record.description;
		if (typeof record.value === "string") option.value = record.value;
		options.push(option);
	}
	return options;
}

/** Coerce a 1-based option index, accepting numeric strings, or drop it. */
function coerceRecommended(raw: unknown): number | undefined {
	if (typeof raw === "number" && Number.isInteger(raw)) return raw;
	if (typeof raw === "string" && /^\d+$/.test(raw.trim())) return Number(raw.trim());
	return undefined;
}

/**
 * Compatibility shim run before schema validation: repairs an `options`
 * argument that the model serialized as a JSON string or a single object, and
 * coerces a stringified `recommended` index. The declared schema stays
 * array-based.
 */
export function prepareAskUserArguments(args: unknown): Record<string, unknown> {
	if (!args || typeof args !== "object" || Array.isArray(args)) {
		return { options: [] };
	}
	const input = args as Record<string, unknown>;
	const prepared: Record<string, unknown> = { ...input, options: normalizeOptions(input.options) };
	const recommended = coerceRecommended(input.recommended);
	if (recommended === undefined) delete prepared.recommended;
	else prepared.recommended = recommended;
	return prepared;
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
		// Returns the schema-shaped arguments; normalization is validated by the schema afterwards.
		prepareArguments: (args: unknown) => prepareAskUserArguments(args) as any,
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
				return result(
					"ask_user received invalid arguments: there are no usable options and free-form answers are disabled. " +
						"Provide 2-5 options (or allow free-form answers) before trying again.",
					{ ...base, answer: null, reason: "invalid" },
				);
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
				const label =
				details.reason === "no-ui"
					? "No user available"
					: details.reason === "aborted"
						? "Aborted"
						: details.reason === "invalid"
							? "Invalid request"
							: "Cancelled";
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
		return text ? { text, value: text, wasFreeform: true } : null;
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
		return text ? { text, value: text, wasFreeform: true } : null;
	}
	const option = options[index];
	return { text: option.label, value: option.value ?? option.label, index: index + 1, wasFreeform: false };
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

		const editor = new Editor();

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
				finish({
					text: opt.label,
					value: opt.value ?? opt.label,
					index: index + 1,
					wasFreeform: false,
					note: text || undefined,
				});
				return;
			}
			if (text) finish({ text, value: text, wasFreeform: true });
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
				finish({ text: opt.label, value: opt.value ?? opt.label, index: i + 1, wasFreeform: false });
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
