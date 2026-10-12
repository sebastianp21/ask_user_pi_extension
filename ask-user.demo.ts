/**
 * Interactive / configurable demo of the ask_user flow.
 *
 * It uses the real extension (ask-user.ts) and a scripted-or-interactive user,
 * so the whole loop is reproducible without running pi itself.
 *
 * Usage:
 *   node ask-user.demo.ts
 *       -> default task, picks a question automatically
 *
 *   node ask-user.demo.ts "add rate limiting to the API"
 *       -> derives a question from your task (keyword match)
 *
 *   node ask-user.demo.ts --interactive "add caching"
 *       -> you type the answer (number, or your own text)
 *
 *   node ask-user.demo.ts --choice 2 "add caching"
 *   node ask-user.demo.ts --answer "use memcached" "add caching"
 *       -> scripted answers (also used automatically when stdin is not a TTY)
 *
 *   node ask-user.demo.ts --list
 *       -> show the built-in question scenarios
 */

import { createInterface } from "node:readline/promises";
import askUser from "./ask-user.ts";

interface DemoOption {
	label: string;
	value: string;
	description: string;
}

interface Scenario {
	keywords: string[];
	question: string;
	context: string;
	options: DemoOption[];
	recommended: number;
	continuations: Record<string, string>;
}

// --- Built-in scenarios; a task's keywords pick one automatically -----------
const scenarios: Scenario[] = [
	{
		keywords: ["cache", "caching", "redis", "memo"],
		question: "Where should the API cache responses?",
		context:
			"I checked the code: there is no existing cache layer. The choice affects " +
			"deployment (extra service?) and consistency across instances.",
		options: [
			{ label: "In-memory", value: "memory", description: "Simplest; per-instance, lost on restart." },
			{ label: "Redis", value: "redis", description: "Shared across instances; needs a server." },
			{ label: "None", value: "none", description: "Skip caching for now." },
		],
		recommended: 2,
		continuations: {
			memory: "add an in-process LRU cache and document per-instance caveats.",
			redis: "add a Redis-backed cache, gate it behind CACHE_URL, and wire invalidation.",
			none: "skip caching and note it as a future improvement.",
		},
	},
	{
		keywords: ["database", "db", "storage", "persist", "sql"],
		question: "Which database should we use?",
		context: "The options differ mainly in setup complexity, scale, and deployment model.",
		options: [
			{ label: "SQLite", value: "sqlite", description: "Zero-config, file-based; great for local/small apps." },
			{ label: "Postgres", value: "postgres", description: "Server DB; better for concurrency and production." },
			{ label: "MongoDB", value: "mongo", description: "Document store; flexible schema." },
		],
		recommended: 1,
		continuations: {
			sqlite: "use SQLite with a migrations folder and a single-file DB path.",
			postgres: "use Postgres, add a DATABASE_URL, and set up migrations.",
			mongo: "use MongoDB with a schemaless collection layer and indexes.",
		},
	},
	{
		keywords: ["auth", "login", "session", "token", "jwt", "oauth"],
		question: "How should users authenticate?",
		context: "This is a product/security decision; it changes the login flow and dependencies.",
		options: [
			{ label: "Cookie sessions", value: "session", description: "Simple, server-side sessions." },
			{ label: "JWT", value: "jwt", description: "Stateless tokens; needs refresh handling." },
			{ label: "OAuth provider", value: "oauth", description: "Delegate to Google/GitHub; adds config." },
		],
		recommended: 2,
		continuations: {
			session: "add cookie-based sessions with a server-side store.",
			jwt: "issue short-lived JWTs plus a refresh-token flow.",
			oauth: "integrate an OAuth provider and map external identities.",
		},
	},
	{
		keywords: ["test", "testing", "runner", "vitest", "jest"],
		question: "Which test runner should we use?",
		context: "The repo has no test setup yet; the runner shapes config and CI.",
		options: [
			{ label: "node:test", value: "node", description: "Built in, zero deps." },
			{ label: "Vitest", value: "vitest", description: "Fast, ESM-first, great DX." },
			{ label: "Jest", value: "jest", description: "Mature ecosystem, more config." },
		],
		recommended: 1,
		continuations: {
			node: "use node:test with no extra dependencies.",
			vitest: "add Vitest config and coverage reporting.",
			jest: "add a Jest config and ts transform.",
		},
	},
];

function genericScenario(task: string): Scenario {
	return {
		keywords: [],
		question: `How should I proceed with: "${task}"?`,
		context: "I could not find a built-in scenario for this task, so this question is generic.",
		options: [
			{ label: "Recommended path", value: "recommended", description: "Do the safest, conventional thing." },
			{ label: "Minimal path", value: "minimal", description: "Do the smallest change that works." },
			{ label: "Explain first", value: "explain", description: "Stop and describe the options in detail." },
		],
		recommended: 1,
		continuations: {
			recommended: "take the conventional approach and state assumptions.",
			minimal: "take the smallest viable change and note follow-ups.",
			explain: "pause and write up the trade-offs before changing anything.",
		},
	};
}

function pickScenario(task: string): Scenario {
	const lower = task.toLowerCase();
	let best: Scenario | undefined;
	let bestHits = 0;
	for (const scenario of scenarios) {
		const hits = scenario.keywords.filter((keyword) => lower.includes(keyword)).length;
		if (hits > bestHits) {
			best = scenario;
			bestHits = hits;
		}
	}
	return best ?? genericScenario(task);
}

// --- CLI parsing ------------------------------------------------------------
const argv = process.argv.slice(2);
function takeFlag(name: string): string | undefined {
	const index = argv.indexOf(name);
	if (index === -1) return undefined;
	const value = argv[index + 1];
	argv.splice(index, value !== undefined ? 2 : 1);
	return value;
}

const listOnly = argv.includes("--list");
if (listOnly) {
	for (const scenario of scenarios) {
		console.log(`${scenario.question}\n  keywords: ${scenario.keywords.join(", ")}`);
	}
	process.exit(0);
}

const forcedChoice = takeFlag("--choice");
const forcedAnswer = takeFlag("--answer");
const interactive = argv.includes("--interactive");
const task = argv.filter((arg) => !arg.startsWith("--")).join(" ") || "Add response caching to the API.";

const scenario = pickScenario(task);
const toolCall = {
	question: scenario.question,
	context: scenario.context,
	options: scenario.options.map(({ label, value, description }) => ({ label, value, description })),
	recommended: scenario.recommended,
};

// --- Capture the registered tool from a fake Pi host ------------------------
let tool: any;
askUser({ registerTool: (definition: any) => { tool = definition; } } as any);

const rule = () => console.log("─".repeat(72));

console.log(`TASK: ${task}`);
const source =
	scenario.keywords.length === 0
		? "generic fallback"
		: `matched "${scenario.keywords.join('", "')}"`;
console.log(`\n(auto-selected question: ${source})`);
console.log("\nAGENT → ask_user:");
console.log(`  question: ${toolCall.question}`);
console.log(`  context:  ${toolCall.context}`);
for (const [i, option] of toolCall.options.entries()) {
	const star = toolCall.recommended === i + 1 ? " ★" : "";
	console.log(`  ${i + 1}. ${option.label}${star} — ${option.description}`);
}

// --- Build the "user": interactive, forced, or auto -------------------------
function autoCtx(choice?: string, answer?: string) {
	let pendingAnswer = answer;
	return {
		hasUI: true,
		mode: "rpc",
		close: () => {},
		ui: {
			select: async (title: string, labels: string[]) => {
				rule();
				console.log(`USER SEES:\n${title}\n`);
				for (const label of labels) console.log(`  ${label}`);
				let picked: string | undefined;
				if (choice) picked = labels[Number(choice) - 1];
				else if (pendingAnswer) picked = labels[labels.length - 1];
				else picked = labels[toolCall.recommended - 1];
				console.log(`\nUSER → selects: ${picked}`);
				rule();
				return picked;
			},
			input: async () => {
				const text = pendingAnswer ?? "";
				pendingAnswer = undefined;
				return text;
			},
		},
	};
}

async function interactiveCtx() {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	let pending: string | undefined;
	return {
		hasUI: true,
		mode: "rpc",
		// The readline handle keeps the event loop alive; close it once we're
		// done so the process exits even on a numbered pick (where input() is
		// never reached and therefore never closes it).
		close: () => rl.close(),
		ui: {
			select: async (title: string, labels: string[]) => {
				rule();
				console.log(`USER SEES:\n${title}\n`);
				for (const label of labels) console.log(`  ${label}`);
				const raw = (await rl.question("\nYour choice (a number, or type your own answer): ")).trim();
				if (/^\d+$/.test(raw)) {
					const n = Number(raw);
					if (n >= 1 && n <= labels.length) {
						console.log(`USER → selects: ${labels[n - 1]}`);
						rule();
						return labels[n - 1];
					}
				}
				pending = raw;
				rule();
				return labels[labels.length - 1]; // free-form row
			},
			input: async () => {
				const text = pending ?? (await rl.question("Your answer: "));
				pending = undefined;
				rl.close();
				return text;
			},
		},
	};
}

const useInteractive = interactive || (process.stdin.isTTY && !forcedChoice && !forcedAnswer);
const ctx = useInteractive ? await interactiveCtx() : autoCtx(forcedChoice, forcedAnswer);
if (!useInteractive && !process.stdin.isTTY) {
	console.log("\n(stdin is not a TTY — auto-answering with the recommended option)");
}

// --- Run the tool and let the agent continue --------------------------------
try {
	const result = await tool.execute("demo-call", toolCall, undefined, undefined, ctx);
	const answer = result.details.answer;

	console.log("\nTOOL RESULT returned to the agent (content text):");
	console.log(result.content[0].text);
	console.log("\nTOOL RESULT details.answer:");
	console.log(JSON.stringify(answer, null, 2));

	console.log("\nAGENT continues using answer.value =", JSON.stringify(answer.value));
	const continuation =
		scenario.continuations[answer.value] ??
		"apply the user's answer, restating it in the next action.";
	console.log(`  → ${continuation}`);
} finally {
	// Release the interactive prompt so Node can exit.
	ctx.close();
}
