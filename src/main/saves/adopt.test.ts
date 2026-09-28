import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { type AskAtlas } from "../atlas/cli.ts";
import { adoptLocalSave, type AdoptOptions } from "./adopt.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "adopt-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function installation(kind: string) {
  return { kind, label: kind, kinds: [kind], root, health: [] };
}

function placement(dir: string, files: string[], state = "observed") {
  return {
    dir,
    root_kind: "savefile_directory",
    needs: [],
    fallback_dir: null,
    physical_dir: null,
    file_set: { state, files, complete: false, groups: [] },
    caveats: [],
    granularity: null,
  };
}

/** An emu-atlas that answers from a table keyed on the subcommand and the
 *  installation it was asked of, and records every question. */
function fakeAtlas(answers: Record<string, unknown>): {
  ask: AskAtlas;
  asked: string[][];
} {
  const asked: string[][] = [];
  const ask: AskAtlas = async (args) => {
    asked.push([...args]);
    const only = args.find((arg) => arg.startsWith("--installation="));
    const key = only
      ? `${args[0]} ${only.slice("--installation=".length)}`
      : args[0];
    return answers[key ?? ""] ?? null;
  };
  return { ask, asked };
}

function options(patch: Partial<AdoptOptions>): AdoptOptions {
  return {
    ask: async () => null,
    romId: 12,
    platformSlug: "gba",
    coreFile: "mgba_libretro.so",
    romPath: join(root, "cache", "12", "Golden Sun (USA).gba"),
    saveFile: join(root, "save-data", "12", "saves", "Golden Sun (USA).srm"),
    saveDataPath: join(root, "save-data"),
    signal: new AbortController().signal,
    ...patch,
  };
}

async function prepare(): Promise<AdoptOptions> {
  const base = options({});
  await mkdir(join(root, "save-data", "12", "saves"), { recursive: true });
  return base;
}

test("an empty machine costs one question and copies nothing", async () => {
  const base = await prepare();
  const { ask, asked } = fakeAtlas({ "systems-for-platform": [] });
  assert.equal(await adoptLocalSave({ ...base, ask }), null);
  assert.deepEqual(asked, [["systems-for-platform", "igdb", "gba"]]);
  await assert.rejects(stat(base.saveFile));
});

test("a RetroDECK save is found under its own ROM folder and copied in", async () => {
  const base = await prepare();
  const saves = join(root, "retrodeck", "saves", "gba");
  await mkdir(saves, { recursive: true });
  const theirs = join(saves, "Golden Sun (USA).srm");
  await writeFile(theirs, "progress");
  const written = new Date("2025-06-01T12:00:00Z");
  await utimes(theirs, written, written);

  const romDir = join(root, "retrodeck", "roms", "gba");
  const { ask, asked } = fakeAtlas({
    "systems-for-platform": [
      {
        installation: installation("retrodeck"),
        answer: { matches: [{ system: "gba", status: "declared" }] },
      },
    ],
    "rom-location retrodeck": {
      dir: romDir,
      extensions: [],
      physical_dir: null,
      caveats: [],
    },
    "savefile-location retrodeck": placement(saves, ["Golden Sun (USA).srm"]),
  });

  assert.equal(await adoptLocalSave({ ...base, ask }), theirs);
  assert.equal(await readFile(base.saveFile, "utf8"), "progress");
  // As old as the save it came from, so a newer copy in RomM still wins.
  assert.equal((await stat(base.saveFile)).mtimeMs, written.getTime());
  // The other installation's file is only ever read.
  assert.equal(await readFile(theirs, "utf8"), "progress");
  assert.deepEqual(asked[2], [
    "savefile-location",
    "--core=mgba_libretro.so",
    `--content=${join(romDir, "Golden Sun (USA).gba")}`,
    "--system=gba",
    "--installation=retrodeck",
  ]);
  // Nothing but the save itself is left in the shell's directory.
  assert.deepEqual(await readdir(join(root, "save-data", "12", "saves")), [
    "Golden Sun (USA).srm",
  ]);
});

test("with no catalogue the question names the ROM the shell launches", async () => {
  const base = await prepare();
  const { ask, asked } = fakeAtlas({
    "systems-for-platform": [
      {
        installation: installation("bare_retroarch_native"),
        answer: { matches: [] },
      },
    ],
  });
  assert.equal(await adoptLocalSave({ ...base, ask }), null);
  assert.deepEqual(asked[1], [
    "savefile-location",
    "--core=mgba_libretro.so",
    `--content=${base.romPath}`,
    "--installation=bare_retroarch_native",
  ]);
});

test("of two installations holding the game, the one played last wins", async () => {
  const base = await prepare();
  const older = join(root, "emudeck", "saves");
  const newer = join(root, "native", "saves");
  for (const [dir, body, when] of [
    [older, "old", "2024-01-01T00:00:00Z"],
    [newer, "new", "2025-01-01T00:00:00Z"],
  ] as const) {
    await mkdir(dir, { recursive: true });
    const file = join(dir, "Golden Sun (USA).srm");
    await writeFile(file, body);
    await utimes(file, new Date(when), new Date(when));
  }
  const { ask } = fakeAtlas({
    "systems-for-platform": [
      { installation: installation("emudeck"), answer: { matches: [] } },
      {
        installation: installation("bare_retroarch_native"),
        answer: { matches: [] },
      },
    ],
    "savefile-location emudeck": placement(older, ["Golden Sun (USA).srm"]),
    "savefile-location bare_retroarch_native": placement(newer, [], "unknown"),
  });
  assert.equal(
    await adoptLocalSave({ ...base, ask }),
    join(newer, "Golden Sun (USA).srm"),
  );
  assert.equal(await readFile(base.saveFile, "utf8"), "new");
});

test("a save the shell already has is never replaced", async () => {
  const base = await prepare();
  await writeFile(base.saveFile, "mine");
  const { ask, asked } = fakeAtlas({});
  assert.equal(await adoptLocalSave({ ...base, ask }), null);
  assert.deepEqual(asked, []);
  assert.equal(await readFile(base.saveFile, "utf8"), "mine");
});

test("the shell's own tree is not read back as another installation's", async () => {
  const base = await prepare();
  const own = join(root, "save-data", "7", "saves");
  await mkdir(own, { recursive: true });
  await writeFile(join(own, "Golden Sun (USA).srm"), "other rom");
  const { ask } = fakeAtlas({
    "systems-for-platform": [
      {
        installation: installation("bare_retroarch_native"),
        answer: { matches: [] },
      },
    ],
    "savefile-location bare_retroarch_native": placement(own, [
      "Golden Sun (USA).srm",
    ]),
  });
  assert.equal(await adoptLocalSave({ ...base, ask }), null);
  await assert.rejects(stat(base.saveFile));
});

test("a slug that could not be an argument asks nothing", async () => {
  const base = await prepare();
  const { ask, asked } = fakeAtlas({});
  assert.equal(
    await adoptLocalSave({ ...base, ask, platformSlug: "--home=/" }),
    null,
  );
  assert.deepEqual(asked, []);
});

test("emu-atlas failing outright is a launch with nothing copied", async () => {
  const base = await prepare();
  const ask: AskAtlas = async () => {
    throw new Error("spawn EACCES");
  };
  assert.equal(await adoptLocalSave({ ...base, ask }), null);
  await assert.rejects(stat(base.saveFile));
});

test("a cancel stops the questions and copies nothing", async () => {
  const base = await prepare();
  const controller = new AbortController();
  const saves = join(root, "retrodeck", "saves");
  await mkdir(saves, { recursive: true });
  await writeFile(join(saves, "Golden Sun (USA).srm"), "progress");
  const asked: string[] = [];
  const ask: AskAtlas = async (args) => {
    asked.push(args[0] ?? "");
    if (args[0] === "systems-for-platform") {
      controller.abort();
      return [
        { installation: installation("retrodeck"), answer: { matches: [] } },
      ];
    }
    return placement(saves, ["Golden Sun (USA).srm"]);
  };
  assert.equal(
    await adoptLocalSave({ ...base, ask, signal: controller.signal }),
    null,
  );
  assert.deepEqual(asked, ["systems-for-platform"]);
  await assert.rejects(stat(base.saveFile));
});
