# RomM Desktop

A desktop shell for [RomM](https://github.com/rommapp/romm) that runs your
server's own web interface in a native window and launches games in a locally
installed emulator instead of an in-browser core.

The distinguishing part is what it does not do: it has no interface of its own.
Other desktop clients talk to the RomM API and rebuild the browsing experience --
collections, search, filtering, metadata, scanning -- then keep all of it in step
with upstream. This loads the frontend your server already serves and adds
exactly one thing to that page: a bridge that hands a game to a real emulator.

> **Early work in progress.** The launch path has not been tested against a
> real RetroArch install on macOS or Windows, and the surfaces listed under
> [Untested](#untested) have not been exercised at all.

## How this compares

Native launching is well covered in the RomM ecosystem, and for many people an
alternative is the better fit:

| Option                                                                                              | Emulator runs | Interface                |
| --------------------------------------------------------------------------------------------------- | ------------- | ------------------------ |
| RomM emulator streaming                                                                             | On the server | RomM's own, in a browser |
| [Argosy, Grout, Playnite plugin](https://docs.romm.app/) (first party)                              | Your device   | Their own, per platform  |
| [romm-client](https://github.com/chaun14/romm-client), [RomMix](https://github.com/leclercb/rommix) | Your machine  | Their own                |
| RomM Desktop                                                                                        | Your machine  | RomM's own, at runtime   |

Streaming needs a host powerful enough to run the emulator and gives one session
per container, so it suits a beefy server and any client device. The API clients
own their interface, which makes them independent of RomM's frontend but leaves
them reimplementing it. This shell takes the opposite trade: nothing to
reimplement, at the cost of depending on RomM's frontend. For save syncing,
offline mode, or a non-desktop device, check those projects first -- they are
further along.

## How this relates to RomM

This repository contains no RomM code and does not build RomM. It loads your
server's frontend at runtime and injects one global, `window.rommNative`, whose
shape is defined in `src/shared/types.ts`; RomM's own UI feature-detects it. So
the "Play natively" button ships with the server rather than with this shell, a
server without the integration simply renders in a normal window, and there is
no version lock between the two. The shell owns a deliberately small surface:
the launch bridge, emulator resolution, the ROM cache, and the window's
security policy. Everything else is RomM's.

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

The address is saved in `desktop-config.json` and the setup window normally
appears only when none is set, so `npm run dev -- --setup` is how you correct a
mistyped one. Quitting it without saving leaves the stored address untouched.

## Trying it before the RomM side exists

```bash
npm run dev -- --spike
```

This injects a throwaway panel into the corner of the page, so the idea is
testable against an unmodified server that has never heard of
`window.rommNative`. It carries a hardcoded slice of RomM's platform/core map in
`src/main/spike.ts`; a platform outside that short list reports "no core in the
spike map", which is a limit of the harness rather than of the shell. A
standalone emulator configured under `emulators` still launches, because user
mappings need no core.

It is throwaway. Once the download-then-launch wait, core autodetection, the
handoff to the emulator and whether any of this beats downloading the ROM
yourself have been judged on real hardware, delete
`src/main/spike.ts`, `src/main/spike.test.ts`, and the `installSpike` wiring in
`src/main/window.ts`.

## Signing in

A username and password work in the window as they do in a browser. OIDC and
SSO take a detour, because the identity provider is off-origin by definition
while the main window is confined to your server. That flow gets a window of
its own, which permits the excursion and shares the session, so the cookie your
provider establishes is the one the app then holds; it closes as soon as the
flow lands back on your server, and a provider that already has a session
answers so fast it never appears at all.

Logging out is the one part handed to your browser. RomM clears its own session
before returning your provider's end-session URL, so you are signed out of RomM
either way; whether your provider's session ends depends on the browser that
URL opens in. An off-origin address arriving from a page is indistinguishable
from any other external link, and treating a class of them as auth would widen
the boundary the auth window exists to keep narrow.

## Untested

The in-browser emulators (EmulatorJS, Ruffle, js-dos, PICO-8), file downloads
and clipboard actions are untested in this shell and worth exercising.

## Using a controller

RomM's own interface handles controller navigation, so the shell adds none.
`/settings/controller-debug` shows whether the input system can see your pad.

The Gamepad API is restricted to secure contexts, a browser rule rather than a
shell one: a server reached over `https://` or at `http://localhost` works, one
at a plain `http://192.168.x.x` does not, and fails silently. Quitting the
emulator brings the window back to the front, so a session that started with a
controller does not need a mouse to continue.

## Emulator configuration

Config lives in `desktop-config.json` in Electron's `userData` directory:

| Platform | Path                                          |
| -------- | --------------------------------------------- |
| Linux    | `~/.config/romm-desktop/`                     |
| macOS    | `~/Library/Application Support/romm-desktop/` |
| Windows  | `%APPDATA%\romm-desktop\`                     |

Edits are picked up while the app runs: the file is re-read whenever it changes
on disk, so a setting takes effect on the next launch attempt without a restart
and an edit made while the app is open is not overwritten by the next save. The
spike panel's "Edit settings" link opens it directly.

### RetroArch (default)

RetroArch and its cores directory are detected from the usual install
locations. When a game is launched, RomM's own platform/core map decides which
libretro cores are candidates, and the first one actually installed wins.

#### No emulator at all

On a machine with nothing installed and nothing configured, the shell offers
once, on startup, to fetch RetroArch's official installer and open it. Answer
"Don't ask again" and it never asks again; install an emulator by any means and
the offer stops on its own.

It never installs anything itself. The file is handed to the operating system --
Windows runs it with the usual UAC and SmartScreen prompts, macOS mounts the
image and you drag it across -- so you consent through the flow you already
recognise and RetroArch keeps ownership of its own updates. Linux is offered
nothing to download: the only build published there is a 179 MB portable `.7z`,
while your distribution's package is smaller and is the copy that will actually
receive updates, so the prompt points at the download page.

Nothing needs restarting afterwards. While no emulator has been found the usual
locations are re-probed on every launch attempt, so the next press of Play picks
it up; an install somewhere unusual still needs `retroarchPath` by hand. A
RetroArch that has never been run has no cores directory, so the shell falls
back to where that directory belongs on your platform and creates it when it
writes the first core -- [missing cores](#missing-cores) therefore work straight
after the install. That fallback applies only to a detected install; a
hand-configured emulator, a Flatpak RetroArch included, still needs
`retroarchCoresPath`.

The installer is kept in `installers` beside the config and deleted once an
emulator has been found. Set `offerRetroArchInstall` to `false` to never ask:

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
narrowed away -- whatever the frontend offered still follows, in its original
order -- so a preference not published for your system falls through to RomM's
suggestion rather than failing the launch.

A preference you do not have is downloaded even when something else that plays
the game is installed, which is the case the setting exists for: `pcsx_rearmed`
plays PlayStation games perfectly well but is not on RetroAchievements'
supported list, while `mednafen_psx_hw` and `swanstation` are, and having
`pcsx_rearmed` is exactly why you had to name one. Likewise RetroAchievements
wants Beetle Saturn (`mednafen_saturn`) rather than the Kronos core some
frontends default to, which is also not published for Apple Silicon. Either way
the download is never allowed to cost you a launch that would have worked: a
preferred core that cannot be fetched leaves the game starting on the core you
already have.

Names are checked against the same `[a-z0-9_]+` alphabet as everything else
before they become a path or a request. That cannot catch a typo:
`mednafen_psx_h` is a legal name for a core that does not exist, so it finds
nothing, fails to download, and the launch falls through to RomM's suggestion.
Achievements themselves are RetroArch's business -- log in under its own
Settings and RomM shows the progression once it syncs.

#### Missing cores

A core that is not installed is fetched from the
[libretro buildbot](https://buildbot.libretro.com/) rather than failing the
launch -- the same build RetroArch's own core updater installs. Candidates are
tried in the frontend's order and the first one published for this machine wins,
so the usual case is a few seconds' wait before the game starts.

It is deliberately narrow: nothing is downloaded unless RetroArch is already
installed, the platform's emulator actually loads a libretro core, the cores
directory is known, none of the candidates are present, and the buildbot
publishes for this architecture. A standalone emulator never triggers it. Set
`autoInstallCores` to `false` for a launch that fails with the missing cores
named instead:

```json
{
  "autoInstallCores": false
}
```

The core has to match the emulator's architecture rather than this shell's, so
an x86_64 RetroArch under Rosetta on an Apple Silicon Mac is handed arm64 cores
it cannot load; install those through RetroArch's own updater. Only the nightly
channel exists per core, so this tracks upstream rather than pinning a version.

Detection covers the standard package locations on Linux and macOS, and on
Windows the portable `C:\RetroArch-Win64` layout, both Program Files
directories, the per-user Programs directory, scoop, Steam, and RetroBat's
bundled copy. An install anywhere else, notably on a drive other than C:, needs
`retroarchPath` set by hand. Point it at the executable and the cores directory
is derived from its parent, so `retroarchCoresPath` is usually unnecessary.

### Detected standalone emulators

Some platforms need an emulator that is not a libretro core. RetroAchievements
recognises the standalone PCSX2 and Dolphin but not their cores, so for PS2 and
GameCube/Wii no core will ever unlock an achievement; PS3 and Wii U are plainer
still, since libretro has no core for either and RPCS3 and Cemu are the only way
those games launch at all.

All four have always been configurable under `emulators`. What nobody can
reasonably guess is the executable name and argument template, so the shell
looks for them where they land, the same way it already looks for RetroArch:

| Emulator | Platforms    | Looked for in                                                                    |
| -------- | ------------ | -------------------------------------------------------------------------------- |
| PCSX2    | `ps2`        | `/Applications`, Program Files, the per-user Programs directory, scoop, RetroBat |
| Dolphin  | `ngc`, `wii` | the same, plus `/usr/bin` and `/usr/games` and its Flatpak on Linux              |
| RPCS3    | `ps3`        | the same, plus `/usr/bin` and `/usr/local/bin` and its Flatpak on Linux          |
| Cemu     | `wiiu`       | the same, plus `%LOCALAPPDATA%\Cemu`, which is where its own installer puts it   |

The executable names are why this is worth doing: `pcsx2-qt.exe`, not
`pcsx2.exe`; `RPCS3.app` with a lowercase `rpcs3` inside it; `Cemu` with a
capital C on Linux. RetroBat alone ships `pcsx2`, `pcsx2-16` and `pcsx2x6`.

Nothing is written to your config, and an emulator installed by any means is
found the same way, a frontend's own tree included, so someone running RetroBat
in `C:\RetroBat` gets its emulators without configuring them twice. Only that
path, though: a portable RetroBat on another drive needs `emulatorsBasePath` and
an `emulators` row, as below.

When there is nothing to find, the platform is still reported as launchable --
naming the emulator it would set up rather than the one it has -- and pressing
Play offers to fetch it from the project. Reporting the plain truth there would
hide the button, and the button is the only thing that raises the offer. The
file is handed to the operating system exactly as RetroArch's installer is. The
launch then waits: install it the way its project intends and the game starts on
its own once it appears, whether what was fetched installs itself or you went and
installed it from the download page. The wait only ends the launch early where
the emulator is a file you keep somewhere of your own choosing, which nothing can
detect. Cancelling the download stops the wait, and so does closing the window.

Coverage is uneven, and not in a way this shell can fix:

| Emulator | macOS                            | Windows                        | Linux    |
| -------- | -------------------------------- | ------------------------------ | -------- |
| PCSX2    | `.tar.xz`, opens Archive Utility | installer                      | Flatpak  |
| Dolphin  | disk image                       | `.7z`, opens in Explorer on 11 | Flatpak  |
| RPCS3    | `.7z`                            | `.7z`                          | AppImage |
| Cemu     | disk image                       | installer                      | AppImage |

An archive leaves a portable build wherever you extract it. Detection cannot
guess where that is, so the prompt says as much, the launch does not wait for
something it will never see, and you point at the executable under `emulators`
afterwards. An AppImage is neither installer nor archive -- it is the emulator,
as one file -- and opening it would mean this shell running a binary it just
downloaded, so it is made executable, shown in your file manager, and left for
you to point at.

A machine a project does not build for -- 32-bit Windows in every case, ARM
Linux for all but Dolphin -- is sent to the download page rather than handed a
binary it cannot run. That still waits: a package manager and a project's own
installer both land where detection looks, so installing it from there starts
your game without a second press of Play. Where only an x86-64 build exists it is offered and left
to Rosetta, which is how an Apple silicon Mac gets RPCS3. Asked at most once per
emulator per run; declining lets the launch carry on as it would have. Set
`offerStandaloneInstall` to `false` to never ask.

Each version comes from the project's own release index: Dolphin's update
channel, PCSX2's release API, the endpoint RPCS3's in-app updater calls, and for
Cemu -- which publishes none -- the GitHub release its download page points at,
pinned to its own repository.

A row you wrote yourself always wins. A detected emulator does beat a `*`
wildcard row, though: a catch-all should not claim a platform that has a real
emulator installed for it. Set `useDetectedEmulators` to `false` to switch the
whole thing off:

```json
{
  "useDetectedEmulators": false
}
```

That takes the download offer with it: with detection off, an emulator in its
usual place is one this shell will not use. Write an `emulators` row instead.

Two per-emulator things the shell cannot do for you. RetroAchievements wants
Dolphin 2407-68 or newer for GameCube (2603a for Wii) with "Enable Dual Core
(speedup)" off, both in Dolphin's own settings. And RPCS3 boots a single file it
is handed -- an `EBOOT.BIN`, a `.self` -- while a PS3 title kept in RomM as a
folder of many files downloads as an archive it cannot boot; that limit is the
launch path's rather than this row's and applies to any multi-file game, so keep
such titles somewhere RPCS3 already sees them. Cemu is unaffected: `.wua`,
`.wud` and `.wux` are each one file.

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

The executable name is not guessable from the directory name -- `pcsx2` holds
`pcsx2-qt.exe` next to an `updater.exe` -- so list a directory to see what is
actually there: `Get-ChildItem E:\RetroBat\emulators\<name> -Filter *.exe`.

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
match what the server reports -- so a local file that is not the one the server
meant never launches in its place. The server supplies only the path below the
root, and anything resolving outside it is rejected rather than normalised.

[Save data](#save-data) goes to its own directory either way, so launching in
place does not leave saves in your library for RomM to scan.

### Save data

Left to itself an emulator writes save data next to the ROM, and neither place
that lands is somewhere it should stay: a game played from the cache keeps its
save where [eviction](#rom-cache) eventually deletes it, and one launched in
place under `libraryPath` leaves its save in your library for RomM to scan.

So the shell hands each game a directory of its own, under `save-data` beside
the config file. Syncing it back to RomM is out of scope:

```
<saveDataPath>/<romId>/saves/<name>.srm
<saveDataPath>/<romId>/states/<name>.state
```

`saveDataPath` has to sit outside `cachePath`, and the shell refuses a launch
when either contains the other: eviction removes a cached ROM's directory whole,
and save data underneath it would go with it.

The directory is keyed on the ROM id and the filename comes from the server, so
a cached launch and an in-place launch land on one file. RetroArch is passed
`-s` and `-S`, which override whatever `savefile_directory` your `retroarch.cfg`
sets. Set `saveDataPath` to move the whole tree, a synced folder say.

A configured emulator has to be told, since the shell only passes the arguments
a mapping asks for. `{saves}` and `{states}` expand to the two directories, and
`{savefile}` and `{statefile}` to the files inside them:

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
line at all, varies: several only read a save directory from their own config,
and there the entry is better left without the tokens. Prefer the file tokens
where one is accepted. Given only a directory an emulator names the save after
the ROM, and the cached copy carries a name the shell has made portable --
Windows device names, trailing dots and characters legal on Linux but not
Windows are rewritten -- so a ROM whose name needed rewriting derives two save
names, one per launch path. `{savefile}`, `{statefile}` and RetroArch's own `-s`
and `-S` name the file outright and are unaffected.

Should `saveDataPath` ever be empty, a mapping naming one of these tokens fails
with an explanation rather than handing the emulator a blank argument, the same
way `{core}` does.

### Firmware from RomM

RomM has a firmware library of its own: BIOS files uploaded per platform, served
from `/api/firmware`. Nothing on this side used it, so a `scph5501.bin` already
sitting in RomM still had to be copied into RetroArch's system directory by
hand, and then again on the next machine.

It is now fetched the way a ROM is -- same server, same session cookies, skipped
when what is on disk already matches the size the server reports, written to a
`.part` file that is renamed on success -- into one directory per platform:

```
<biosPath>/<platformSlug>/<file name>
```

Per platform rather than per game, because the _emulator_ is what has to find
these, under the name it expects: a core looking for `scph5501.bin` will not take
`<romId>/scph5501.bin`. And never evicted, unlike the [ROM cache](#rom-cache):
these are a few megabytes a launch depends on. The directory is kept as a mirror
instead, so firmware deleted in RomM goes from here on the next launch.

Nothing about it can fail a launch. Most platforms need no firmware, a user may
not have RomM's firmware read scope, and a server older than the endpoint
answers 404 -- all three end as "no firmware", which is the launch this shell
performed before any of it existed. Defaults to on; set `useRommFirmware` to
`false` to switch it off, or `biosPath` to put the mirror elsewhere:

```json
{
  "useRommFirmware": true,
  "biosPath": "/home/you/romm-bios"
}
```

`biosPath` has to sit outside `cachePath` and `saveDataPath`, and the shell
refuses a launch when any two of the three contain each other: the mirror
deletes what the server no longer lists and cache eviction deletes a ROM
directory whole, so an overlap means one of them deleting files the other owns.

The RetroArch the shell found for itself is pointed at it for you: it writes a
config naming `system_directory` and passes `--appendconfig`, which layers over
your own settings for that one run rather than editing your `retroarch.cfg`, so
switching the mirror off switches this off with it. Those generated files live
in `<biosPath>/.retroarch/`, are rewritten on every launch that syncs, and are
not worth editing.

A RetroArch you configured yourself under `emulators` does not get that
automatically, because the shell cannot tell that `flatpak run
org.libretro.RetroArch` is RetroArch, nor where in your own arguments a flag of
its own would be safe to insert. Say where you want it with `{biosconfig}`:

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
    }
  ]
}
```

That is safe on every platform, including the many with no firmware at all: the
file always exists while the mirror is on, and on a platform with nothing to
find it contains only comments, so it overrides none of your settings. Remove
the token if you set `useRommFirmware` to `false`.

Any other emulator has to be told too, the same way save data works. `{bios}`
expands to that platform's directory:

```json
{
  "emulators": [
    {
      "platformSlug": "psx",
      "label": "DuckStation",
      "command": "/usr/bin/duckstation-qt",
      "args": ["-bios-path", "{bios}", "-batch", "{rom}"]
    }
  ]
}
```

Two things this cannot do for you. PCSX2, Dolphin, RPCS3 and Cemu take no BIOS
directory on the command line at all, each reading its own, so for those the
mirror is a staging directory you point the emulator at once in its own settings
-- PCSX2's Settings, BIOS, or RPCS3's Install Firmware for a `PS3UPDAT.PUP`
sitting there. And the mirror is flat, because a RomM firmware row carries a
filename and nothing else, while a few libretro cores want a subdirectory of the
system directory (Flycast looks for `dc/dc_boot.bin`). Put those where the core
wants them, outside `<biosPath>`, since anything inside a platform's directory
that RomM does not list is treated as firmware it no longer has.

Deleting is the one thing the mirror does that it cannot take back, so it only
ever acts on an answer: the server listing this platform's firmware. Being
offline, lacking the read scope, a server too old for the endpoint, a platform
the server does not have, and a reply that is not the list it should be all
leave the mirror and its RetroArch pointer exactly as they were.

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
- An installer or emulator build is downloaded only after you say yes, only
  from the origins pinned for that project's artifacts -- pinned separately
  from the origins its release index may answer from, and narrowed again to the
  project's own repository path where the asset is a GitHub release -- and only
  to a fixed directory. The shell never runs it -- it is handed to the operating
  system, so Gatekeeper and SmartScreen see it as they would a browser download
  -- and a transfer that stops short of the declared length is deleted rather
  than opened.
- ROM and firmware download URLs must resolve to the configured server origin
  and an `/api/` route, and processes are spawned with an argument array, never
  a shell string.
- A firmware filename from the server is used verbatim, because that is the name
  an emulator looks for, so one that is not already a plain filename is refused
  rather than rewritten into a safe one. Nothing the server says can name a path
  outside the platform's own directory.
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

Auto-update is not wired up either, which matters more here than for most apps:
the shell renders remote content in Chromium and so carries a standing
obligation to track Electron releases. macOS auto-update cannot work without a
Developer ID, so signing and updates land together.

`build/icon.png` is RomM's own mark at 1024, circular with transparent corners
rather than full bleed, because macOS applies no mask of its own. Linux ships an
AppImage rather than a Flatpak deliberately: a Flatpak cannot casually launch
the emulators installed on the host, which is the one thing this shell exists to
do.

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
