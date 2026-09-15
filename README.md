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

> **Early work in progress.** The launch path has not been tested against a
> real RetroArch install on macOS or Windows, and the surfaces listed under
> [Untested](#untested) have not been exercised at all.

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
- An emulator. RetroArch is autodetected, the shell offers to fetch its
  installer if you have none, and its missing cores are downloaded on demand;
  anything else is configured by hand (see
  [Emulator configuration](#emulator-configuration)).

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

## Signing in

A username and password work in the window as they do in a browser. OIDC and
SSO take a detour, because the identity provider is off-origin by definition
and the window the app runs in is confined to your server: RomM's login opens
`/api/login/openid`, which redirects to your provider, and the provider
eventually redirects back.

That flow is given a window of its own, which permits the excursion and shares
the session with the main window, so the cookie your provider establishes is
the one the app then holds. It closes as soon as the flow lands back on your
server, and a provider that still has a session of its own answers so quickly
that it never appears at all.

Logging out is the one part still handed to your browser. RomM clears its own
session before returning your provider's end-session URL, so you are signed out
of RomM either way; whether your provider's own session ends depends on the
browser that URL opens in. An off-origin address arriving from a page is
indistinguishable from any other external link, and treating a class of them as
auth would widen exactly the boundary the auth window exists to keep narrow.

## Untested

The in-browser emulators (EmulatorJS, Ruffle, js-dos, PICO-8), file downloads,
and clipboard actions are all untested in this shell and worth exercising.

## Using a controller

RomM's own interface handles controller navigation, so the shell does not add
any. Recent versions fold that into the main UI, and
`/settings/controller-debug` shows whether the input system can see your pad.

Two things are worth knowing:

The Gamepad API is restricted to secure contexts. A server reached over
`https://` or at `http://localhost` works; one reached at a plain
`http://192.168.x.x` does not, and fails silently rather than reporting
anything. That is a browser rule, not a shell one.

Quitting the emulator brings the window back to the front, so a session that
started with a controller does not need a mouse to continue.

## Scope

Each game gets its own directory for saves and states, rather than leaving them
wherever the emulator happened to write them (see [Save data](#save-data)).
Syncing them back to RomM is still out of scope.

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

#### No emulator at all

On a machine with nothing installed and nothing configured, the shell offers
once, on startup, to fetch RetroArch's official installer and open it. Answer
"Don't ask again" and it never asks again; install an emulator by any means and
the offer stops on its own.

It does not install anything, and this is deliberate. The buildbot publishes
RetroArch only as a `.7z` and a macOS `.dmg`, so unpacking one would mean either
a runtime dependency for LZMA or a bundled extractor, and on macOS stripping a
quarantine flag off a binary the shell then runs. Instead the installer is
handed to the operating system: Windows runs it with the usual UAC and
SmartScreen prompts, macOS mounts the image and you drag it across. You consent
through the flow you already recognise, and RetroArch keeps ownership of its own
updates.

Linux is offered nothing to download. The only build published there is a 179 MB
portable `.7z`, while your distribution's package is smaller and is the copy that
will actually receive updates, so the prompt points at the download page
instead.

Once the install finishes there is nothing to restart. Detection normally runs
only when the config file changes, which would have made the answer to "I just
installed it" be "now quit and reopen"; while no emulator has been found the
usual locations are re-probed on each launch attempt instead, so the next press
of Play picks it up. An install placed somewhere unusual is still not guessed at,
and needs `retroarchPath` set by hand.

A RetroArch that has never been run has no cores directory yet, so the shell
falls back to where that directory belongs on your platform and creates it when
it writes the first core. [Missing cores](#missing-cores) therefore work straight
after the install, without opening RetroArch first. That fallback applies only to
an install the shell detected; a hand-configured emulator, a Flatpak RetroArch
included, still needs `retroarchCoresPath`.

The installer is kept in `installers` beside the config, and deleted once an
emulator has been found. Set `offerRetroArchInstall` to `false` to suppress the
prompt outright:

```json
{
  "offerRetroArchInstall": false
}
```

#### Choosing a core

RomM's map names the cores that will play a game, in its own order, and the
first one installed wins. It has no opinion about which of them
[RetroAchievements recognises](https://docs.retroachievements.org/general/emulator-support-and-issues.html),
and no way to know that you prefer one. `preferredCores` puts your choice at the
front, for resolving and for downloading alike:

```json
{
  "preferredCores": {
    "psx": ["mednafen_psx_hw", "swanstation"],
    "saturn": ["mednafen_saturn"],
    "3ds": ["azahar"]
  }
}
```

A core named here is honoured even when the frontend never offered it, which is
the point: it is how you reach a core RomM's map does not list. Nothing is
narrowed away either -- whatever the frontend did offer still follows, in its
original order, so a preference that turns out not to be published for your
system quietly falls through to RomM's suggestion.

A preference you do not have is downloaded even when something else that plays
the game is already installed. That is the case the setting exists for: you name
`mednafen_psx_hw` because RetroAchievements does not recognise `pcsx_rearmed`,
and having `pcsx_rearmed` is exactly why you had to. The download is never
allowed to cost you a launch that would have worked, though -- if the preferred
core cannot be fetched for your system, the game starts on the core you already
have.

Two worked reasons to set it. `pcsx_rearmed` plays PlayStation games perfectly
well but is not on RetroAchievements' supported list, while `mednafen_psx_hw`
and `swanstation` are; and RetroAchievements wants Beetle Saturn
(`mednafen_saturn`) rather than the Kronos core some frontends default to, which
is also not published for Apple Silicon.

Names are checked against the same `[a-z0-9_]+` alphabet as everything else
before they become a path or a request, so nothing here can reach outside the
cores directory. That check cannot see a plain typo, though: `mednafen_psx_h`
is a perfectly legal name for a core that does not exist, so it finds nothing,
fails to download, and the launch falls through to what RomM suggested. Achievements themselves are RetroArch's business: log in under its own
Settings, and RomM will show the progression once it syncs.

#### Missing cores

A core that is not installed is fetched from the
[libretro buildbot](https://buildbot.libretro.com/) rather than failing the
launch, which is the same build RetroArch's own core updater installs. The
candidates are tried in the frontend's order of preference and the first one
published for this machine wins, so the usual case is a few seconds' wait
before the game starts.

This is deliberately narrow. Nothing is downloaded unless RetroArch itself is
already installed, the emulator for that platform actually loads a libretro
core, the cores directory is known, none of the candidates are present, and the
buildbot publishes for this architecture. A standalone emulator never triggers
it. Set `autoInstallCores` to `false` to turn it off and go back to a launch
that fails with the missing cores named:

```json
{
  "autoInstallCores": false
}
```

Two things worth knowing. The core has to match the emulator's architecture
rather than this shell's, so an x86_64 RetroArch under Rosetta on an Apple
Silicon Mac will be handed arm64 cores it cannot load; install those through
RetroArch's own updater. And only the nightly channel exists per core, so this
tracks upstream rather than pinning a version.

Detection covers the standard package locations on Linux and macOS, and on
Windows the portable `C:\RetroArch-Win64` layout, both Program Files
directories, the per-user Programs directory, scoop, Steam, and RetroBat's
bundled copy. An install anywhere else, notably on a drive other than C:, needs
`retroarchPath` set by hand. Point it at the executable and the cores directory
is derived from its parent, so `retroarchCoresPath` is usually unnecessary.

### Detected standalone emulators

RetroAchievements recognises the standalone PCSX2 and Dolphin but not their
libretro cores, so for PS2 and GameCube/Wii there is no core that will ever
unlock an achievement. Both have always been configurable under `emulators`;
what nobody can reasonably guess is the executable name and argument template,
which is the part people get stuck on -- RetroBat alone ships `pcsx2`,
`pcsx2-16` and `pcsx2x6`, and the binary inside the first is `pcsx2-qt.exe`.

So the shell looks for them where they land, the same way it already looks for
RetroArch, and launches what it finds:

| Emulator | Platforms    | Looked for in                                                                    |
| -------- | ------------ | -------------------------------------------------------------------------------- |
| PCSX2    | `ps2`        | `/Applications`, Program Files, the per-user Programs directory, scoop, RetroBat |
| Dolphin  | `ngc`, `wii` | the same, plus `/usr/bin` and `/usr/games` and each one's Flatpak on Linux       |

Nothing is written to your config, and an emulator installed by any means is
found the same way, a frontend's own tree included, so someone already running
RetroBat in `C:\RetroBat` gets its emulators without configuring them twice.
Only that path, though: a portable RetroBat on another drive is not somewhere
this can guess at, so point at it with `emulatorsBasePath` and an `emulators`
row, as below.

When there is nothing to find, the platform is still reported as launchable --
naming the emulator it would set up rather than the one it has -- and pressing
Play offers to fetch it from the project. Reporting the plain truth there would
hide the button, and the button is the only thing that raises the offer. The
file is handed to the operating system exactly as RetroArch's installer is -- an
installer runs, a disk image mounts, a Flatpak goes to your software installer
-- and the version comes from each project's own release index rather than a URL
guessed here.

The launch then waits rather than ending. You install the emulator the way its
project intends -- run the installer, drag it to Applications, confirm the
Flatpak -- and the game starts on its own once it appears, so there is no error
to dismiss and nothing to press twice. Cancelling the download stops the wait,
and so does closing the window.

Coverage is uneven, and not in a way this shell can fix:

| Emulator | macOS                            | Windows                        | Linux   |
| -------- | -------------------------------- | ------------------------------ | ------- |
| PCSX2    | `.tar.xz`, opens Archive Utility | installer                      | Flatpak |
| Dolphin  | disk image                       | `.7z`, opens in Explorer on 11 | Flatpak |

Dolphin publishes no Windows installer and PCSX2 no macOS disk image, so those
two leave a portable build wherever you extract it. Detection cannot guess where
that is, so the prompt says as much, the launch does not wait for something it
will never see, and you point at the executable under `emulators` afterwards.
A machine neither project builds for -- 32-bit Windows either way, ARM Linux for
PCSX2 -- is sent to the download page rather than handed a binary it cannot run. Asked at most once per emulator per run; declining just
lets the launch carry on as it would have. Set `offerStandaloneInstall` to
`false` to never ask.

A row you wrote yourself always wins, so configuring either of these overrides
the detection entirely. A detected emulator does beat a `*` wildcard row,
though: a catch-all should not claim a platform that has a real emulator
installed for it. Set `useDetectedEmulators` to `false` to switch the whole
thing off:

```json
{
  "useDetectedEmulators": false
}
```

That takes the download offer with it: with detection off, an emulator in its
usual place is one this shell will not use, and fetching a second copy would not
change that. Write an `emulators` row instead.

Two things RetroAchievements asks of Dolphin that the shell cannot do for you:
it wants version 2407-68 or newer for GameCube (2603a for Wii), and "Enable Dual
Core (speedup)" switched off. Both live in Dolphin's own settings.

### Standalone emulators

`emulators` maps a platform to any executable. `{rom}` is replaced with the
cached ROM path and `{core}` with the resolved libretro core path;
[Save data](#save-data) adds four more tokens for saves and states.
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

#### Emulator base path

A frontend like RetroBat keeps every emulator under one tree. Set
`emulatorsBasePath` and a `command` can be relative to it, so entries stop
repeating the same prefix and moving the install becomes a one-line change:

```json
{
  "emulatorsBasePath": "E:/RetroBat/emulators",
  "emulators": [
    {
      "platformSlug": "ps2",
      "label": "PCSX2",
      "command": "pcsx2/pcsx2-qt.exe",
      "args": ["-batch", "-fullscreen", "{rom}"]
    }
  ]
}
```

An absolute `command` is always used as given, so emulators installed outside
that tree still work and existing configs are unaffected.

The executable name is not guessable from the directory name, and one platform
often has several candidates installed, so the shell does not try to infer
either. RetroBat alone ships `pcsx2`, `pcsx2-16` and `pcsx2x6`, and the binary
inside `pcsx2` is `pcsx2-qt.exe` next to an `updater.exe`. List a directory to
see what is actually there:

```powershell
Get-ChildItem E:\RetroBat\emulators\<name> -Filter *.exe
```

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

Save data is unaffected by this: it goes to its own directory either way, so
launching in place does not leave saves in your library for RomM to scan. See
[Save data](#save-data).

### Save data

Left to itself an emulator writes save data next to the ROM, and neither place
that lands is somewhere it should stay. A game played from the cache keeps its
save in `rom-cache`, where the eviction in [ROM cache](#rom-cache) eventually
deletes it along with the ROM it sits beside. A game launched in place under
`libraryPath` leaves its save in your library, where RomM may then scan it.

So the shell hands each game a directory of its own, under `save-data` beside
the config file:

```
<saveDataPath>/<romId>/saves/<name>.srm
<saveDataPath>/<romId>/states/<name>.state
```

`saveDataPath` has to sit outside `cachePath`, and the shell refuses a launch
when either contains the other: eviction removes a cached ROM's directory
whole, and save data underneath it would go with it.

The directory is keyed on the ROM id and the filename comes from the server, so
a cached launch and an in-place launch land on one file. RetroArch is passed
`-s` and `-S`, which override whatever `savefile_directory` your `retroarch.cfg`
sets. Point `saveDataPath` somewhere else to move the whole tree, a synced
folder say:

```json
{
  "saveDataPath": "/home/you/romm-saves"
}
```

A configured emulator has to be told, since the shell only passes the arguments
a mapping asks for. `{saves}` and `{states}` expand to the two directories, and
`{savefile}` and `{statefile}` to the files inside them, for an emulator that
wants a path rather than a directory:

```json
{
  "emulators": [
    {
      "platformSlug": "*",
      "label": "RetroArch (Flatpak)",
      "command": "/usr/bin/flatpak",
      "args": [
        "run",
        "org.libretro.RetroArch",
        "-L",
        "{core}",
        "-s",
        "{savefile}",
        "-S",
        "{statefile}",
        "{rom}"
      ]
    }
  ]
}
```

Which of the four an emulator wants, and whether it takes them on the command
line at all, varies: several only read a save directory from their own config
file. There the shell cannot place the save for you, and the entry is better
left without the tokens.

Prefer the file tokens where an emulator accepts one. Given only a directory,
an emulator names the save after the ROM, and the cached copy carries a name
the shell has made portable: Windows device names, trailing dots, and
characters that are legal on Linux but not Windows are all rewritten. A ROM
whose name needed rewriting therefore still derives two save names, one per
launch path. `{savefile}`, `{statefile}` and RetroArch's own `-s` and `-S` name
the file outright and are unaffected.

Should `saveDataPath` ever be empty, a mapping naming one of these tokens fails
with an explanation rather than handing the emulator a blank argument, the same
way `{core}` does.

### Fullscreen

Set `fullscreen` to open the main window with no title bar, for a TV or
cabinet:

```json
{
  "fullscreen": true
}
```

The setup window stays windowed regardless, since it is the one screen that
needs a keyboard. F11 toggles fullscreen at runtime on Windows and Linux, and
Control Command F on macOS.

### ROM cache

Downloaded ROMs are cached under `cachePath`, which defaults to `rom-cache`
alongside the config file, one directory per ROM:

```
<cachePath>/<romId>/<name>
```

The directory carries the ROM id, so the file itself keeps the name the server
gave it and an emulator deriving anything from the content name agrees with a
launch straight out of the library. Once the cache exceeds `cacheLimitBytes`
(20 GB by default), least-recently-used ROMs are evicted a whole directory at a
time.

## Security model

The window loads a remote origin and renders artwork and descriptions pulled
from third-party metadata providers, so the renderer is treated as untrusted:

- `contextIsolation`, `sandbox`, and `nodeIntegration: false` are all enforced.
- In-window navigation is restricted to your server's origin -- including
  redirects, so a response cannot walk the window off-origin where a link
  cannot -- and every other link is handed to your real browser. The one
  address that leaves is the OIDC endpoint, which opens the separate auth
  window described under [Signing in](#signing-in); that window carries no
  preload, so `window.rommNative` is reachable only from your server's own
  page.
- The camera is granted only to your server's own origin, only to the top-level
  frame, and only for video, so RomM's barcode scanner works while an embedded
  piece of third-party metadata cannot reach it. Every other permission is
  refused.
- The renderer never supplies an executable or arguments. It names a game and
  the libretro cores its platform supports; the command comes only from your
  own config.
- Core names are matched against `[a-z0-9_]+` before becoming a path, so they
  cannot point the loader outside the cores directory. The same check gates the
  buildbot URL, so a name that cannot be a filename cannot be a request either.
- A downloaded core is written only to the configured cores directory, under the
  filename the shell derived. The archive is never walked and no path inside it
  is read, so an entry named to escape a directory has nothing to act on, and
  the contents are checked against the archive's own checksum before the
  emulator is asked to load them.
- The RetroArch installer is downloaded only after you say yes, only from the
  buildbot origin, and only to a fixed directory. The shell never runs it: it is
  handed to the operating system, so Gatekeeper and SmartScreen see it the same
  way they would a download from a browser. A transfer that stops short of the
  length the server declared is deleted rather than opened.
- Download URLs must resolve to the configured server origin and an `/api/`
  route.
- Processes are spawned with an argument array, never a shell string.
- Self-signed certificates, common on a LAN, prompt once and are then
  remembered by fingerprint.

## Packaging

```bash
npm run package            # for this machine
npm run package -- --linux # or --win, --mac
```

Output lands in `release/`. Tagging `v*` runs the same build on all three
platforms and opens a draft GitHub release; a manual workflow run builds the
artifacts without releasing them, for checking packaging changes.

| Platform | Format   | Unsigned experience                                   |
| -------- | -------- | ----------------------------------------------------- |
| Linux    | AppImage | Normal, nothing is signed on Linux anyway             |
| Windows  | zip      | SmartScreen warns until the binary earns reputation   |
| macOS    | zip      | Gatekeeper blocks; approve under Privacy and Security |

Nothing is signed yet. `electron-builder.yml` carries the signing and
notarization options as commented configuration, so enabling them is a
credentials change rather than a code change.

One known gap: auto-update is not wired up. That matters more here than for
most apps, because the shell renders remote content in Chromium and so carries
a standing obligation to track Electron releases. macOS auto-update cannot work
without a Developer ID, so signing and updates land together.

`build/icon.png` is RomM's own mark, rendered at 1024 from the project's
`favicon.svg`. It is circular with transparent corners rather than full bleed,
because macOS applies no mask of its own and a hard-edged square reads as
unfinished in the dock.

Linux ships an AppImage rather than a Flatpak deliberately. A Flatpak cannot
casually launch the emulators installed on the host, which is the one thing
this shell exists to do.

## Layout

```
src/
  main/             Main process
    argv.ts         Command-line flag parsing
    config.ts       Persisted settings and RetroArch autodetection
    emulator/       Platform to emulator/core resolution
      bootstrap.ts  First-run offer to fetch RetroArch's own installer
      buildbot.ts   Where a missing libretro core comes from
      install.ts    Fetching and unpacking one
      locations.ts  Where RetroArch and its cores live, per platform
      resolve.ts    Choosing the emulator and core for a platform
      standalone.ts Finding an installed PCSX2 or Dolphin
      standalone-install.ts  Offering to fetch one that is missing
      standalone-release.ts  Reading each project's release index
      retroarch.ts  Which RetroArch installer suits this machine
    index.ts        App lifecycle, single-instance lock, initial window
    ipc.ts          IPC handlers behind window.rommNative
    launcher.ts     Download, resolve, spawn, track
    cache/          LRU eviction over the ROM cache
    rom-cache.ts    Download with the window's session cookies
    saves/          Per-game save and state directories
    download.ts     Fetching a file the OS is then asked to open
    safety.ts       Validation of everything the renderer sends
    spike.ts        TEMPORARY: the --spike harness (see above)
    window.ts       Window creation and navigation policy
    zip.ts          Minimal reader for the buildbot's core archives
  preload/          contextBridge surface (window.rommNative)
  shared/           Types shared with the RomM frontend
```

## License

AGPL-3.0-only, matching RomM.
