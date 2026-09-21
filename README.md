# RomM Desktop

A desktop shell for [RomM](https://github.com/rommapp/romm) that runs your
server's own web interface in a native window and launches games in a locally
installed emulator instead of an in-browser core.

It has no interface of its own. Other desktop clients talk to the RomM API and
rebuild the browsing experience; this loads the frontend your server already
serves and adds one thing to it: a bridge that hands a game to a real emulator.

> **Early work in progress.** The launch path has not been tested against a
> real RetroArch install on macOS or Windows, and the surfaces listed under
> [Untested](#untested) have not been exercised at all.

## How this compares

| Option                                                                                              | Emulator runs | Interface                |
| --------------------------------------------------------------------------------------------------- | ------------- | ------------------------ |
| RomM emulator streaming                                                                             | On the server | RomM's own, in a browser |
| [Argosy, Grout, Playnite plugin](https://docs.romm.app/) (first party)                              | Your device   | Their own, per platform  |
| [romm-client](https://github.com/chaun14/romm-client), [RomMix](https://github.com/leclercb/rommix) | Your machine  | Their own                |
| RomM Desktop                                                                                        | Your machine  | RomM's own, at runtime   |

The API clients own their interface, which makes them independent of RomM's
frontend but leaves them reimplementing it. This takes the opposite trade. For
save syncing, offline mode, or a non-desktop device, check those projects first.

## How this relates to RomM

This repository contains no RomM code. It loads your server's frontend at
runtime and injects one global, `window.rommNative`, whose shape is defined in
`src/shared/types.ts`; RomM's own UI feature-detects it. So the "Play natively"
button ships with the server, a server without the integration renders in a
normal window, and there is no version lock between the two.

## Requirements

- A reachable RomM server running a version whose frontend ships the native
  play route. A server without it still loads, just with no way to reach the
  bridge.
- An emulator. RetroArch is autodetected, the shell offers to fetch its
  installer if you have none, and missing cores are downloaded on demand;
  anything else is configured by hand.

## Running it

```bash
npm install
npm run dev
```

On first launch it asks for your server address, then loads it. Log in exactly
as you would in a browser; the shell holds no credentials of its own.

| Flag      | Effect                                                           |
| --------- | ---------------------------------------------------------------- |
| `--setup` | Reopen the server-address window to correct a mistyped address   |
| `--spike` | Inject a test panel, for a server without the RomM-side integration |

`--spike` is throwaway scaffolding carrying a hardcoded slice of RomM's
platform/core map. Delete `src/main/spike.ts`, `src/main/spike.test.ts` and the
`installSpike` wiring in `src/main/window.ts` once the launch path has been
judged on real hardware.

## Signing in

A username and password work as they do in a browser. OIDC and SSO get a window
of their own, since the identity provider is off-origin while the main window is
confined to your server; it shares the session and closes once the flow lands
back on your server.

Logging out is handed to your browser. RomM clears its own session before
returning your provider's end-session URL, so you are signed out of RomM either
way; whether your provider's session ends depends on the browser that URL opens
in.

## Using a controller

RomM's own interface handles controller navigation, so the shell adds none.
`/settings/controller-debug` shows whether the input system can see your pad.

The Gamepad API is restricted to secure contexts, a browser rule rather than a
shell one: `https://` or `http://localhost` works, a plain `http://192.168.x.x`
fails silently. Quitting the emulator brings the window back to the front.

## Untested

The in-browser emulators (EmulatorJS, Ruffle, js-dos, PICO-8), file downloads
and clipboard actions are untested in this shell and worth exercising.

[Multi-disc games](#multi-disc-games) have unit tests over disc selection, the
playlist, and which emulators are handed one, but no real disc set has been
launched through an emulator yet.

## Configuration

Config lives in `desktop-config.json` in Electron's `userData` directory:

| Platform | Path                                          |
| -------- | --------------------------------------------- |
| Linux    | `~/.config/romm-desktop/`                     |
| macOS    | `~/Library/Application Support/romm-desktop/` |
| Windows  | `%APPDATA%\romm-desktop\`                     |

It is re-read whenever it changes on disk, so an edit takes effect on the next
launch attempt without a restart.

| Key                      | Default            | What it does                                                            |
| ------------------------ | ------------------ | ----------------------------------------------------------------------- |
| `retroarchPath`          | autodetected       | RetroArch executable, for an install somewhere unusual                  |
| `retroarchCoresPath`     | derived from above | Cores directory                                                         |
| `preferredCores`         | none               | [Your core order per platform](#choosing-a-core)                        |
| `autoInstallCores`       | `true`             | [Fetch a missing core](#missing-cores) from the libretro buildbot       |
| `offerRetroArchInstall`  | `true`             | Offer RetroArch's installer when nothing is installed                   |
| `useDetectedEmulators`   | `true`             | Use [detected](#detected-standalone-emulators) PCSX2, Dolphin, RPCS3, Cemu |
| `offerStandaloneInstall` | `true`             | Offer to fetch those when they are missing                              |
| `emulators`              | none               | [Your own platform-to-command rows](#your-own-emulator-rows)            |
| `emulatorsBasePath`      | none               | Prefix for relative `command` values                                    |
| `libraryPath`            | none               | [Library root](#local-library), to launch in place instead of downloading |
| `cachePath`              | `rom-cache`        | [ROM cache](#rom-cache) directory                                       |
| `cacheLimitBytes`        | 20 GB              | Cache size before LRU eviction                                          |
| `saveDataPath`           | `save-data`        | [Save and state](#save-data) directories                                |
| `syncSaves`              | `true`             | [Move saves to and from RomM](#saves-synced-with-romm) around a launch  |
| `deviceId`               | set by the shell   | This machine's row in RomM's device list                                |
| `useRommFirmware`        | `true`             | [Mirror RomM's firmware library](#firmware-from-romm)                   |
| `biosPath`               | `bios`             | Where that mirror lives                                                 |
| `fullscreen`             | `false`            | Open the main window with no title bar, for a TV or cabinet             |

The three unset paths default to directories beside the config file.
`cachePath`, `saveDataPath` and `biosPath` must not contain one another -- the
shell refuses a launch when any two overlap, since eviction and the firmware
mirror each delete whole directories.

With `fullscreen` on, the setup window stays windowed regardless. F11 toggles
fullscreen at runtime on Windows and Linux, Control Command F on macOS.

### RetroArch

RetroArch and its cores directory are detected from the usual install locations:
standard packages on Linux and macOS, and on Windows the portable
`C:\RetroArch-Win64` layout, both Program Files directories, the per-user
Programs directory, scoop, Steam, and RetroBat's bundled copy. Anywhere else --
notably a drive other than C: -- needs `retroarchPath`, pointed at the
executable; the cores directory is derived from its parent.

With nothing installed and nothing configured, the shell offers once on startup
to fetch RetroArch's installer and open it, keeping it in `installers` beside
the config; it never installs anything itself, and Linux is pointed at the
download page instead.

Locations are re-probed on every launch attempt, so nothing needs restarting. A
RetroArch that has never been run has no cores directory, so the shell falls
back to where that directory belongs on your platform -- for a detected install
only; a hand-configured one, Flatpak included, still needs `retroarchCoresPath`.

#### Choosing a core

RomM's map names the cores that will play a game, in its own order, and the
first one installed wins. It has no opinion about which of them
[RetroAchievements recognises](https://docs.retroachievements.org/general/emulator-support-and-issues.html).
`preferredCores` puts your choice at the front, for resolving and downloading
alike:

```json
{
  "preferredCores": {
    "psx": ["mednafen_psx_hw", "swanstation"],
    "saturn": ["mednafen_saturn"],
    "3ds": ["azahar"]
  }
}
```

A core named here is honoured even when the frontend never offered it, and
nothing is narrowed away. One that cannot be resolved falls through to RomM's
suggestion rather than costing you a launch. Achievements themselves are
RetroArch's business -- log in under its own Settings.

#### Missing cores

A core that is not installed is fetched from the
[libretro buildbot](https://buildbot.libretro.com/) rather than failing the
launch -- the same build RetroArch's own core updater installs. Candidates are
tried in the frontend's order and the first one published for this machine wins.

Nothing is downloaded unless RetroArch is installed, the platform's emulator
loads a libretro core, the cores directory is known, no candidate is present,
and the buildbot publishes for this architecture. Set `autoInstallCores` to
`false` to fail the launch with the missing cores named instead.

The core must match the emulator's architecture rather than this shell's, so an
x86_64 RetroArch under Rosetta on Apple Silicon is handed arm64 cores it cannot
load; install those through RetroArch's own updater.

### Detected standalone emulators

Some platforms need an emulator that is not a libretro core: RetroAchievements
recognises the standalone PCSX2 and Dolphin but not their cores, and libretro
has no core for PS3 or Wii U at all. All four are configurable under
`emulators`, but their executable names and arguments are not guessable, so the
shell looks for them where they land:

| Emulator | Platforms    | Looked for in                                                                    |
| -------- | ------------ | -------------------------------------------------------------------------------- |
| PCSX2    | `ps2`        | `/Applications`, Program Files, the per-user Programs directory, scoop, RetroBat |
| Dolphin  | `ngc`, `wii` | the same, plus `/usr/bin` and `/usr/games` and its Flatpak on Linux              |
| RPCS3    | `ps3`        | the same, plus `/usr/bin` and `/usr/local/bin` and its Flatpak on Linux          |
| Cemu     | `wiiu`       | the same, plus `%LOCALAPPDATA%\Cemu`, which is where its own installer puts it   |

Nothing is written to your config, so RetroBat in `C:\RetroBat` needs no
configuring; a portable RetroBat on another drive needs `emulatorsBasePath` and
an `emulators` row.

A row you wrote yourself always wins, but a detected emulator beats a `*`
wildcard row. `useDetectedEmulators: false` switches the whole thing off, and
takes the download offer with it.

#### Offering to fetch one

When there is nothing to find, the platform is still reported as launchable and
pressing Play offers to fetch the emulator from the project's own release index.
The file is handed to the operating system, and the launch waits: install it the
way its project intends and the game starts on its own. Asked at most once per
emulator per run; `offerStandaloneInstall: false` never asks.

| Emulator | macOS                            | Windows                        | Linux    |
| -------- | -------------------------------- | ------------------------------ | -------- |
| PCSX2    | `.tar.xz`, opens Archive Utility | installer                      | Flatpak  |
| Dolphin  | disk image                       | `.7z`, opens in Explorer on 11 | Flatpak  |
| RPCS3    | `.7z`, one per architecture      | `.7z`                          | AppImage |
| Cemu     | disk image                       | installer                      | AppImage |

A macOS `.app` goes to Applications, where detection looks first, so those wait
like anything else. A Windows or Linux archive leaves a portable build wherever
you extract it, so the launch does not wait and you point at the executable
under `emulators` afterwards. An AppImage is made executable and shown in your
file manager rather than run. A machine a project does not build for is sent to
the download page.

Two things the shell cannot do for you. RetroAchievements wants Dolphin 2407-68
or newer for GameCube (2603a for Wii) with "Enable Dual Core (speedup)" off. And
RPCS3 boots a single file, so a PS3 title RomM keeps as a folder downloads as an
archive it cannot boot.

### Your own emulator rows

`emulators` maps a platform to any executable. `platformSlug` uses RomM's own
slugs (`snes`, `n64`, `ps2`); `*` is the fallback for any platform without an
entry of its own.

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

Tokens are substituted per argv entry, so no shell is involved and paths
containing spaces need no quoting:

| Token          | Expands to                                                           |
| -------------- | --------------------------------------------------------------------- |
| `{rom}`        | The cached, or in-place, ROM path                                    |
| `{core}`       | The resolved libretro core path                                      |
| `{saves}`      | This game's [save directory](#save-data)                             |
| `{states}`     | This game's save-state directory                                     |
| `{savefile}`   | The save file inside `{saves}`                                       |
| `{statefile}`  | The state file inside `{states}`                                     |
| `{bios}`       | This platform's [firmware directory](#firmware-from-romm)            |
| `{biosconfig}` | A generated RetroArch config naming `system_directory`               |

A token that cannot be resolved fails the launch with an explanation rather than
passing an empty argument. An optional `playlist` key says whether the emulator
boots an `.m3u`, which only affects [multi-disc games](#multi-disc-games).

Set `emulatorsBasePath` and a `command` can be relative to it, for a frontend
like RetroBat that keeps every emulator under one tree; an absolute `command` is
always used as given. The executable name is not guessable from the directory
name -- `pcsx2` holds `pcsx2-qt.exe` next to an `updater.exe` -- so list it:
`Get-ChildItem E:\RetroBat\emulators\<name> -Filter *.exe`.

```json
{
  "emulatorsBasePath": "E:/RetroBat/emulators",
  "emulators": [
    {
      "platformSlug": "ps2",
      "command": "pcsx2/pcsx2-qt.exe",
      "args": ["-batch", "-fullscreen", "{rom}"]
    }
  ]
}
```

### Local library

When the server runs on the same machine, downloading a ROM copies a file that
is already on local disk. Point `libraryPath` at the library root as this
machine sees it and the ROM is launched in place instead:

```json
{
  "libraryPath": "E:/library"
}
```

RomM reports each ROM's path relative to its own library root, so only the root
needs configuring. The download happens as usual whenever `libraryPath` is
unset, the file is not there, or its size does not match what the server
reports. [Save data](#save-data) goes to its own directory either way.

### Multi-disc games

A game split across discs is one ROM with several files on the server, and
asking for it as a single download returns an archive a multi-disc game cannot
boot out of. So a ROM the server reports as two or more disc images is fetched
as those individual files instead.

Discs are ordered by the number in their name (`Disc 2`, `disk 2`, `CD2`). A
sheet's tracks (`.cue`, `.gdi`, `.ccd`, `.mds`) are not discs but are fetched
beside it; a whole-disc image is never a track whatever it is named, so a `.chd`
beside a `.gdi` is its own disc while a bare `.bin` beside a `.cue` is a track.
A set shipping its own `.m3u` is handed that.

What the emulator is handed depends on whether it reads an `.m3u`:

|                                 | Handed         | Changing disc                                                   |
| ------------------------------- | -------------- | --------------------------------------------------------------- |
| RetroArch, Dolphin, DuckStation | `discs.m3u`    | the emulator's disc-control menu                                |
| PCSX2, RPCS3, Cemu              | the first disc | the emulator's own "change disc", with the set in one directory |

In PCSX2, disc 2 is System > Change Disc from the menu bar, or Change Disc in
the quick menu on a controller. The playlist is UTF-8 with LF endings, which is
all Dolphin accepts.

A hand-configured emulator is assumed not to read a playlist unless its
arguments name `{core}`, or RetroArch, Dolphin or DuckStation appears in the
command. `"playlist"` outranks that:

```json
{
  "emulators": [
    {
      "platformSlug": "psx",
      "command": "/usr/bin/mednafen",
      "args": ["{rom}"],
      "playlist": true
    }
  ]
}
```

A set already under `libraryPath` is launched in place, all of it or none, and
only when it sits in one directory; otherwise the whole set lands in the cache,
where the playlist is always written.

### Save data

Left to itself an emulator writes save data next to the ROM, where cache
[eviction](#rom-cache) eventually deletes it or RomM scans it out of your
library. So each game gets a directory of its own, keyed on the ROM id, and what
is in there is [synced with RomM](#saves-synced-with-romm) around a launch.

```
<saveDataPath>/<romId>/saves/<name>.srm
<saveDataPath>/<romId>/states/<name>.state
```

The filename comes from the server, so a cached launch and an in-place launch
land on one file. A detected RetroArch is passed `-s` and `-S`, overriding
`savefile_directory` in your `retroarch.cfg`. Set `saveDataPath` to move the
whole tree, a synced folder say. A configured emulator has to be told:

```json
{
  "emulators": [
    {
      "platformSlug": "*",
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

Prefer `{savefile}` and `{statefile}` over `{saves}` and `{states}` where they
are accepted: given only a directory, an emulator names the save after the ROM,
which differs between a cached and an in-place launch when the name needed
rewriting for Windows. Emulators that only read a save directory from their own
config are better left without the tokens.

### Saves synced with RomM

RomM keeps a save library of its own, and a native launch is the one moment this
shell holds a save file RomM also has a copy of. With `syncSaves` on, every
launch asks the server what it has before the emulator starts, and offers it
what the emulator left behind once it exits.

```
RomM  ──pull──▶  <saveDataPath>/<romId>/saves/<name>.srm  ──push──▶  RomM
```

A push goes into the `autosave` slot, the same one the browser player writes to,
so a game played in either place keeps one save. A slot that has moved on since
this device last saw it is never overwritten: those bytes are filed as an
archival save outside every slot, so the worst a conflict costs is an extra save
to choose between in RomM. Only what changed is sent, except a save RomM does
not hold yet, which goes up regardless.

Only a launch that names the save file syncs one. The built-in RetroArch path
does; a mapping does when its arguments name `{savefile}`. `{saves}` does not
count, since it leaves the emulator to name the save itself -- so add
`{savefile}` to a mapping that has only `{saves}`. To stop syncing altogether,
turn `syncSaves` off; the local files stay where they are.

`deviceId` is what lets the server tell a save this device already has from one
it has never seen. Clear it and the next launch registers a fresh device with no
history, so a save that differs on both sides is archived rather than merged.

Nothing here can fail a launch. Two limits: the push happens when the emulator
exits, so closing the window mid-game on Windows or Linux quits the shell and
that save waits for the next launch; and save states are not synced at all,
since RomM's API has no slot or device tracking for them.

### Firmware from RomM

RomM has a firmware library of its own: BIOS files uploaded per platform, served
from `/api/firmware`. These are fetched the way a ROM is, skipped when disk
already matches the size the server reports, into one directory per platform:

```
<biosPath>/<platformSlug>/<file name>
```

Per platform rather than per game, because the emulator is what has to find them
under the name it expects. The directory is kept as a mirror, so firmware
deleted in RomM goes from here on the next launch -- but only in response to a
list actually received, and nothing about it can fail a launch. Set
`useRommFirmware` to `false` to switch it off, or `biosPath` to move it.

A detected RetroArch is pointed at the mirror for you, with a generated config
naming `system_directory` passed as `--appendconfig`, layered over your own
settings rather than editing your `retroarch.cfg`. A hand-configured one needs
`{biosconfig}`; any other emulator takes `{bios}`, that platform's directory:

```json
{
  "emulators": [
    {
      "platformSlug": "*",
      "command": "/usr/bin/flatpak",
      "args": [
        "run",
        "org.libretro.RetroArch",
        "--appendconfig={biosconfig}",
        "-L",
        "{core}",
        "{rom}"
      ]
    },
    {
      "platformSlug": "psx",
      "command": "/usr/bin/duckstation-qt",
      "args": ["-bios-path", "{bios}", "-batch", "{rom}"]
    }
  ]
}
```

`{biosconfig}` is safe on every platform, including the many with no firmware;
remove it if you set `useRommFirmware` to `false`.

Two limits. PCSX2, Dolphin, RPCS3 and Cemu take no BIOS directory on the command
line, so for those the mirror is a staging directory you point the emulator at
once in its own settings. And it is flat, while a few cores want a subdirectory
(Flycast looks for `dc/dc_boot.bin`) -- put those outside `<biosPath>`.

### ROM cache

Downloaded ROMs are cached under `cachePath`, one directory per ROM:

```
<cachePath>/<romId>/<name>
```

The directory carries the ROM id, so the file keeps the name the server gave it
and an emulator deriving anything from that name agrees with a launch straight
out of the library. Once the cache exceeds `cacheLimitBytes` (20 GB by default),
least-recently-used ROMs are evicted a whole directory at a time.

## Security model

The window loads a remote origin and renders artwork pulled from third-party
metadata providers, so the renderer is treated as untrusted:

- `contextIsolation`, `sandbox` and `nodeIntegration: false` are all enforced,
  and self-signed certificates prompt once, then are remembered by fingerprint.
- Navigation stays on your server's origin, redirects included; every other link
  goes to your real browser. The exception is the OIDC endpoint, which opens the
  auth window described under [Signing in](#signing-in) -- carrying no preload,
  so `window.rommNative` is reachable only from your server's page.
- The camera is granted only to your server's origin, only to the top-level
  frame and only for video, so RomM's barcode scanner works while embedded
  metadata cannot reach it. Every other permission is refused.
- The renderer never supplies an executable or arguments. It names a game and
  the cores its platform supports; the command comes from your config, and
  processes are spawned with an argument array, never a shell string.
- Core names are matched against `[a-z0-9_]+` before becoming a path or a
  buildbot request, and a downloaded core is written only to the cores directory
  after its checksum is verified.
- An installer or emulator build is downloaded only after you say yes, only to a
  fixed directory, and only from origins pinned per project. The shell never
  runs it, and a short transfer is deleted rather than opened.
- ROM and firmware URLs must resolve to the configured server origin and an
  `/api/` route. A firmware filename is used verbatim, because that is the name
  an emulator looks for, so one that is not already a plain filename is refused
  rather than rewritten.

## Packaging

```bash
npm run package            # for this machine
npm run package -- --linux # or --win, --mac
```

Output lands in `release/`. Tagging `v*` runs the same build on all three
platforms and opens a draft GitHub release; a manual workflow run builds the
artifacts without releasing them.

| Platform | Format   | Unsigned experience                                   |
| -------- | -------- | ----------------------------------------------------- |
| Linux    | AppImage | Normal, nothing is signed on Linux anyway             |
| Windows  | zip      | SmartScreen warns until the binary earns reputation   |
| macOS    | zip      | Gatekeeper blocks; approve under Privacy and Security |

Nothing is signed yet, and auto-update is not wired up.
`electron-builder.yml` carries the signing and notarization options as commented
configuration, so enabling them is a credentials change rather than a code one.
macOS auto-update needs a Developer ID, so signing and updates land together.

Linux ships an AppImage rather than a Flatpak deliberately: a Flatpak cannot
casually launch the emulators installed on the host, which is the one thing this
shell exists to do.

## Layout

```
src/
  main/             Main process
    config.ts       Persisted settings and RetroArch autodetection
    emulator/       Which emulator and core a platform gets, and fetching
                    either one: RetroArch's installer, libretro cores from
                    the buildbot, and the standalone PCSX2, Dolphin, RPCS3
                    and Cemu -- detected, or offered from each project's
                    own release index
    launcher.ts     Download, resolve, spawn, track
    rom-cache.ts    Download with the window's session cookies
    cache/          LRU eviction over the ROM cache
    saves/          Per-game save and state directories
    discs/          Multi-disc sets: disc selection and the .m3u that boots
                    them
    firmware/       Mirroring RomM's own BIOS library, per platform
    safety.ts       Validation of everything the renderer sends
    window.ts       Window creation and navigation policy
    index.ts        App lifecycle, single-instance lock, initial window
    ipc.ts          IPC handlers behind window.rommNative
    argv.ts         Command-line flag parsing
    download.ts     Fetching a file the OS is then asked to open
    zip.ts          Minimal reader for the buildbot's core archives
    spike.ts        TEMPORARY: the --spike harness (see above)
  preload/          contextBridge surface (window.rommNative)
  shared/           Types shared with the RomM frontend
```

## License

AGPL-3.0-only, matching RomM.
