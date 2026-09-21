# Repository Instructions

RomM Desktop is an Electron shell that launches ROMs from a RomM server in a
native emulator: it downloads the ROM, resolves an emulator and core, spawns it,
and moves saves, savestates, firmware and playtime between the machine and the
server. The RomM web frontend drives it through `window.rommNative`.

TypeScript throughout, Electron, Node 26 (`engines`). No UI framework, no test
framework, no bundler.

## Commands

```bash
npm install
npm run dev          # build, then launch the app
npm run typecheck    # tsc -p tsconfig.check.json
npm test             # node --test over src/**/*.test.ts
npm run build        # tsc -p tsconfig.json
npm run package      # electron-builder
```

CI (`.github/workflows/ci.yml`) installs with `npm ci`, then runs exactly four
checks, in this order: `npm run typecheck`, `npm test`,
`npx eslint src --max-warnings 0`, `npm run build`. Run all four before saying
a change is done. There is nothing else to satisfy: **Prettier is not a
dependency here and not in CI** (`eslint-config-prettier` only disables
ESLint's formatting rules), so match the formatting of the file you are editing
rather than reformatting it.

## Zero runtime dependencies

`package.json` has no `dependencies`, only dev ones. That is deliberate: this
app spawns emulators and handles the user's saves, so its supply chain stays
empty. Write the twenty lines instead of adding a package. `saves/multipart.ts`
exists for this reason, and says so.

## Electron imports break the test runner

`npm test` is Node's own test runner with native TypeScript stripping, no
transpiler. Electron is CommonJS, so a module whose import graph reaches it
cannot be loaded by a test at all, and the failure looks unrelated:

```
SyntaxError: Named export 'BrowserWindow' not found.
```

A type-only `import { type Session } from "electron"` is erased and fine. A
value import anywhere in the graph is not, including transitive ones:
`saves/http.ts` reaches Electron through the auth recovery it imports.

So **keep the decisions in modules that never reach Electron, and the IO in
modules that do**. `saves/plan.ts` sits beside `saves/sync.ts` for exactly this
reason and says so in its header; `safety.ts` opens by declaring itself free of
Electron imports so it can be tested. Follow that split for anything new with
logic worth a test, and put the value import of Electron in the outer module.
Tests are `*.test.ts` colocated with their source.

## Nothing may fail a launch

Everything the shell moves for a launch is best effort: saves, savestates,
firmware, play sessions, and anything added to that list later. A server that
cannot be reached, an expired session, a missing scope, a device the server has
forgotten and a malformed response all end the same way: nothing moves, the log
says what happened, and the game still starts. The only exception is the user's
own cancel, which is re-thrown so it reads as a cancel.

Hold that line in anything new here, and never let an upload hold the window.

## Do not trust an emulator's flags

`-s` and `-S` name RetroArch's save and state files, but they are deprecated
and lose to the user's own `savefile_directory`, `sort_savefiles_*` and
"save files in content directory" settings. A launch that trusts them reads the
file the shell put in place and writes its save somewhere else entirely, and
the only symptom is every push afterwards reporting the save as unchanged. That
one cost a full debugging session.

The lever that does outrank the user's config is the per-launch config the
shell layers on with `--appendconfig` (`saves/retroarch.ts`,
`appendConfigArgs` in `emulator/resolve.ts`). So when a flag and a setting can
disagree, pin the setting there and treat the flag as a hint. And the emulator,
not the shell, still chooses the filename: never assume a name, find the file.

## Everything from the renderer is untrusted

The RomM frontend is a web page, so everything arriving over IPC is attacker
input. Validation happens in two places, and knowing which is which is how you
avoid adding a check to the wrong layer:

- `validateLaunchRequest` in `src/main/safety.ts` checks the request's
  **shape** on the way in: types, integers, non-empty strings. It does not
  sanitize a slug or a core name, and it is not where to put a rule about what
  one may contain.
- The **point of use** applies the gate, with the helper that fits it.
  `firmware/paths.ts` runs the platform slug through `safeFileName` where it
  becomes a directory; `emulator/buildbot.ts` refuses a core name that fails
  `isSafeCoreName` (an alphabet in `emulator/resolve.ts`, rejected rather than
  escaped) before it becomes a path; `isWithin`, `resolveDownloadUrl` and
  `assertSeparateRoots` guard the paths and URLs they are handed.

So a new value from the renderer needs a type check in `validateLaunchRequest`
**and** a gate wherever it turns into a path, a URL or an argument. See the
README's "Security model" section, and keep `safety.ts` free of Electron
imports so it stays testable.

## `src/shared/` is a contract with the RomM frontend

Those types are shared with the web app, which reads `LaunchState`, sends
`LaunchRequest`, and checks `ShellCapability` (exposed as
`RommNativeBridge.capabilities`) to decide what to offer for a given build.
Adding an **optional or defaulted** field is safe, and so is adding a
capability. A new _required_ field on `LaunchRequest` is not: an older
frontend will not send it, and `validateLaunchRequest` rejects the launch
outright. Changing or removing a field is a cross-repo change either way, and
a capability the frontend keys off is not renamed casually.

## Conventions

- **Branch off `main` and open PRs against `main`.** Don't push to `main`.
- **Module headers carry the "why".** A file here opens with a comment
  explaining the problem it solves and the reasoning that shaped it, and the
  tricky lines carry short notes. Match that; it is the house style and it is
  why the save path is followable at all. Keep the reasoning for a _change_ in
  the commit message and the PR, not the code.
- **English only**, in code, comments, docs and commit messages.
- **No em-dashes** in anything written. Commas, parentheses, or two sentences.
- **Tests travel with code.** New logic gets a test, which in practice means
  putting that logic where a test can import it (see above).
- **Disclose AI assistance in the PR**, and what it covered.
- **Never commit secrets.**
