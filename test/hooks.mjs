/**
 * Test-only module resolution hook.
 *
 * `ask-user.ts` imports two runtime packages (`@earendil-works/pi-tui` and
 * `typebox`) that are provided by the Pi host but are not installed in this
 * standalone repository. These tests never need their real implementations, so
 * we map those bare specifiers to tiny local stubs. `@earendil-works/pi-coding-agent`
 * is only imported as a type and is erased by Node's type stripping.
 *
 * Usage: node --import ./test/hooks.mjs --test ask-user.test.ts
 */
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const stubs = new Map([
	["@earendil-works/pi-tui", pathToFileURL(join(here, "pi-tui.mjs")).href],
	["typebox", pathToFileURL(join(here, "typebox.mjs")).href],
]);

registerHooks({
	resolve(specifier, context, nextResolve) {
		const stub = stubs.get(specifier);
		if (stub) return { url: stub, shortCircuit: true };
		return nextResolve(specifier, context);
	},
});
