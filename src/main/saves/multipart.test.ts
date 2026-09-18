import assert from "node:assert/strict";
import { test } from "node:test";

import { randomBoundary, saveUploadBody } from "./multipart.ts";

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
