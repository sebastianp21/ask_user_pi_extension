/**
 * Minimal stand-in for the `typebox` package. ask-user.ts only builds a schema
 * object with it; tests inspect the schema structurally.
 */

function schema(kind, options = {}) {
	return { kind, ...options };
}

export const Type = {
	Object: (properties, options) => schema("object", { properties, ...options }),
	String: (options) => schema("string", options),
	Optional: (inner) => ({ ...inner, optional: true }),
	Array: (items, options) => schema("array", { items, ...options }),
	Integer: (options) => schema("integer", options),
	Boolean: (options) => schema("boolean", options),
};
