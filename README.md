# RomM Desktop

A desktop shell for [RomM](https://github.com/rommapp/romm) that runs your
server's own web interface in a native window and launches games in a locally
installed emulator instead of an in-browser core.

The distinguishing part is what it does not do: it has no interface of its own.
Other desktop clients talk to the RomM API and rebuild the browsing experience,
which means reimplementing collections, search, filtering, metadata and scanning,
then keeping all of it in step with upstream. This loads the frontend your server
is already serving, so each of those is whatever RomM shipped and stays current
when you update the server. The shell adds exactly one thing to that page: a
bridge that hands a game to a real emulator.

> **Early work in progress.** Two known regressions are documented under
> [Known issues](#known-issues), and the launch path has not been tested against
> a real RetroArch install on macOS or Windows.

## How this compares

Native emulator launching is well covered in the RomM ecosystem, and for many
people one of the alternatives is the better fit:

| Option                                                                                              | Emulator runs | Interface                |
| --------------------------------------------------------------------------------------------------- | ------------- | ------------------------ |
| RomM emulator streaming                                                                             | On the server | RomM's own, in a browser |
| [Argosy, Grout, Playnite plugin](https://docs.romm.app/) (first party)                              | Your device   | Their own, per platform  |
| [romm-client](https://github.com/chaun14/romm-client), [RomMix](https://github.com/leclercb/rommix) | Your machine  | Their own                |
| RomM Desktop                                                                                        | Your machine  | RomM's own, at runtime   |

Streaming needs a host powerful enough to run the emulator and gives one session
per container, so it suits a beefy server and any client device, phones and TVs
included. The API clients own their interface, which makes them independent of
RomM's frontend but leaves them reimplementing it. This shell takes the opposite
trade: nothing to reimplement, at the cost of depending on RomM's frontend.

If you want save syncing, offline mode, or a client for a device that is not a
desktop, check those projects first. They are further along.

## How this relates to RomM

This repository contains no RomM code and does not build RomM. It loads your
server's frontend at runtime and injects a single global, `window.rommNative`,
whose shape is defined in `src/shared/types.ts`. RomM's own UI feature-detects
that global.

That has a few consequences worth being explicit about:

- The "Play natively" button ships with the server, not with this shell. A
  server without the integration simply renders in a normal window.
- There is no version lock between the two. The frontend is fetched from your
  server at runtime, so it updates when your server does.
- The shell owns a deliberately small surface: the launch bridge, emulator
  resolution, the ROM cache, and the window's security policy. Everything else
  is RomM's.

## Requirements

- A reachable RomM server, running a version that ships the `useNativeShell`
  integration.
- An emulator. RetroArch is autodetected; anything else is configured by hand
  (see [Emulator configuration](#emulator-configuration)).

## Running it

```bash
npm install
npm run dev
```

On first launch it asks for your server address, then loads it. Log in exactly
as you would in a browser; the shell holds no credentials of its own.

### Changing the server address

The address is saved in `desktop-config.json`, and the setup window normally
appears only when none is set. To correct a mistyped one:

```bash
npm run dev -- --setup
```

That forces the setup window for this launch, then loads whatever you enter.
Quitting without saving leaves the stored address untouched.

## Trying it before the RomM side exists

```bash
npm run dev -- --spike
```

This injects a throwaway panel into the bottom-right corner of the page, so the
idea is testable against an unmodified server that has never heard of
`window.rommNative`.

The panel carries a hardcoded slice of RomM's platform/core map in
`src/main/spike.ts`. A platform outside that short list reports "no core in the
spike map", which is a limit of the harness rather than of the shell. A
standalone emulator configured under `emulators` still launches, because user
mappings need no core.

The spike exists to answer four questions:

- Is the download-then-launch wait tolerable for a large ROM?
- Does core autodetection actually find your RetroArch install?
- Does the handoff from window to emulator feel right?
- Is any of this better than just downloading the ROM yourself?

It is throwaway. Once those are answered, delete `src/main/spike.ts`,
`src/main/spike.test.ts`, and the `installSpike` wiring in
`src/main/window.ts`.

## Known issues

| Issue                  | Cause                                                                                                                                                                                                                      | Fix                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| OIDC / SSO login fails | RomM's login redirects to your identity provider, which is off-origin. `confineToServer` in `src/main/window.ts` blocks the navigation and hands it to the system browser, so the session cookie lands in the wrong place. | Run the auth flow in a child window that permits off-origin navigation and closes once it returns to the server origin. |
| Barcode scanning fails | RomM scans physical-game barcodes with `getUserMedia`. The permission handler in `src/main/window.ts` allows only `fullscreen` and `pointerLock`.                                                                          | Allow `media` for requests originating from the configured server origin.                                               |

Beyond those two, the in-browser emulators (EmulatorJS, Ruffle, js-dos,
PICO-8), file downloads, and clipboard actions are all untested in this shell
and worth exercising.

## Scope

Saves and states are left wherever the local emulator writes them. Syncing them
back to RomM is out of scope for now.

## Emulator configuration

Config lives in `desktop-config.json` in Electron's `userData` directory:

| Platform | Path                                          |
| -------- | --------------------------------------------- |
| Linux    | `~/.config/romm-desktop/`                     |
| macOS    | `~/Library/Application Support/romm-desktop/` |
| Windows  | `%APPDATA%\romm-desktop\`                     |

Edits are picked up while the app is running: the file is re-read whenever it
changes on disk, so a setting takes effect on the next launch attempt without a
restart, and an edit made while the app is open is no longer overwritten by the
next save. The spike panel has an "Edit settings" link that opens the file
directly, so there is no need to go looking for it.

### RetroArch (default)

RetroArch and its cores directory are detected from the usual install
locations. When a game is launched, RomM's own platform/core map decides which
libretro cores are candidates, and the first one actually installed wins.

Detection covers the standard package locations on Linux and macOS, and on
Windows the portable `C:\RetroArch-Win64` layout, both Program Files
directories, the per-user Programs directory, scoop, Steam, and RetroBat's
bundled copy. An install anywhere else, notably on a drive other than C:, needs
`retroarchPath` set by hand. Point it at the executable and the cores directory
is derived from its parent, so `retroarchCoresPath` is usually unnecessary.

### Standalone emulators

`emulators` maps a platform to any executable. `{rom}` is replaced with the
cached ROM path and `{core}` with the resolved libretro core path.
Substitution happens per argv entry, so no shell is involved and paths
containing spaces need no quoting. An entry that uses `{core}` when no core can
be resolved fails with an explanation rather than passing an empty argument to
the emulator, so a wildcard RetroArch row still needs `retroarchCoresPath` to
be findable.

```json
{
  "emulators": [
    {
      "platformSlug": "ps2",
      "label": "PCSX2",
      "command": "/usr/bin/pcsx2",
      "args": ["-batch", "{rom}"]
    },
    {
      "platformSlug": "*",
      "label": "RetroArch (Flatpak)",
      "command": "/usr/bin/flatpak",
      "args": ["run", "org.libretro.RetroArch", "-L", "{core}", "{rom}"]
    }
  ]
}
```

`platformSlug` uses RomM's own slugs (`snes`, `n64`, `ps2`). The `*` row is the
fallback for any platform without an entry of its own.

### Local library

When the server runs on the same machine, downloading a ROM copies a file that
is already on local disk, costing both the wait and a second copy of a
multi-gigabyte game. Point `libraryPath` at the library root as this machine
sees it and the ROM is launched in place instead:

```json
{
  "libraryPath": "E:/library"
}
```

RomM reports each ROM's path relative to its own library root, so only the root
needs configuring. The lookup is skipped, and the download happens as usual,
whenever `libraryPath` is unset, the file is not there, or its size does not
match what the server reports. That last check means a local file that is not
the one the server meant never gets launched in its place.

The server supplies only the path below the root, and anything resolving
outside the configured root is rejected rather than normalised, so this cannot
be used to name an arbitrary file.

Note that emulators write save files and states next to the ROM. Launching in
place puts those in your library rather than in the cache, where RomM may then
scan them. That is the main reason this is opt-in rather than automatic.

### ROM cache

Downloaded ROMs are cached under `cachePath`, which defaults to `rom-cache`
alongside the config file. Once the cache exceeds `cacheLimitBytes` (20 GB by
default), least-recently-used ROMs are evicted.

## Security model

The window loads a remote origin and renders artwork and descriptions pulled
from third-party metadata providers, so the renderer is treated as untrusted:

- `contextIsolation`, `sandbox`, and `nodeIntegration: false` are all enforced.
- In-window navigation is restricted to your server's origin; every other link
  is handed to your real browser. This is also what breaks OIDC login, above.
- The renderer never supplies an executable or arguments. It names a game and
  the libretro cores its platform supports; the command comes only from your
  own config.
- Core names are matched against `[a-z0-9_]+` before becoming a path, so they
  cannot point the loader outside the cores directory.
- Download URLs must resolve to the configured server origin and an `/api/`
  route.
- Processes are spawned with an argument array, never a shell string.
- Self-signed certificates, common on a LAN, prompt once and are then
  remembered by fingerprint.

## Packaging

Not set up. Producing installers needs code signing to be useful (an Apple
Developer ID plus notarization on macOS, a signing certificate on Windows), so
the packaging toolchain lands with that rather than ahead of it. Until then the
shell runs from source with `npm run dev`.

## Layout

```
src/
  main/             Main process
    argv.ts         Command-line flag parsing
    config.ts       Persisted settings and RetroArch autodetection
    emulator/       Platform to emulator/core resolution
    index.ts        App lifecycle, single-instance lock, initial window
    ipc.ts          IPC handlers behind window.rommNative
    launcher.ts     Download, resolve, spawn, track
    rom-cache.ts    Download with the window's session cookies, LRU cache
    safety.ts       Validation of everything the renderer sends
    spike.ts        TEMPORARY: the --spike harness (see above)
    window.ts       Window creation and navigation policy
  preload/          contextBridge surface (window.rommNative)
  shared/           Types shared with the RomM frontend
```

## License

AGPL-3.0-only, matching RomM.
