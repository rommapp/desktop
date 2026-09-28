import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chooseAdoption,
  contentPathFor,
  isOwnSave,
  isSafeAtlasId,
  readInstallations,
  readRomDir,
  saveCandidates,
} from "./answers.ts";

// Shapes below follow emu-atlas's generated contract reference
// (docs/contract-reference.md) and its conformance vectors.

function installation(kind: string) {
  return { kind, label: kind, kinds: [kind], root: "/root", health: [] };
}

/** A savefile placement as `savefile_placement_contract` serializes one. */
function placement(patch: Record<string, unknown> = {}) {
  return {
    dir: "/mnt/sd/retrodeck/saves",
    root_kind: "savefile_directory",
    needs: [],
    fallback_dir: null,
    physical_dir: null,
    file_set: { state: "observed", files: [], complete: false, groups: [] },
    caveats: [],
    granularity: null,
    ...patch,
  };
}

test("an id handed back to emu-atlas has to fit its alphabet", () => {
  for (const ok of [
    "snes",
    "genesis-slash-megadrive",
    "bare_retroarch_flatpak",
  ])
    assert.equal(isSafeAtlasId(ok), true, ok);
  // A leading dash would read as a flag; the rest would never be an id.
  for (const bad of ["-h", "--home=/", "", "a b", "../x", "snes;rm", 7, null])
    assert.equal(isSafeAtlasId(bad), false, String(bad));
  assert.equal(isSafeAtlasId("a".repeat(65)), false);
});

test("each installation is read with the system its catalogue declares", () => {
  const answer = [
    {
      installation: installation("retrodeck"),
      answer: {
        vocabulary: "igdb",
        value: "snes",
        platforms: ["snes"],
        matches: [
          {
            system: "snes",
            status: "declared",
            platforms: ["snes"],
            tags_source: "catalogue",
          },
          {
            system: "sfc",
            status: "absent",
            platforms: ["snes"],
            tags_source: "vocabulary",
          },
        ],
        caveats: [],
      },
    },
    {
      // A bare RetroArch has no catalogue, so nothing is declared.
      installation: installation("bare_retroarch_native"),
      answer: {
        vocabulary: "igdb",
        value: "snes",
        platforms: ["snes"],
        matches: [
          {
            system: "snes",
            status: "absent",
            platforms: ["snes"],
            tags_source: "vocabulary",
          },
        ],
        caveats: [],
      },
    },
  ];
  assert.deepEqual(readInstallations(answer), [
    { kind: "retrodeck", system: "snes" },
    { kind: "bare_retroarch_native", system: null },
  ]);
});

test("a disabled system is not one to look for ROMs under", () => {
  const answer = [
    {
      installation: installation("emudeck"),
      answer: {
        matches: [{ system: "snes", status: "disabled" }],
      },
    },
  ];
  assert.deepEqual(readInstallations(answer), [
    { kind: "emudeck", system: null },
  ]);
});

test("the empty machine, and anything that is not the labelled list, is nobody", () => {
  for (const junk of [[], null, {}, "x", [null], [{ installation: {} }]])
    assert.deepEqual(readInstallations(junk), [], JSON.stringify(junk));
});

test("a kind is asked once, and one that could not be an argument is dropped", () => {
  const entry = (kind: string) => ({
    installation: installation(kind),
    answer: { matches: [] },
  });
  assert.deepEqual(
    readInstallations([entry("emudeck"), entry("emudeck"), entry("-x")]),
    [{ kind: "emudeck", system: null }],
  );
});

test("a system name that could not be an argument is not used", () => {
  const answer = [
    {
      installation: installation("retrodeck"),
      answer: {
        matches: [
          { system: "--home=/tmp", status: "declared" },
          { system: "gba", status: "declared" },
        ],
      },
    },
  ];
  assert.deepEqual(readInstallations(answer), [
    { kind: "retrodeck", system: "gba" },
  ]);
});

test("a ROM directory is read only when it resolved to an absolute path", () => {
  assert.equal(
    readRomDir({
      dir: "/mnt/sd/retrodeck/roms/gba",
      extensions: [".gba"],
      physical_dir: null,
      caveats: [],
    }),
    "/mnt/sd/retrodeck/roms/gba",
  );
  // rom_location never refuses; a null dir is how it says it resolved none.
  for (const junk of [
    { dir: null },
    { dir: "roms/gba" },
    { dir: "" },
    null,
    [],
  ])
    assert.equal(readRomDir(junk), null, JSON.stringify(junk));
});

test("the save question names the ROM where the installation keeps it", () => {
  assert.equal(
    contentPathFor(
      "/cache/12/Golden Sun (USA).gba",
      "/mnt/sd/retrodeck/roms/gba",
    ),
    "/mnt/sd/retrodeck/roms/gba/Golden Sun (USA).gba",
  );
  assert.equal(
    contentPathFor("/cache/12/Golden Sun (USA).gba", null),
    "/cache/12/Golden Sun (USA).gba",
  );
});

test("observed and declared battery saves are the candidates", () => {
  const content = "/roms/gb/Tetris (World).gb";
  for (const state of ["observed", "declared"]) {
    assert.deepEqual(
      saveCandidates(
        placement({
          file_set: {
            state,
            files: ["Tetris (World).srm", "Tetris (World).rtc"],
            complete: false,
            groups: [],
          },
        }),
        content,
      ),
      ["/mnt/sd/retrodeck/saves/Tetris (World).srm"],
      state,
    );
  }
});

test("a set atlas will not name falls back to RetroArch's default name", () => {
  assert.deepEqual(
    saveCandidates(
      placement({
        file_set: { state: "unknown", files: [], complete: false, groups: [] },
      }),
      "/mnt/sd/retrodeck/roms/gba/Golden Sun (USA).gba",
    ),
    ["/mnt/sd/retrodeck/saves/Golden Sun (USA).srm"],
  );
});

test("the files behind a symlinked directory are the ones read", () => {
  assert.deepEqual(
    saveCandidates(
      placement({
        physical_dir: "/run/media/deck/sd/saves",
        file_set: {
          state: "observed",
          files: ["Game.srm"],
          complete: false,
          groups: [],
        },
      }),
      "/roms/Game.sfc",
    ),
    ["/run/media/deck/sd/saves/Game.srm"],
  );
});

test("a refusal, an open hole or an unknown shape gives nothing", () => {
  const content = "/roms/Game.sfc";
  assert.deepEqual(
    saveCandidates(
      { unresolved: { code: "standalone-unsupported", data: {} } },
      content,
    ),
    [],
  );
  assert.deepEqual(saveCandidates({ no_savestates: {} }, content), []);
  assert.deepEqual(
    saveCandidates(
      placement({ dir: "/saves/<library_name>", needs: ["library_name"] }),
      content,
    ),
    [],
  );
  assert.deepEqual(saveCandidates(placement({ dir: "saves" }), content), []);
  assert.deepEqual(
    saveCandidates(placement({ needs: undefined }), content),
    [],
  );
  assert.deepEqual(saveCandidates(placement({ file_set: null }), content), []);
  assert.deepEqual(
    saveCandidates(
      placement({ file_set: { state: "new-state", files: ["Game.srm"] } }),
      content,
    ),
    [],
  );
  for (const junk of [null, [], "x", 3])
    assert.deepEqual(saveCandidates(junk, content), []);
});

test("a declared name that is a template, a path or not a battery save is skipped", () => {
  assert.deepEqual(
    saveCandidates(
      placement({
        file_set: {
          state: "declared",
          files: [
            "<save_id>.srm",
            "../escape.srm",
            "sub/Game.srm",
            "Game.SRM",
            "Game.mcd",
            5,
          ],
          complete: false,
          groups: [],
        },
      }),
      "/roms/Game.bin",
    ),
    ["/mnt/sd/retrodeck/saves/Game.SRM"],
  );
});

test("the most recently written save wins, and empty or huge ones never do", () => {
  const found = [
    { path: "/a.srm", size: 8192, modifiedAt: 100 },
    { path: "/b.srm", size: 8192, modifiedAt: 300 },
    { path: "/empty.srm", size: 0, modifiedAt: 900 },
    { path: "/huge.srm", size: 10_000, modifiedAt: 800 },
  ];
  assert.equal(chooseAdoption(found, 9000)?.path, "/b.srm");
  assert.equal(chooseAdoption([], 9000), null);
  assert.equal(
    chooseAdoption([{ path: "/e", size: 0, modifiedAt: 1 }], 9000),
    null,
  );
});

test("the shell's own save tree is never someone else's save", () => {
  assert.equal(
    isOwnSave("/data/save-data/12/saves/Game.srm", "/data/save-data"),
    true,
  );
  assert.equal(
    isOwnSave("/data/save-data-old/Game.srm", "/data/save-data"),
    false,
  );
  assert.equal(isOwnSave("/mnt/sd/saves/Game.srm", null), false);
});
