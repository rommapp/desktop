// The one multipart body this shell ever has to send.
//
// Written by hand rather than depended on because the project ships no runtime
// dependencies, and a save upload needs one field: the bytes are already in
// memory, the filename is already reduced to a safe component, and the header
// set is three lines long. FormData would be the obvious alternative, but Node's
// version of it builds a body the same way and would take the boundary out of
// the caller's hands, which is the one thing a test needs to pin.

import { randomBytes } from "node:crypto";

/** A server save upload's body and the header that describes it. Typed as a
 *  plain Uint8Array over an ArrayBuffer, which is what `fetch` accepts as a
 *  body: a `Buffer` is one over a possibly shared buffer and is refused. */
export interface SaveUpload {
  contentType: string;
  body: Uint8Array<ArrayBuffer>;
}

/**
 * A boundary that will not appear in a save.
 *
 * Random per request rather than a fixed string, so a save containing the
 * boundary cannot end the body early and truncate itself. 32 hex characters is
 * well inside the 70 the spec allows.
 */
export function randomBoundary(): string {
  return randomBytes(16).toString("hex");
}

/**
 * A single-file multipart body for `POST /api/saves`.
 *
 * The field name is `saveFile`, which is what RomM's endpoint declares. No
 * escaping is applied to the filename: every name reaching here has already been
 * through `safeFileName`, which removes the quotes and control characters that
 * would otherwise be able to break out of the header.
 */
export function saveUploadBody(
  fileName: string,
  bytes: Uint8Array,
  boundary: string = randomBoundary(),
): SaveUpload {
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="saveFile"; filename="${fileName}"\r\n` +
      "Content-Type: application/octet-stream\r\n\r\n",
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);

  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0);
  body.set(bytes, head.length);
  body.set(tail, head.length + bytes.length);

  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body,
  };
}
