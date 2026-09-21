import assert from "node:assert/strict";
import { test } from "node:test";

import { csrfHeaders } from "./csrf.ts";

test("every method the server challenges carries the token", () => {
  // The middleware's safe set is GET, HEAD, OPTIONS and TRACE; everything else
  // is refused without a token, with a 403 that reads like a permission
  // problem and is not one.
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.deepEqual(
      csrfHeaders(method, "token"),
      { "x-csrftoken": "token" },
      method,
    );
  }
});

test("a safe method sends nothing, and neither does a request with no token", () => {
  for (const method of ["GET", "HEAD", "OPTIONS", "TRACE"]) {
    assert.deepEqual(csrfHeaders(method, "token"), {}, method);
  }
  assert.deepEqual(csrfHeaders("POST", null), {});
});
