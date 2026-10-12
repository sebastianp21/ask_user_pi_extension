# ask_user — pi extension

Gives the [pi](https://github.com/earendil-works/pi) coding agent an `ask_user` tool: when the agent hits a decision it cannot make alone, it pauses and asks you, showing selectable options and an optional free-form answer.

```
 ⏸ Agent needs your decision

 Which database should we use?

 We need to pick a database for this project. The options differ mainly in
 setup complexity, scale, and deployment model.

› 1. SQLite ★ recommended
     Zero-config, file-based, ideal for local/dev and small apps.
  2. Postgres
     Full-featured server DB, better for concurrent writes and production scale.
  ✎ Write my own answer…

 ↑↓/jk move • 1-9 pick • Enter select • Tab select + note • Esc cancel
```

## Install

```bash
# try it once
pi -e ./ask-user.ts

# global
cp ask-user.ts ~/.pi/agent/extensions/

# per project
mkdir -p .pi/extensions && cp ask-user.ts .pi/extensions/
```

## Tool parameters

| Parameter       | Type                                        | Description                                                   |
|-----------------|---------------------------------------------|---------------------------------------------------------------|
| `question`      | string                                      | The decision to resolve                                       |
| `context`       | string, optional                            | Why the agent can't decide this alone                         |
| `options`       | `{ label, description?, value? }[]`         | Mutually exclusive choices (may be empty if free-form allowed) |
| `recommended`   | integer, optional                           | 1-based index of the agent's preferred option                 |
| `allowFreeform` | boolean, optional (default `true`)          | Offer a "write my own answer" entry                           |

An option's `value` is returned when it is chosen; it defaults to the `label`.
Use it when the display text and the machine-meaningful value differ (for
example a concise label and a longer identifier).

## Keys

- `↑`/`↓` or `j`/`k`: move the cursor
- `1`–`9`: pick an option right away
- `Enter`: select the option (on "Write my own answer…", opens the text editor)
- `Tab`: select the option and attach a note
- `Esc`: go back from the editor, or cancel the question

## Behavior by mode

- **Interactive (TUI):** the custom picker shown above.
- **RPC:** falls back to the client's standard `select` and `input` dialogs.
- **Print / JSON (no UI):** returns immediately and tells the model to make a reasonable assumption and state it.

The tool also adds prompt guidelines so the model asks only about real decisions (not facts it can look up), asks one decision per call, and does not re-ask after you cancel.

## Non-answers

Every way of not answering is reported distinctly and is never treated as
approval:

| Reason      | Meaning                                                       |
|-------------|---------------------------------------------------------------|
| `cancelled` | The user dismissed the picker, or submitted an empty answer   |
| `aborted`   | The question was aborted (for example the turn was interrupted) |
| `invalid`   | The arguments were unusable (no options and free-form disabled) |
| `no-ui`     | No interactive human is attached to this session              |

## Tolerant arguments

The declared `options` parameter is array-based, but models occasionally
serialize arguments loosely. A `prepareArguments` hook runs before schema
validation and repairs the common cases: an options array sent as a JSON
string, a single option object instead of an array, plain-string options, and a
stringified `recommended` index. The schema itself is unchanged.

## Tests

The interaction logic and the registered tool are covered by Node's built-in
test runner (`ask-user.test.ts`, 31 tests). The tests stub the two Pi runtime
packages through a small loader hook so they run without a Pi install:

```bash
node --import ./test/hooks.mjs --test ask-user.test.ts
```

This needs Node 22.6+ for TypeScript type stripping. There is no build step and
no test dependencies.
