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
save syncing, offline mode, or a non-desktop device, check those projects first
-- they are further along.

## How this relates to RomM

This repository contains no RomM code. It loads your server's frontend at
runtime and injects one global, `window.rommNative`, whose shape is defined in
`src/shared/types.ts`; RomM's own UI feature-detects it. So the "Play natively"
button ships with the server, a server without the integration renders in a
normal window, and there is no version lock between the two. The shell owns
only the launch bridge, emulator resolution, the ROM cache, and the window's
security policy.

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

The `--spike` panel is throwaway scaffolding. It carries a hardcoded slice of
RomM's platform/core map, so a platform outside that list reports "no core in
the spike map"; a standalone emulator configured under `emulators` still
launches, since user mappings need no core. Once the launch path has been
judged on real hardware, delete `src/main/spike.ts`, `src/main/spike.test.ts`,
and the `installSpike` wiring in `src/main/window.ts`.

## Signing in

A username and password work as they do in a browser. OIDC and SSO get a window
of their own, since the identity provider is off-origin while the main window
is confined to your server; it shares the session and closes as soon as the
flow lands back on your server.

Logging out is handed to your browser. RomM clears its own session before
returning your provider's end-session URL, so you are signed out of RomM either
way; whether your provider's session ends depends on the browser that URL opens
in.

### When the session runs out

RomM's session lasts fourteen days by default and is renewed by use, so a shell
opened regularly stays signed in. One left alone for longer, or signed out from
elsewhere, comes back to a server that no longer recognises it.

The shell notices this itself, because it makes requests of its own that the
page never sees: the ROM download, the disc list, the firmware list, the save
negotiation. RomM answers those with a 401, which is its own signal that the
caller should go and sign in -- distinct from the 403 it answers a user whose
account simply lacks a scope, and which is not a session problem and not treated
as one here. On a 401 the shell reloads the window and lets RomM's own frontend
take it from there, so you get the login your server ships rather than a form
this shell invented, and an OIDC server still goes to its provider.

A launch that stops for this reason says so in as many words rather than
reporting a failed download, and nothing is lost by it: a save the shell could
not send stays on disk and is offered again the next time you launch that game.
Sign in and press Play again.

One reload per sign-out, not one per request: a single launch asks the server
several times and an expired session fails all of them. A login page already on
screen is left alone, and so is a window opened for an identity provider, since
that is a sign-in already happening.

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

The file is re-read whenever it changes on disk, so an edit takes effect on the
next launch attempt without a restart and is not overwritten by the next save.

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
`cachePath`, `saveDataPath` and `biosPath` must not contain one another, and
the shell refuses a launch when any two overlap: cache eviction deletes a ROM
directory whole and the firmware mirror deletes what the server no longer
lists, so an overlap means one of them deleting files another owns.

With `fullscreen` on, the setup window stays windowed regardless, since it is
the one screen that needs a keyboard. F11 toggles fullscreen at runtime on
Windows and Linux, Control Command F on macOS.

### RetroArch

RetroArch and its cores directory are detected from the usual install
locations: standard packages on Linux and macOS, and on Windows the portable
`C:\RetroArch-Win64` layout, both Program Files directories, the per-user
Programs directory, scoop, Steam, and RetroBat's bundled copy. Anywhere else --
notably a drive other than C: -- needs `retroarchPath`. Point it at the
executable and the cores directory is derived from its parent.

When a game is launched, RomM's platform/core map decides which libretro cores
are candidates, and the first one actually installed wins.

With nothing installed and nothing configured, the shell offers once on startup
to fetch RetroArch's official installer and open it. It never installs anything
itself -- the file is handed to the operating system, so you get the UAC,
SmartScreen or disk-image flow you already recognise. Linux is pointed at the
download page instead, since the only build published there is a 179 MB
portable `.7z` while your distribution's package is the copy that will actually
receive updates. The installer is kept in `installers` beside the config and
deleted once an emulator has been found.

Nothing needs restarting afterwards -- the usual locations are re-probed on
every launch attempt. A RetroArch that has never been run has no cores
directory, so the shell falls back to where that directory belongs on your
platform and creates it when it writes the first core. That fallback applies
only to a detected install; a hand-configured emulator, Flatpak included, still
needs `retroarchCoresPath`.

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

A core named here is honoured even when the frontend never offered it, which is
how you reach a core RomM's map does not list. Nothing is narrowed away --
whatever the frontend offered still follows, in its original order. A
preference you do not have is downloaded even when something else that plays
the game is installed, which is the case the setting exists for: `pcsx_rearmed`
plays PlayStation games well but is not on RetroAchievements' supported list.

A preference that cannot be resolved never costs you a launch. One not
published for your system, one that fails to download, and a typo
(`mednafen_psx_h` is a legal name for a core that does not exist) all fall
through to RomM's suggestion.

Achievements themselves are RetroArch's business -- log in under its own
Settings and RomM shows the progression once it syncs.

#### Missing cores

A core that is not installed is fetched from the
[libretro buildbot](https://buildbot.libretro.com/) rather than failing the
launch -- the same build RetroArch's own core updater installs. Candidates are
tried in the frontend's order and the first one published for this machine
wins, so the usual case is a few seconds' wait before the game starts.

Nothing is downloaded unless RetroArch is already installed, the platform's
emulator actually loads a libretro core, the cores directory is known, none of
the candidates are present, and the buildbot publishes for this architecture. A
standalone emulator never triggers it. Set `autoInstallCores` to `false` for a
launch that fails with the missing cores named instead.

The core has to match the emulator's architecture rather than this shell's, so
an x86_64 RetroArch under Rosetta on an Apple Silicon Mac is handed arm64 cores
it cannot load; install those through RetroArch's own updater. Only the nightly
channel exists per core, so this tracks upstream rather than pinning a version.

### Detected standalone emulators

Some platforms need an emulator that is not a libretro core: RetroAchievements
recognises the standalone PCSX2 and Dolphin but not their cores, and libretro
has no core for PS3 or Wii U at all. All four are configurable under
`emulators`, but the executable name and argument template are not guessable,
so the shell looks for them where they land:

| Emulator | Platforms    | Looked for in                                                                    |
| -------- | ------------ | -------------------------------------------------------------------------------- |
| PCSX2    | `ps2`        | `/Applications`, Program Files, the per-user Programs directory, scoop, RetroBat |
| Dolphin  | `ngc`, `wii` | the same, plus `/usr/bin` and `/usr/games` and its Flatpak on Linux              |
| RPCS3    | `ps3`        | the same, plus `/usr/bin` and `/usr/local/bin` and its Flatpak on Linux          |
| Cemu     | `wiiu`       | the same, plus `%LOCALAPPDATA%\Cemu`, which is where its own installer puts it   |

Nothing is written to your config, and an emulator installed by any means is
found the same way, a frontend's own tree included -- so RetroBat in
`C:\RetroBat` needs no configuring. Only that path, though: a portable RetroBat
on another drive needs `emulatorsBasePath` and an `emulators` row.

A row you wrote yourself always wins. A detected emulator does beat a `*`
wildcard row: a catch-all should not claim a platform that has a real emulator
installed for it. `useDetectedEmulators: false` switches the whole thing off,
and takes the download offer with it.

#### Offering to fetch one

When there is nothing to find, the platform is still reported as launchable --
naming the emulator it would set up -- and pressing Play offers to fetch it
from the project's own release index. The file is handed to the operating
system exactly as RetroArch's installer is, and the launch waits: install it
the way its project intends and the game starts on its own. Cancelling the
download or closing the window stops the wait. Asked at most once per emulator
per run; `offerStandaloneInstall: false` never asks.

| Emulator | macOS                            | Windows                        | Linux    |
| -------- | -------------------------------- | ------------------------------ | -------- |
| PCSX2    | `.tar.xz`, opens Archive Utility | installer                      | Flatpak  |
| Dolphin  | disk image                       | `.7z`, opens in Explorer on 11 | Flatpak  |
| RPCS3    | `.7z`, one per architecture      | `.7z`                          | AppImage |
| Cemu     | disk image                       | installer                      | AppImage |

A macOS archive holds a `.app`, and a `.app` goes to Applications, the first
place detection looks -- so those wait like anything else. On Windows and Linux
an archive leaves a portable build wherever you extract it, which detection
cannot guess, so the launch does not wait and you point at the executable under
`emulators` afterwards. An AppImage is made executable and shown in your file
manager, since running a binary it just downloaded is not something the shell
does. A machine a project does not build for -- 32-bit Windows in every case,
ARM Linux for all but Dolphin -- is sent to the download page.

RPCS3 on Apple silicon is a special case: the endpoint RPCS3's own updater
calls names a single macOS build and that build is x86-64, so the native build
is taken from `rpcs3-binaries-mac-arm64` under the same name with `_aarch64`
before the suffix. If a release stops following that naming the download 404s
and the offer falls back to the download page.

Two things the shell cannot do for you. RetroAchievements wants Dolphin 2407-68
or newer for GameCube (2603a for Wii) with "Enable Dual Core (speedup)" off,
both in Dolphin's own settings. And RPCS3 boots a single file it is handed --
an `EBOOT.BIN`, a `.self` -- while a PS3 title kept in RomM as a folder of many
files downloads as an archive it cannot boot, so keep such titles somewhere
RPCS3 already sees them. Cemu is unaffected: `.wua`, `.wud` and `.wux` are each
one file.

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

A token that cannot be resolved fails the launch with an explanation rather
than passing an empty argument to the emulator, so a wildcard RetroArch row
still needs `retroarchCoresPath` to be findable. An optional `playlist` key
says whether the emulator boots an `.m3u`, which only affects
[multi-disc games](#multi-disc-games).

Set `emulatorsBasePath` and a `command` can be relative to it, for a frontend
like RetroBat that keeps every emulator under one tree. An absolute `command`
is always used as given.

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

The executable name is not guessable from the directory name -- `pcsx2` holds
`pcsx2-qt.exe` next to an `updater.exe` -- so list a directory to see what is
there: `Get-ChildItem E:\RetroBat\emulators\<name> -Filter *.exe`.

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
needs configuring. The lookup is skipped, and the download happens as usual,
whenever `libraryPath` is unset, the file is not there, or its size does not
match what the server reports. The server supplies only the path below the
root, and anything resolving outside it is rejected rather than normalised.
[Save data](#save-data) goes to its own directory either way, so launching in
place leaves nothing in your library for RomM to scan.

### Multi-disc games

A game split across discs is one ROM with several files on the server, and
asking for that ROM as a single download returns an archive that a multi-disc
game cannot boot out of. So a ROM the server reports as two or more disc images
is fetched as those individual files instead, one request each.

Discs are ordered by the number in their name (`Disc 2`, `disk 2`, `CD2`).
Where a sheet (`.cue`, `.gdi`, `.ccd`, `.mds`) is present, the track formats it
describes are not discs -- the rule RomM itself applies in `utils/m3u.py` --
though the tracks are still fetched beside the sheet, which cannot boot without
them. A whole-disc image is never a sheet's track whatever it is named, so a
`.chd` beside a `.gdi` is a disc of its own; the ambiguous case of a bare
`.bin` beside a `.cue` reads as a track. A set that ships its own `.m3u` is
handed that instead of a generated one.

What the emulator is handed depends on whether it reads an `.m3u`:

|                                 | Handed         | Changing disc                                                   |
| ------------------------------- | -------------- | --------------------------------------------------------------- |
| RetroArch, Dolphin, DuckStation | `discs.m3u`    | the emulator's disc-control menu                                |
| PCSX2, RPCS3, Cemu              | the first disc | the emulator's own "change disc", with the set in one directory |

PCSX2 is the reason for the second row: [its M3U request was closed as not
planned](https://github.com/PCSX2/pcsx2/issues/7640) and
[automatic swapping is still open](https://github.com/PCSX2/pcsx2/issues/7278),
so handing it a playlist would fail the launch outright. There, disc 2 is
System > Change Disc from the menu bar, or Change Disc in the on-screen quick
menu on a controller; the shell passes `-batch` and never `-nogui`, which would
hide that menu bar. The playlist is written as UTF-8 with LF endings because
that is all Dolphin accepts.

A detected emulator carries its own answer. One configured by hand is assumed
not to read a playlist, unless its arguments name `{core}` or RetroArch,
Dolphin or DuckStation is named in the command or its arguments -- which covers
`flatpak run org.duckstation.DuckStation` as well as an executable path.
`"playlist"` outranks both inferences:

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

A set already under `libraryPath` is launched in place, all of it or none of
it, and only when it sits in one directory: a sheet's tracks sit beside it by
relative name, and an emulator with no playlist looks for the next disc beside
the one it booted. Otherwise the whole set lands in the ROM cache. The playlist
is always written to the cache, never into the library.

Nothing here can fail a launch that would otherwise have worked -- a server
that will not answer, files that cannot be read, a set that turns out to hold
one disc, and an interrupted transfer all fall back to the ordinary
single-payload download. Only cancelling stays fatal.

### Save data

Left to itself an emulator writes save data next to the ROM, where cache
[eviction](#rom-cache) eventually deletes it or RomM scans it out of your
library. So each game gets a directory of its own, keyed on the ROM id, and
what is in there is [synced with RomM](#saves-synced-with-romm) around a launch.

```
<saveDataPath>/<romId>/saves/<name>.srm
<saveDataPath>/<romId>/states/<name>.state
```

The filename comes from the server, so a cached launch and an in-place launch
land on one file. A detected RetroArch is passed `-s` and `-S`, which override
whatever `savefile_directory` your `retroarch.cfg` sets. Set `saveDataPath` to
move the whole tree, a synced folder say.

A configured emulator has to be told, with `{saves}`, `{states}`, `{savefile}`
and `{statefile}`:

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

Which of the four an emulator wants varies, and several only read a save
directory from their own config -- there the entry is better left without the
tokens. Prefer `{savefile}` and `{statefile}` where they are accepted: given
only a directory an emulator names the save after the ROM, and since the cached
copy carries a name the shell has made portable for Windows, a ROM whose name
needed rewriting derives two save names, one per launch path.

### Saves synced with RomM

RomM keeps a save library of its own, and a native launch is the one moment this
shell holds a save file RomM also has a copy of. With `syncSaves` on, every
launch asks the server what it has for that game before the emulator starts, and
offers it what the emulator left behind once it exits. Between those two moments
the two copies can only agree by having been told.

The direction of travel is a pull before and a push after:

```
RomM  ──pull──▶  <saveDataPath>/<romId>/saves/<name>.srm  ──push──▶  RomM
```

A push goes into the `autosave` slot, which is the same slot the browser player
writes to, so a game played in the browser and a game played here keep one save
between them rather than one each. A slot that has moved on since this device
last saw it is never overwritten: `overwrite` is always false, the server answers
409, and the local bytes are filed as an archival save outside every slot instead
of being offered to a slot that already holds newer progress. The same happens
before a pull that would replace local bytes whose content the server does not
already hold, so the worst a conflict can cost is an extra save to choose between
in RomM. A pull the shell cannot make safe does not happen at all: a server copy
it has no hash to check the transfer against, and a local file it could not read
to know what that copy would be displacing, both leave the save on disk exactly
as the emulator will find it.

Only a launch that names the save file syncs one. The built-in RetroArch path
does, by passing `-s`, and a mapping does when its arguments name `{savefile}`.
Anything else keeps its saves wherever the emulator puts them, and nothing is
pulled into a file it will not read. `{saves}` does not count: it hands over the
directory and leaves the emulator to name the save after the content, which is
the one thing that differs between a game launched from the cache and the same
game launched from the library. If you want sync on a mapping that currently
names `{saves}`, name `{savefile}` as well.

Most launches push nothing. The shell takes the save's digest before the
emulator starts and again after it exits, and sends only what changed. The
exception is a save RomM does not hold yet: the negotiation says so, and that
save goes up on the first launch whether or not the session touched it, so
turning sync on brings an existing shelf of saves across instead of making you
play each game again to move it.

The device is registered once and its id kept in `deviceId`. That id is what lets
the server tell "this device already has this save" from "this device has never
seen it", so clearing it is worth knowing about: the next launch registers a
fresh device with no sync history, the first negotiation after that falls back to
comparing timestamps alone, and a save that exists on both sides in different
versions is archived rather than merged. Nothing is lost, only merged less
cleverly. To stop syncing altogether, turn `syncSaves` off; the local files stay
exactly where they are.

None of this can fail a launch. A server that will not answer, an upload the
server refuses, and a device the server has forgotten all end the same way as a
platform with no save to sync: the file is left where it is and the game starts
anyway.

One gap worth knowing about. The push happens when the emulator exits, which
means the shell has to still be running to send it. Close the window while a
game is open and, on Windows and Linux, the shell quits and that session's save
is never pushed -- the emulator keeps running, and what it writes stays local
until the next launch of that game sends it. macOS is unaffected, since closing
the window there does not quit the app. Leave the window open until you have
finished playing, and nothing is lost either way: the save is on disk, and the
next launch negotiates it.

Save states are not synced. RomM's API has no slot, content hash or device
tracking for them, so `<saveDataPath>/<romId>/states/` belongs to this machine
alone.

### Firmware from RomM

RomM has a firmware library of its own: BIOS files uploaded per platform,
served from `/api/firmware`. These are fetched the way a ROM is -- same server,
same session cookies, skipped when what is on disk already matches the size the
server reports -- into one directory per platform:

```
<biosPath>/<platformSlug>/<file name>
```

Per platform rather than per game, because the _emulator_ is what has to find
these under the name it expects. Never evicted, unlike the
[ROM cache](#rom-cache); the directory is kept as a mirror instead, so firmware
deleted in RomM goes from here on the next launch, and anything inside a
platform's directory that RomM does not list is treated as firmware it no
longer has.

Nothing about it can fail a launch: a platform needing no firmware, a missing
firmware read scope, and a server too old for the endpoint all end as "no
firmware". The mirror only ever deletes in response to a list it actually
received, so anything short of that -- being offline, an unrecognised reply --
leaves it as it was. Set `useRommFirmware` to `false` to switch it off, or
`biosPath` to put the mirror elsewhere.

A detected RetroArch is pointed at the mirror for you, with a generated config
naming `system_directory` passed as `--appendconfig` -- layered over your own
settings for that one run rather than editing your `retroarch.cfg`. Those files
live in `<biosPath>/.retroarch/`, are rewritten on every launch that syncs, and
are not worth editing.

A RetroArch you configured yourself does not get that automatically, since the
shell cannot tell that `flatpak run org.libretro.RetroArch` is RetroArch, nor
where in your arguments a flag of its own would be safe to insert. Say where
with `{biosconfig}`; any other emulator takes `{bios}`, that platform's
directory:

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
        "--appendconfig={biosconfig}",
        "-L",
        "{core}",
        "{rom}"
      ]
    },
    {
      "platformSlug": "psx",
      "label": "DuckStation",
      "command": "/usr/bin/duckstation-qt",
      "args": ["-bios-path", "{bios}", "-batch", "{rom}"]
    }
  ]
}
```

`{biosconfig}` is safe on every platform, including the many with no firmware:
the file always exists while the mirror is on, and where there is nothing to
find it contains only comments. Remove the token if you set `useRommFirmware`
to `false`.

Two things this cannot do for you. PCSX2, Dolphin, RPCS3 and Cemu take no BIOS
directory on the command line at all, each reading its own, so for those the
mirror is a staging directory you point the emulator at once in its own
settings -- PCSX2's Settings, BIOS, or RPCS3's Install Firmware for a
`PS3UPDAT.PUP` sitting there. And the mirror is flat, because a RomM firmware
row carries a filename and nothing else, while a few libretro cores want a
subdirectory of the system directory (Flycast looks for `dc/dc_boot.bin`). Put
those where the core wants them, outside `<biosPath>`.

### ROM cache

Downloaded ROMs are cached under `cachePath`, one directory per ROM:

```
<cachePath>/<romId>/<name>
```

The directory carries the ROM id, so the file keeps the name the server gave it
and an emulator deriving anything from the content name agrees with a launch
straight out of the library. Once the cache exceeds `cacheLimitBytes` (20 GB by
default), least-recently-used ROMs are evicted a whole directory at a time.

## Security model

The window loads a remote origin and renders artwork and descriptions pulled
from third-party metadata providers, so the renderer is treated as untrusted:

- `contextIsolation`, `sandbox` and `nodeIntegration: false` are all enforced.
- In-window navigation is restricted to your server's origin, redirects
  included, and every other link is handed to your real browser. The one
  address that leaves is the OIDC endpoint, which opens the separate auth
  window described under [Signing in](#signing-in); that window carries no
  preload, so `window.rommNative` is reachable only from your server's page.
- The camera is granted only to your server's origin, only to the top-level
  frame and only for video, so RomM's barcode scanner works while embedded
  third-party metadata cannot reach it. Every other permission is refused.
- The renderer never supplies an executable or arguments. It names a game and
  the libretro cores its platform supports; the command comes from your config.
- Core names are matched against `[a-z0-9_]+` before becoming a path, so they
  cannot point the loader outside the cores directory. The same check gates the
  buildbot URL, so a name that cannot be a filename cannot be a request either.
- A downloaded core is written only to the cores directory, under the filename
  the shell derived; no path inside the archive is read, and the contents are
  checked against its own checksum before the emulator loads them.
- An installer or emulator build is downloaded only after you say yes, only to
  a fixed directory, and only from the origins pinned for that project's
  artifacts -- pinned separately from the origins its release index may answer
  from, and narrowed to the project's own repository path for a GitHub release.
  The shell never runs it, and a transfer that stops short of the declared
  length is deleted rather than opened.
- ROM and firmware download URLs must resolve to the configured server origin
  and an `/api/` route, and processes are spawned with an argument array, never
  a shell string.
- A firmware filename from the server is used verbatim, because that is the
  name an emulator looks for, so one that is not already a plain filename is
  refused rather than rewritten into a safe one. Nothing the server says can
  name a path outside the platform's own directory.
- Self-signed certificates, common on a LAN, prompt once and are then
  remembered by fingerprint.

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

Nothing is signed yet. `electron-builder.yml` carries the signing and
notarization options as commented configuration, so enabling them is a
credentials change rather than a code change. Auto-update is not wired up
either, which matters more here than for most apps: the shell renders remote
content in Chromium and so carries a standing obligation to track Electron
releases. macOS auto-update needs a Developer ID, so signing and updates land
together.

Linux ships an AppImage rather than a Flatpak deliberately: a Flatpak cannot
casually launch the emulators installed on the host, which is the one thing
this shell exists to do.

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
    auth/           Telling a session that has expired from a scope that was
                    never granted, and getting back to a login page
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
