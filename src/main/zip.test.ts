import assert from "node:assert/strict";
import test from "node:test";
import { ZipError, extractZipEntry, listZipEntries } from "./zip.ts";

// Built by Python's zipfile rather than by this module's own writer, so the
// reader is checked against an independent implementation of the format.
const CORE_NAME = "test_libretro.so";
const BODY = "core payload ".repeat(8);

/** One deflated entry, the shape the buildbot actually publishes. */
const DEFLATED =
  "UEsDBBQAAAAIAPWLLl3o21f8EgAAAGgAAAAQAAAAdGVzdF9saWJyZXRyby5zb0vOL0pVKEiszMlPTFFIph0HAFBLAQIUAxQAAAAIAPWLLl3o21f8EgAAAGgAAAAQAAAAAAAAAAAAAACAAQAAAAB0ZXN0X2xpYnJldHJvLnNvUEsFBgAAAAABAAEAPgAAAEAAAAAAAA==";

/** The same entry stored rather than compressed. */
const STORED =
  "UEsDBBQAAAAAAPWLLl3o21f8aAAAAGgAAAAQAAAAdGVzdF9saWJyZXRyby5zb2NvcmUgcGF5bG9hZCBjb3JlIHBheWxvYWQgY29yZSBwYXlsb2FkIGNvcmUgcGF5bG9hZCBjb3JlIHBheWxvYWQgY29yZSBwYXlsb2FkIGNvcmUgcGF5bG9hZCBjb3JlIHBheWxvYWQgUEsBAhQDFAAAAAAA9YsuXejbV/xoAAAAaAAAABAAAAAAAAAAAAAAAIABAAAAAHRlc3RfbGlicmV0cm8uc29QSwUGAAAAAAEAAQA+AAAAlgAAAAAA";

/** Three entries, the first of which is named to escape a directory. */
const MULTI =
  "UEsDBBQAAAAIAPWLLl0QP9GrBgAAAAQAAAANAAAALi4vLi4vZXZpbC5zb8vLL0gFAFBLAwQUAAAACAD1iy5d6NtX/BIAAABoAAAAEAAAAHRlc3RfbGlicmV0cm8uc29Lzi9KVShIrMzJT0xRSKYdBwBQSwMEFAAAAAgA9YsuXawqk9gEAAAAAgAAAAoAAAByZWFkbWUudHh0y8gEAFBLAQIUAxQAAAAIAPWLLl0QP9GrBgAAAAQAAAANAAAAAAAAAAAAAACAAQAAAAAuLi8uLi9ldmlsLnNvUEsBAhQDFAAAAAgA9YsuXejbV/wSAAAAaAAAABAAAAAAAAAAAAAAAIABMQAAAHRlc3RfbGlicmV0cm8uc29QSwECFAMUAAAACAD1iy5drCqT2AQAAAACAAAACgAAAAAAAAAAAAAAgAFxAAAAcmVhZG1lLnR4dFBLBQYAAAAAAwADALEAAACdAAAAAAA=";

function archive(base64: string): Buffer {
  return Buffer.from(base64, "base64");
}

test("reads a deflated entry", () => {
  const contents = extractZipEntry(archive(DEFLATED), CORE_NAME);
  assert.equal(contents.toString("utf8"), BODY);
});

test("reads a stored entry", () => {
  const contents = extractZipEntry(archive(STORED), CORE_NAME);
  assert.equal(contents.toString("utf8"), BODY);
});

test("picks the named entry out of several", () => {
  const contents = extractZipEntry(archive(MULTI), CORE_NAME);
  assert.equal(contents.toString("utf8"), BODY);
});

test("never reads an entry the caller did not name", () => {
  // The traversing name is the point: it is listed, so the archive does carry
  // it, and asking for the core still returns only the core. Nothing walks the
  // archive deciding where to write, so the name is inert.
  assert.ok(listZipEntries(archive(MULTI)).includes("../../evil.so"));
  const contents = extractZipEntry(archive(MULTI), CORE_NAME);
  assert.equal(contents.toString("utf8"), BODY);
});

test("lists every entry", () => {
  assert.deepEqual(listZipEntries(archive(MULTI)), [
    "../../evil.so",
    CORE_NAME,
    "readme.txt",
  ]);
});

test("reports a missing entry by name, and what was there instead", () => {
  assert.throws(
    () => extractZipEntry(archive(DEFLATED), "snes9x_libretro.so"),
    (error: unknown) => {
      assert.ok(error instanceof ZipError);
      assert.match(error.message, /snes9x_libretro\.so/);
      assert.match(error.message, /test_libretro\.so/);
      return true;
    },
  );
});

test("rejects something that is not a zip at all", () => {
  assert.throws(
    () =>
      extractZipEntry(Buffer.from("<!DOCTYPE html><h1>404</h1>"), CORE_NAME),
    ZipError,
  );
});

test("rejects an empty response", () => {
  assert.throws(() => extractZipEntry(Buffer.alloc(0), CORE_NAME), ZipError);
});

test("rejects an archive whose contents do not match their checksum", () => {
  const corrupt = archive(STORED);
  // Stored, so the payload sits verbatim after the local header and a single
  // flipped byte survives to the checksum rather than failing to inflate.
  const at = corrupt.indexOf(Buffer.from("core payload"));
  assert.ok(at > 0);
  corrupt[at] = corrupt[at] ^ 0xff;
  assert.throws(() => extractZipEntry(corrupt, CORE_NAME), /checksum/);
});

test("rejects a truncated archive", () => {
  const whole = archive(DEFLATED);
  // Keep the trailing records so the directory still parses, and cut the file
  // data the local header points at.
  const truncated = Buffer.concat([
    whole.subarray(0, 40),
    whole.subarray(whole.length - 60),
  ]);
  assert.throws(() => extractZipEntry(truncated, CORE_NAME), ZipError);
});
