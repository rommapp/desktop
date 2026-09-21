import assert from "node:assert/strict";
import { test } from "node:test";
import { isOnLoginPage, isSignedOut, SIGNED_OUT_MESSAGE } from "./status.ts";

test("only a 401 means the session is gone", () => {
  assert.equal(isSignedOut(401), true);
  // RomM answers 403 to a user it knows and whose scope falls short, so a
  // viewer without the save write scope must not be told to sign in again.
  assert.equal(isSignedOut(403), false);
  assert.equal(isSignedOut(200), false);
  assert.equal(isSignedOut(404), false);
  assert.equal(isSignedOut(409), false);
  assert.equal(isSignedOut(500), false);
});

test("the message tells the player what to do about it", () => {
  assert.match(SIGNED_OUT_MESSAGE, /sign in again/i);
});

test("the login page is recognised however it is spelled", () => {
  assert.equal(isOnLoginPage("https://romm.example.com/login"), true);
  assert.equal(isOnLoginPage("https://romm.example.com/login/"), true);
  // A query is where RomM puts the page to return to afterwards.
  assert.equal(
    isOnLoginPage("https://romm.example.com/login?next=/rom/1"),
    true,
  );
});

test("anything else is a page worth reloading", () => {
  assert.equal(isOnLoginPage("https://romm.example.com/"), false);
  assert.equal(isOnLoginPage("https://romm.example.com/rom/1"), false);
  // Not a prefix match: a different page whose name starts the same way.
  assert.equal(isOnLoginPage("https://romm.example.com/login-help"), false);
  assert.equal(isOnLoginPage("https://romm.example.com/settings/login"), false);
});

test("something that is not a URL is not the login page", () => {
  assert.equal(isOnLoginPage(""), false);
  assert.equal(isOnLoginPage("about:blank"), false);
  assert.equal(isOnLoginPage("not a url"), false);
});
