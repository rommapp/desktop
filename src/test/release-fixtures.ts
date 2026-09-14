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
