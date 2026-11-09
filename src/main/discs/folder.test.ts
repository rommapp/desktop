import assert from "node:assert/strict";
import { test } from "node:test";
import { folderGame } from "./folder.ts";
import { type DiscFile } from "./m3u.ts";

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
