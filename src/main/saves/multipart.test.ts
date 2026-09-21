import assert from "node:assert/strict";
import { test } from "node:test";

import {
  randomBoundary,
  saveUploadBody,
  stateUploadBody,
} from "./multipart.ts";

/** Parse a body back the way a server would, using the platform's own parser
 *  rather than this module's idea of what it wrote. */
async function parse(upload: {
  contentType: string;
  body: Uint8Array<ArrayBuffer>;
}): Promise<FormData> {
  const request = new Request("http://localhost/api/saves", {
    method: "POST",
    headers: { "content-type": upload.contentType },
    body: upload.body,
  });
  return request.formData();
}

test("the field is the one the endpoint declares, carrying the bytes", async () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252]);
  const form = await parse(saveUploadBody("Game.srm", bytes, "test-boundary"));

  const part = form.get("saveFile");
  assert.ok(part instanceof File);
  assert.equal(part.name, "Game.srm");
  assert.deepEqual(new Uint8Array(await part.arrayBuffer()), bytes);
});

test("the content type names the boundary the body was built with", () => {
  const upload = saveUploadBody("Game.srm", new Uint8Array(0), "abc123");
  assert.equal(upload.contentType, "multipart/form-data; boundary=abc123");
});

test("an empty save is still a field, not a missing one", async () => {
  const form = await parse(saveUploadBody("Game.srm", new Uint8Array(0), "b"));
  assert.ok(form.get("saveFile") instanceof File);
});

test("bytes that look like framing survive it", async () => {
  // A save is opaque binary, so it can hold anything, including CRLFs and text
  // shaped like a part header. What it cannot hold is this request's own
  // boundary, which is random precisely so that it does not.
  const bytes = new TextEncoder().encode(
    "\r\n--some-other-boundary\r\nContent-Disposition: form-data; name=x\r\n",
  );
  const form = await parse(saveUploadBody("Game.srm", bytes, "test-boundary"));

  const part = form.get("saveFile");
  assert.ok(part instanceof File);
  assert.deepEqual(new Uint8Array(await part.arrayBuffer()), bytes);
  // The text inside the file must not have become a field of its own.
  assert.equal(form.get("x"), null);
});

test("the boundary is fresh and within the length the spec allows", () => {
  const first = randomBoundary();
  assert.match(first, /^[0-9a-f]{32}$/);
  assert.notEqual(first, randomBoundary());
});

test("a state goes up with the picture the emulator took beside it", async () => {
  const state = new Uint8Array([1, 2, 3]);
  const picture = new Uint8Array([137, 80, 78, 71]);
  const form = await parse(
    stateUploadBody(
      "Game [pc slot 1].state",
      state,
      { fileName: "Game [pc slot 1].state.png", bytes: picture },
      "test-boundary",
    ),
  );

  const part = form.get("stateFile");
  const shot = form.get("screenshotFile");
  assert.ok(part instanceof File);
  assert.ok(shot instanceof File);
  assert.deepEqual(new Uint8Array(await part.arrayBuffer()), state);
  assert.deepEqual(new Uint8Array(await shot.arrayBuffer()), picture);
});

test("a state with no picture sends one field, not an empty second", async () => {
  // RetroArch only writes thumbnails when they are switched on, and a blank
  // screenshotFile is not the same as leaving it out: the endpoint would take
  // the empty part as a picture and file it.
  const form = await parse(
    stateUploadBody("Game [pc slot 1].state", new Uint8Array([1]), null, "b"),
  );

  assert.ok(form.get("stateFile") instanceof File);
  assert.equal(form.get("screenshotFile"), null);
});
