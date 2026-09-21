// The multipart bodies this shell has to send.
//
// Written by hand rather than depended on because the project ships no runtime
// dependencies, and an asset upload needs one or two fields: the bytes are
// already in memory, the filename is already reduced to a safe component, and
// the header set is three lines long. FormData would be the obvious
// alternative, but Node's version of it builds a body the same way and would
// take the boundary out of the caller's hands, which is the one thing a test
// needs to pin.

import { randomBytes } from "node:crypto";

/** A server upload's body and the header that describes it. Typed as a plain
 *  Uint8Array over an ArrayBuffer, which is what `fetch` accepts as a body: a
 *  `Buffer` is one over a possibly shared buffer and is refused. */
export interface SaveUpload {
  contentType: string;
  body: Uint8Array<ArrayBuffer>;
}

/** One file in a multipart body, under the field name its endpoint declares. */
export interface UploadPart {
  field: string;
  fileName: string;
  bytes: Uint8Array;
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
 * A multipart body carrying these files, in this order.
 *
 * No escaping is applied to the filenames: every name reaching here has already
 * been through `safeFileName`, which removes the quotes and control characters
 * that would otherwise be able to break out of the header.
 */
export function multipartBody(
  parts: readonly UploadPart[],
  boundary: string = randomBoundary(),
): SaveUpload {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    chunks.push(
      encoder.encode(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${part.field}"; filename="${part.fileName}"\r\n` +
          "Content-Type: application/octet-stream\r\n\r\n",
      ),
      part.bytes,
      encoder.encode("\r\n"),
    );
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`));

  const body = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.length, 0),
  );
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.length;
  }

  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body,
  };
}

/**
 * A body for `POST /api/saves` and the `PUT` that writes over a version it
 * opened. The field name is `saveFile`, which is what RomM's endpoint declares.
 */
export function saveUploadBody(
  fileName: string,
  bytes: Uint8Array,
  boundary: string = randomBoundary(),
): SaveUpload {
  return multipartBody([{ field: "saveFile", fileName, bytes }], boundary);
}

/**
 * A body for `POST /api/states`, with the picture RetroArch took beside the
 * state when it took one.
 *
 * `stateFile` and `screenshotFile` are what RomM's endpoint declares, and it
 * treats the second as optional, so a run whose thumbnails are switched off
 * sends the state alone.
 */
export function stateUploadBody(
  fileName: string,
  bytes: Uint8Array,
  screenshot: { fileName: string; bytes: Uint8Array } | null = null,
  boundary: string = randomBoundary(),
): SaveUpload {
  const parts: UploadPart[] = [{ field: "stateFile", fileName, bytes }];
  if (screenshot) {
    parts.push({
      field: "screenshotFile",
      fileName: screenshot.fileName,
      bytes: screenshot.bytes,
    });
  }
  return multipartBody(parts, boundary);
}
