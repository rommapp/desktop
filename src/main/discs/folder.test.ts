import assert from "node:assert/strict";
import { test } from "node:test";
import { folderGame } from "./folder.ts";
import { readRomFiles, type DiscFile } from "./m3u.ts";

const file = (id: number, path: string): DiscFile => ({
  id, fullPath: path, fileName: path.split("/").at(-1)!, sizeBytes: 12,
});

test("recognizes PS3 disc folder and preserves nested files", () => {
  const game = folderGame([
    file(1, "ps3/My Game/PS3_GAME/USRDIR/EBOOT.BIN"),
    file(2, "ps3/My Game/PS3_GAME/USRDIR/data/asset.dat"),
    file(3, "ps3/My Game/PS3_DISC.SFB"),
  ], "ps3");
  assert.equal(game?.bootFileId, 1);
  assert.deepEqual(game?.files.map((f) => f.relativePath), [
    "PS3_GAME/USRDIR/EBOOT.BIN", "PS3_GAME/USRDIR/data/asset.dat", "PS3_DISC.SFB",
  ]);
});

test("recognizes Wii U code and content folders", () => {
  const game = folderGame([
    file(1, "wiiu/My Game/code/game.rpx"),
    file(2, "wiiu/My Game/content/data.pack"),
    file(3, "wiiu/My Game/meta/meta.xml"),
  ], "wiiu");
  assert.equal(game?.bootFileId, 1);
  assert.equal(game?.files[1]?.relativePath, "content/data.pack");
});

test("rejects path traversal and cross-game paths", () => {
  assert.equal(folderGame([
    file(1, "ps3/Game/PS3_GAME/USRDIR/EBOOT.BIN"),
    file(2, "ps3/Game/../other.bin"),
  ], "ps3"), null);
  assert.equal(folderGame([
    file(1, "ps3/Game/PS3_GAME/USRDIR/EBOOT.BIN"),
    file(2, "ps3/Other/file.bin"),
  ], "ps3"), null);
});

test("rejects case-insensitive collisions and missing boot files", () => {
  assert.equal(folderGame([
    file(1, "wiiu/Game/code/game.rpx"),
    file(2, "wiiu/Game/code/GAME.RPX"),
  ], "wiiu"), null);
  assert.equal(folderGame([file(1, "wiiu/Game/content/asset.bin")], "wiiu"), null);
});

test("preserves duplicate basenames in distinct folder paths from API rows", () => {
  const paths = [
    "ps3/Game/PS3_GAME/USRDIR/EBOOT.BIN",
    "ps3/Game/PS3_GAME/USRDIR/level1/asset.dat",
    "ps3/Game/PS3_GAME/USRDIR/level2/asset.dat",
  ];
  const rows = paths.map((path, index) => ({
    id: index + 1, file_name: path.split("/").at(-1),
    full_path: path, file_size_bytes: 12,
  }));
  const parsed = readRomFiles({ files: rows }, true);
  assert.equal(parsed.length, 3);
  assert.equal(folderGame(parsed, "ps3")?.files.length, 3);
  assert.equal(readRomFiles({ files: rows }).length, 2, "flat disc behavior stays unchanged");
});

test("rejects case-insensitive file and directory ancestor collisions", () => {
  assert.equal(folderGame([
    file(1, "wiiu/Game/code/game.rpx"),
    file(2, "wiiu/Game/content/assets"),
    file(3, "wiiu/Game/content/ASSETS/texture.bin"),
  ], "wiiu"), null);
});

test("rejects case-insensitive duplicates after API parsing", () => {
  const paths = ["wiiu/Game/code/game.rpx", "wiiu/Game/code/GAME.RPX"];
  const parsed = readRomFiles({ files: paths.map((path, index) => ({
    id: index + 1, file_name: path.split("/").at(-1),
    full_path: path, file_size_bytes: 12,
  })) }, true);
  assert.equal(parsed.length, 2);
  assert.equal(folderGame(parsed, "wiiu"), null);
});
