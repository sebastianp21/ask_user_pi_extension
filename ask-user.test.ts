/**
 * Tests for the ask_user extension.
 *
 * Run with:
 *   node --import ./test/hooks.mjs --test ask-user.test.ts
 *
 * The loader hook maps the two Pi runtime packages to local stubs so the
 * extension can be imported without a Pi install. See test/hooks.mjs.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Key } from "@earendil-works/pi-tui";
import askUser, {
	describeAnswer,
	normalizeOptions,
	prepareAskUserArguments,
} from "./ask-user.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Theme stub: colors are identity so tests can assert on plain text. */
const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	bg: (_color: string, text: string) => text,
};

interface CapturedTool {
	name: string;
	prepareArguments?: (args: unknown) => unknown;
	parameters: any;
	execute: (id: string, params: any, signal: any, onUpdate: any, ctx: any) => Promise<any>;
	renderCall: (args: any, theme: any) => any;
	renderResult: (result: any, options: any, theme: any) => any;
}

/** Register the extension against a fake pi API and return the tool definition. */
function captureTool(): CapturedTool {
	let captured: CapturedTool | undefined;
	const pi = {
		registerTool(definition: CapturedTool) {
			captured = definition;
		},
	};
	askUser(pi as any);
	assert.ok(captured, "ask_user should register a tool");
	return captured;
}

/** A fake ctx whose select/input dialogs are puppeteered by the test. */
function dialogsCtx(ui: { select?: any; input?: any } = {}) {
	return {
		hasUI: true,
		mode: "rpc",
		ui: {
			select: ui.select ?? (async () => undefined),
			input: ui.input ?? (async () => undefined),
		},
	};
}

/** A fake TUI ctx that captures the custom component synchronously. */
function tuiHarness() {
	let component: any;
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			custom(factory: any) {
				return new Promise((resolve) => {
					const tui = { requestRender() {} };
					component = factory(tui, theme, undefined, resolve);
				});
			},
		},
	};
	return {
		ctx,
		get component() {
			return component;
		},
	};
}

/** Start an execute() call against the TUI, drive the component, return the result. */
async function runTui(params: any, drive: (component: any) => void) {
	const tool = captureTool();
	const harness = tuiHarness();
	const pending = tool.execute("call", params, undefined, undefined, harness.ctx);
	assert.ok(harness.component, "the custom component should be created synchronously");
	drive(harness.component);
	return pending;
}

const question = "Which database should we use?";

// ---------------------------------------------------------------------------
// prepareArguments: tolerant normalization of raw model arguments
// ---------------------------------------------------------------------------

test("prepareArguments parses an options array serialized as a JSON string", () => {
	const prepared: any = prepareAskUserArguments({
		question,
		options: '[{"label":"SQLite","value":"sqlite"},{"label":"Postgres"}]',
	});
	assert.deepEqual(prepared.options, [
		{ label: "SQLite", value: "sqlite" },
		{ label: "Postgres" },
	]);
});

test("prepareArguments parses a JSON string containing a single option object", () => {
	const prepared: any = prepareAskUserArguments({
		question,
		options: '{"label":"SQLite","description":"file-based"}',
	});
	assert.deepEqual(prepared.options, [{ label: "SQLite", description: "file-based" }]);
});

test("prepareArguments wraps a single option object in an array", () => {
	const prepared: any = prepareAskUserArguments({
		question,
		options: { label: "Postgres", value: "postgres" },
	});
	assert.deepEqual(prepared.options, [{ label: "Postgres", value: "postgres" }]);
});

test("prepareArguments accepts plain-string options", () => {
	const prepared: any = prepareAskUserArguments({ question, options: ["A", "  B  ", ""] });
	assert.deepEqual(prepared.options, [{ label: "A" }, { label: "B" }]);
});

test("prepareArguments drops malformed entries", () => {
	const prepared: any = prepareAskUserArguments({
		question,
		options: [{ label: "ok" }, { description: "no label" }, 42, null, { label: "   " }],
	});
	assert.deepEqual(prepared.options, [{ label: "ok" }]);
});

test("prepareArguments yields an empty array for unparseable JSON", () => {
	const prepared: any = prepareAskUserArguments({ question, options: "{not json" });
	assert.deepEqual(prepared.options, []);
});

test("prepareArguments coerces a stringified recommended index", () => {
	const prepared: any = prepareAskUserArguments({
		question,
		options: [{ label: "A" }, { label: "B" }],
		recommended: "2",
	});
	assert.equal(prepared.recommended, 2);
});

test("prepareArguments drops a non-numeric recommended index", () => {
	const prepared: any = prepareAskUserArguments({
		question,
		options: [{ label: "A" }],
		recommended: "first",
	});
	assert.equal("recommended" in prepared, false);
});

test("prepareArguments preserves unrelated fields", () => {
	const prepared: any = prepareAskUserArguments({
		question,
		context: "because",
		allowFreeform: false,
		options: [{ label: "A" }],
	});
	assert.equal(prepared.question, question);
	assert.equal(prepared.context, "because");
	assert.equal(prepared.allowFreeform, false);
});

test("normalizeOptions keeps descriptions and values on well-formed options", () => {
	assert.deepEqual(normalizeOptions([{ label: "A", description: "d", value: "a" }]), [
		{ label: "A", description: "d", value: "a" },
	]);
});

// ---------------------------------------------------------------------------
// describeAnswer / model-facing text
// ---------------------------------------------------------------------------

test("describeAnswer reports a selected option by its value", () => {
	const text = describeAnswer(question, {
		text: "SQLite",
		value: "sqlite",
		index: 1,
		wasFreeform: false,
	});
	assert.match(text, /selected option 1: sqlite/);
	assert.match(text, /label: "SQLite"/);
	assert.match(text, /Proceed according to this decision\./);
});

test("describeAnswer falls back to the label when no value is set", () => {
	const text = describeAnswer(question, { text: "SQLite", value: "SQLite", index: 1, wasFreeform: false });
	assert.match(text, /selected option 1: SQLite/);
	assert.doesNotMatch(text, /label:/);
});

test("describeAnswer reports a free-form answer", () => {
	const text = describeAnswer(question, { text: "CockroachDB", value: "CockroachDB", wasFreeform: true });
	assert.match(text, /wrote their own answer: CockroachDB/);
});

test("describeAnswer includes an attached note", () => {
	const text = describeAnswer(question, {
		text: "SQLite",
		value: "sqlite",
		index: 1,
		wasFreeform: false,
		note: "for now",
	});
	assert.match(text, /User's note: for now/);
});

// ---------------------------------------------------------------------------
// Registered tool: definition, no-UI and invalid handling
// ---------------------------------------------------------------------------

test("the registered tool exposes the expected shape", () => {
	const tool = captureTool();
	assert.equal(tool.name, "ask_user");
	assert.equal(typeof tool.prepareArguments, "function");
	assert.equal(tool.parameters.properties.options.kind, "array");
	assert.equal(tool.parameters.properties.options.items.properties.value.kind, "string");
});

test("execute reports no-ui distinctly when no human is available", async () => {
	const tool = captureTool();
	const res = await tool.execute(
		"call",
		{ question, options: [{ label: "A" }, { label: "B" }] },
		undefined,
		undefined,
		{ hasUI: false, mode: "rpc", ui: {} },
	);
	assert.equal(res.details.reason, "no-ui");
	assert.equal(res.details.answer, null);
	assert.match(res.content[0].text, /No human is available/);
});

test("execute reports invalid input instead of approving", async () => {
	const tool = captureTool();
	const res = await tool.execute(
		"call",
		{ question, options: [], allowFreeform: false },
		undefined,
		undefined,
		dialogsCtx(),
	);
	assert.equal(res.details.reason, "invalid");
	assert.equal(res.details.answer, null);
	assert.match(res.content[0].text, /invalid arguments/);
});

// ---------------------------------------------------------------------------
// Registered tool: dialog (RPC) path
// ---------------------------------------------------------------------------

test("dialogs return the chosen option's value and index", async () => {
	const tool = captureTool();
	const ctx = dialogsCtx({
		select: async (_title: string, labels: string[]) => labels[1],
	});
	const res = await tool.execute(
		"call",
		{
			question,
			options: [
				{ label: "SQLite", value: "sqlite" },
				{ label: "Postgres", value: "postgres" },
			],
		},
		undefined,
		undefined,
		ctx,
	);
	assert.equal(res.details.answer.index, 2);
	assert.equal(res.details.answer.text, "Postgres");
	assert.equal(res.details.answer.value, "postgres");
	assert.match(res.content[0].text, /selected option 2: postgres/);
});

test("dialogs support a free-form answer", async () => {
	const tool = captureTool();
	const ctx = dialogsCtx({
		select: async (_title: string, labels: string[]) => labels[labels.length - 1],
		input: async () => "  CockroachDB  ",
	});
	const res = await tool.execute(
		"call",
		{ question, options: [{ label: "SQLite" }] },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(res.details.answer.wasFreeform, true);
	assert.equal(res.details.answer.value, "CockroachDB");
});

test("dialogs with no options go straight to free-form input", async () => {
	const tool = captureTool();
	let selectCalled = false;
	const ctx = dialogsCtx({
		select: async () => {
			selectCalled = true;
			return undefined;
		},
		input: async () => "Postgres",
	});
	const res = await tool.execute("call", { question, options: [] }, undefined, undefined, ctx);
	assert.equal(selectCalled, false);
	assert.equal(res.details.answer.value, "Postgres");
});

test("dismissing the dialog is reported as cancelled, not approval", async () => {
	const tool = captureTool();
	const ctx = dialogsCtx({ select: async () => undefined });
	const res = await tool.execute(
		"call",
		{ question, options: [{ label: "A" }] },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(res.details.reason, "cancelled");
	assert.equal(res.details.answer, null);
	assert.match(res.content[0].text, /dismissed the question/);
});

test("an empty free-form answer is treated as cancellation", async () => {
	const tool = captureTool();
	const ctx = dialogsCtx({
		select: async (_title: string, labels: string[]) => labels[labels.length - 1],
		input: async () => "   ",
	});
	const res = await tool.execute(
		"call",
		{ question, options: [{ label: "A" }] },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(res.details.reason, "cancelled");
	assert.equal(res.details.answer, null);
});

test("an aborted signal is reported distinctly", async () => {
	const tool = captureTool();
	const controller = new AbortController();
	controller.abort();
	const ctx = dialogsCtx({ select: async () => undefined });
	const res = await tool.execute(
		"call",
		{ question, options: [{ label: "A" }] },
		controller.signal,
		undefined,
		ctx,
	);
	assert.equal(res.details.reason, "aborted");
	assert.equal(res.details.answer, null);
});

// ---------------------------------------------------------------------------
// Registered tool: custom TUI component
// ---------------------------------------------------------------------------

test("TUI selects the highlighted option on Enter", async () => {
	const res = await runTui(
		{ question, options: [{ label: "SQLite", value: "sqlite" }, { label: "Postgres" }], allowFreeform: false },
		(component) => component.handleInput(Key.enter),
	);
	assert.equal(res.details.answer.value, "sqlite");
	assert.equal(res.details.answer.index, 1);
});

test("TUI number shortcuts pick an option directly", async () => {
	const res = await runTui(
		{ question, options: [{ label: "A" }, { label: "B", value: "bee" }], allowFreeform: false },
		(component) => component.handleInput("2"),
	);
	assert.equal(res.details.answer.value, "bee");
	assert.equal(res.details.answer.index, 2);
});

test("TUI arrow navigation moves the selection before Enter", async () => {
	const res = await runTui(
		{ question, options: [{ label: "A" }, { label: "B" }], allowFreeform: false },
		(component) => {
			component.handleInput(Key.down);
			component.handleInput(Key.enter);
		},
	);
	assert.equal(res.details.answer.index, 2);
});

test("TUI free-form entry returns the typed text", async () => {
	const res = await runTui(
		{ question, options: [{ label: "A" }, { label: "B" }] },
		(component) => {
			component.handleInput("3"); // free-form row
			component.handleInput("CockroachDB");
			component.handleInput(Key.enter);
		},
	);
	assert.equal(res.details.answer.wasFreeform, true);
	assert.equal(res.details.answer.value, "CockroachDB");
});

test("TUI Tab attaches a note to the selected option", async () => {
	const res = await runTui(
		{ question, options: [{ label: "A", value: "a" }, { label: "B" }], allowFreeform: false },
		(component) => {
			component.handleInput(Key.tab);
			component.handleInput("for now");
			component.handleInput(Key.enter);
		},
	);
	assert.equal(res.details.answer.value, "a");
	assert.equal(res.details.answer.note, "for now");
});

test("TUI Escape cancels the question", async () => {
	const res = await runTui(
		{ question, options: [{ label: "A" }], allowFreeform: false },
		(component) => component.handleInput(Key.escape),
	);
	assert.equal(res.details.reason, "cancelled");
	assert.equal(res.details.answer, null);
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test("renderCall lists options and flags the recommended one", () => {
	const tool = captureTool();
	const node = tool.renderCall(
		{ question, options: [{ label: "SQLite" }, { label: "Postgres" }], recommended: 1, allowFreeform: false },
		theme,
	);
	assert.match(node.text, /1\. SQLite ★/);
	assert.match(node.text, /2\. Postgres/);
});

test("renderResult labels a cancellation without implying consent", () => {
	const tool = captureTool();
	const node = tool.renderResult(
		{
			content: [{ type: "text", text: "dismissed" }],
			details: { question, options: ["A"], allowFreeform: true, answer: null, reason: "cancelled" },
		},
		{},
		theme,
	);
	assert.match(node.text, /Cancelled/);
});
