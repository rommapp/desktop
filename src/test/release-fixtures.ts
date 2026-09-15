// Captured verbatim from each project's own release index, so the selectors in
// standalone-release.ts are exercised on the shapes they will actually meet
// rather than on invented ones.
//
// Inlined rather than read from disk at test time: locating a JSON file beside
// the test needs import.meta, which the CommonJS build will not typecheck.

export const DOLPHIN_BETA: unknown = {
  shortrev: "2606a",
  artifacts: [
    {
      system: "Linux x86_64 (Flatpak)",
      url: "https://dl.dolphin-emu.org/releases/2606a/dolphin-2606a-x86_64.flatpak",
    },
    {
      system: "Windows x64",
      url: "https://dl.dolphin-emu.org/releases/2606a/dolphin-2606a-x64.7z",
    },
    {
      system: "macOS (ARM/Intel Universal)",
      url: "https://dl.dolphin-emu.org/releases/2606a/dolphin-2606a-universal.dmg",
    },
    {
      system: "Linux aarch64 (Flatpak)",
      url: "https://dl.dolphin-emu.org/releases/2606a/dolphin-2606a-aarch64.flatpak",
    },
    {
      system: "Android",
      url: "https://dl.dolphin-emu.org/releases/2606a/dolphin-2606a.apk",
    },
    {
      system: "Windows arm64",
      url: "https://dl.dolphin-emu.org/releases/2606a/dolphin-2606a-arm64.7z",
    },
  ],
};

export const PCSX2_STABLE: unknown = {
  version: "v2.8.2",
  assets: {
    Windows: [
      {
        url: "https://github.com/PCSX2/pcsx2/releases/download/v2.8.2/pcsx2-v2.8.2-windows-x64-installer.exe",
        displayName: "Windows x64",
        additionalTags: ["installer"],
        downloadCount: 0,
        size: 46714216,
      },
      {
        url: "https://github.com/PCSX2/pcsx2/releases/download/v2.8.2/pcsx2-v2.8.2-windows-x64-Qt-symbols.7z",
        displayName: "Windows x64",
        additionalTags: ["Qt", "symbols"],
        downloadCount: 0,
        size: 20962364,
      },
      {
        url: "https://github.com/PCSX2/pcsx2/releases/download/v2.8.2/pcsx2-v2.8.2-windows-x64-Qt.7z",
        displayName: "Windows x64",
        additionalTags: ["Qt"],
        downloadCount: 0,
        size: 25670075,
      },
    ],
    Linux: [
      {
        url: "https://github.com/PCSX2/pcsx2/releases/download/v2.8.2/pcsx2-v2.8.2-linux-appimage-x64-Qt.AppImage",
        displayName: "Linux appimage",
        additionalTags: ["x64", "Qt"],
        downloadCount: 0,
        size: 60119544,
      },
      {
        url: "https://github.com/PCSX2/pcsx2/releases/download/v2.8.2/pcsx2-v2.8.2-linux-flatpak-x64-Qt.flatpak",
        displayName: "Linux flatpak",
        additionalTags: ["x64", "Qt"],
        downloadCount: 0,
        size: 28120408,
      },
    ],
    MacOS: [
      {
        url: "https://github.com/PCSX2/pcsx2/releases/download/v2.8.2/pcsx2-v2.8.2-macos-Qt.tar.xz",
        displayName: "MacOS",
        additionalTags: [],
        downloadCount: 0,
        size: 24377200,
      },
    ],
  },
};

/** Captured from update.rpcs3.net/?api=v2, the endpoint RPCS3's own updater
 *  calls. The envelope is included, so unwrapping is exercised too. */
export const RPCS3_LATEST: unknown = {
  return_code: 0,
  latest_build: {
    pr: 19377,
    datetime: "2026-09-15 18:18:35",
    version: "0.0.42-20004",
    windows: {
      download:
        "https://github.com/RPCS3/rpcs3-binaries-win/releases/download/build-0646d36708cee4ea33690a6b8c4ec5a94e634914/rpcs3-v0.0.42-20004-0646d367_win64_msvc.7z",
      size: 38460412,
      checksum:
        "8E64194E1E5A48E153E685C7FC2BC5C13E0A94F6A38BF05C1EDE047D3840CD7F",
    },
    linux: {
      download:
        "https://github.com/RPCS3/rpcs3-binaries-linux/releases/download/build-0646d36708cee4ea33690a6b8c4ec5a94e634914/rpcs3-v0.0.42-20004-0646d367_linux64.AppImage",
      size: 94006169,
      checksum:
        "E152EC441CDD113099D5B1C3E344949C020ECD1DE172B4715A51DB5509EE341E",
    },
    mac: {
      download:
        "https://github.com/RPCS3/rpcs3-binaries-mac/releases/download/build-0646d36708cee4ea33690a6b8c4ec5a94e634914/rpcs3-v0.0.42-20004-0646d367_macos.7z",
      size: 51236830,
      checksum:
        "56079A5C89BD95492FC027CF77E2D2AB64B2C6983FAAFB204B97A6818805B9A7",
    },
  },
};

/**
 * A Cemu release as GitHub's API returns one.
 *
 * The asset names are the ones Cemu's own deploy workflow produces -- an
 * installer and a portable zip for Windows, an AppImage and an Ubuntu zip for
 * Linux, one disk image per macOS architecture -- with the checksum file a
 * release also carries, so nothing here is a shape the selector will not meet.
 */
export const CEMU_LATEST: unknown = {
  tag_name: "v2.6",
  name: "Cemu 2.6",
  draft: false,
  prerelease: false,
  assets: [
    {
      name: "cemu-2.6-windows-x64.zip",
      browser_download_url:
        "https://github.com/cemu-project/Cemu/releases/download/v2.6/cemu-2.6-windows-x64.zip",
      size: 34904228,
    },
    {
      name: "cemu-2.6-windows-x64-installer.exe",
      browser_download_url:
        "https://github.com/cemu-project/Cemu/releases/download/v2.6/cemu-2.6-windows-x64-installer.exe",
      size: 33452912,
    },
    {
      name: "Cemu-2.6-x86_64.AppImage",
      browser_download_url:
        "https://github.com/cemu-project/Cemu/releases/download/v2.6/Cemu-2.6-x86_64.AppImage",
      size: 61385152,
    },
    {
      name: "cemu-2.6-ubuntu-22.04-x64.zip",
      browser_download_url:
        "https://github.com/cemu-project/Cemu/releases/download/v2.6/cemu-2.6-ubuntu-22.04-x64.zip",
      size: 29360128,
    },
    {
      name: "cemu-2.6-macos-12-x86_64.dmg",
      browser_download_url:
        "https://github.com/cemu-project/Cemu/releases/download/v2.6/cemu-2.6-macos-12-x86_64.dmg",
      size: 41943040,
    },
    {
      name: "cemu-2.6-macos-12-arm64.dmg",
      browser_download_url:
        "https://github.com/cemu-project/Cemu/releases/download/v2.6/cemu-2.6-macos-12-arm64.dmg",
      size: 40894464,
    },
    {
      name: "sha256sums.txt",
      browser_download_url:
        "https://github.com/cemu-project/Cemu/releases/download/v2.6/sha256sums.txt",
      size: 452,
    },
  ],
};
