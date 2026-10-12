/**
 * Minimal stand-in for @earendil-works/pi-tui, covering only what ask-user.ts
 * uses. Behavior mirrors the real primitives closely enough to drive the
 * custom picker component in tests.
 */

export const Key = {
	up: "up",
	down: "down",
	enter: "enter",
	tab: "tab",
	escape: "escape",
};

export function matchesKey(data, key) {
	return data === key;
}

export class Text {
	constructor(text, x = 0, y = 0) {
		this.text = text;
		this.x = x;
		this.y = y;
	}
}

function stripAnsi(value) {
	return String(value).replace(/\u001b\[[0-9;]*m/g, "");
}

export function visibleWidth(text) {
	return stripAnsi(text).length;
}

export function wrapTextWithAnsi(text, width) {
	const plain = stripAnsi(text);
	const w = Math.max(1, width);
	if (!plain) return [""];
	const lines = [];
	for (let i = 0; i < plain.length; i += w) lines.push(plain.slice(i, i + w));
	return lines;
}

/** A small inline editor: printable input is appended, Enter submits. */
export class Editor {
	constructor(tui, theme) {
		this.tui = tui;
		this.theme = theme;
		this.text = "";
		this.onSubmit = () => {};
	}

	setText(text) {
		this.text = text;
	}

	handleInput(data) {
		if (data === Key.enter) {
			this.onSubmit(this.text);
			return;
		}
		if (data === Key.escape) return;
		this.text += data;
	}

	render() {
		return [this.text || ""];
	}
}
