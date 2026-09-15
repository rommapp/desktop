import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyNavigation,
  isAuthEndpoint,
  isAuthFlowComplete,
  type PermissionDetails,
  isServerOrigin,
  shouldGrantPermission,
} from "./window-policy.ts";

const SERVER = "https://romm.example.com";
const IDP = "https://login.microsoftonline.com";

test("isServerOrigin ignores the path and query", () => {
  assert.equal(isServerOrigin(`${SERVER}/roms/7?q=a`, SERVER), true);
});

test("isServerOrigin separates ports and schemes", () => {
  assert.equal(isServerOrigin("https://romm.example.com:8443/", SERVER), false);
  assert.equal(isServerOrigin("http://romm.example.com/", SERVER), false);
});

test("isServerOrigin rejects a host that merely ends with the server's", () => {
  assert.equal(isServerOrigin("https://evil-romm.example.com/", SERVER), false);
});

test("isServerOrigin rejects a malformed URL rather than throwing", () => {
  assert.equal(isServerOrigin("not a url", SERVER), false);
  assert.equal(isServerOrigin(SERVER, "not a url"), false);
});

test("isAuthEndpoint recognises RomM's OIDC routes", () => {
  assert.equal(isAuthEndpoint(`${SERVER}/api/login/openid`, SERVER), true);
  assert.equal(
    isAuthEndpoint(`${SERVER}/api/oauth/openid?code=abc&state=xyz`, SERVER),
    true,
  );
});

test("isAuthEndpoint ignores a trailing slash the backend would redirect", () => {
  assert.equal(isAuthEndpoint(`${SERVER}/api/login/openid/`, SERVER), true);
});

test("isAuthEndpoint does not match an auth path on another origin", () => {
  assert.equal(isAuthEndpoint(`${IDP}/api/login/openid`, SERVER), false);
});

test("isAuthEndpoint does not match an ordinary API route", () => {
  assert.equal(isAuthEndpoint(`${SERVER}/api/roms/7`, SERVER), false);
  assert.equal(isAuthEndpoint(`${SERVER}/api/login/openid/extra`, SERVER), false);
});

test("classifyNavigation keeps ordinary server pages in the window", () => {
  assert.equal(classifyNavigation(`${SERVER}/roms/7`, SERVER), "in-window");
});

test("classifyNavigation sends the OIDC hand-off to an auth window", () => {
  // The regression this exists for: RomM opens this URL same-origin, the
  // server redirects it to the provider, and the provider's own login form
  // then has nowhere to post that keeps the cookie in this session.
  assert.equal(
    classifyNavigation(`${SERVER}/api/login/openid`, SERVER),
    "auth-window",
  );
  assert.equal(
    classifyNavigation(`${SERVER}/api/oauth/openid?code=abc`, SERVER),
    "auth-window",
  );
});

test("classifyNavigation hands an off-origin link to the browser", () => {
  assert.equal(
    classifyNavigation("https://www.igdb.com/games/chrono-trigger", SERVER),
    "external",
  );
  assert.equal(classifyNavigation("mailto:someone@example.com", SERVER), "external");
});

test("classifyNavigation blocks a scheme we would not open", () => {
  assert.equal(classifyNavigation("file:///etc/passwd", SERVER), "blocked");
  assert.equal(classifyNavigation("javascript:alert(1)", SERVER), "blocked");
  assert.equal(classifyNavigation("not a url", SERVER), "blocked");
});

test("isAuthFlowComplete waits for the redirect that follows the callback", () => {
  // The callback is on the server origin but is still mid-flow: its response
  // is what establishes the session.
  assert.equal(
    isAuthFlowComplete(`${SERVER}/api/oauth/openid?code=abc`, SERVER),
    false,
  );
  assert.equal(isAuthFlowComplete(`${SERVER}/`, SERVER), true);
});

test("isAuthFlowComplete stays false while the provider has the flow", () => {
  assert.equal(isAuthFlowComplete(`${IDP}/common/oauth2/authorize`, SERVER), false);
});

/** A media request as Electron reports one, with the page itself asking. */
function cameraRequest(
  over: Partial<PermissionDetails> = {},
): PermissionDetails {
  return {
    requestingUrl: `${SERVER}/roms/7`,
    isMainFrame: true,
    securityOrigin: SERVER,
    mediaTypes: ["video"],
    ...over,
  };
}

test("shouldGrantPermission still allows what a player needs", () => {
  const details = cameraRequest();
  assert.equal(shouldGrantPermission("fullscreen", details, SERVER), true);
  assert.equal(shouldGrantPermission("pointerLock", details, SERVER), true);
});

test("shouldGrantPermission allows the barcode scanner's camera", () => {
  assert.equal(shouldGrantPermission("media", cameraRequest(), SERVER), true);
});

test("shouldGrantPermission accepts a securityOrigin with a trailing slash", () => {
  assert.equal(
    shouldGrantPermission(
      "media",
      cameraRequest({ securityOrigin: `${SERVER}/` }),
      SERVER,
    ),
    true,
  );
});

test("shouldGrantPermission falls back to requestingUrl for the origin", () => {
  assert.equal(
    shouldGrantPermission(
      "media",
      cameraRequest({ securityOrigin: undefined }),
      SERVER,
    ),
    true,
  );
  assert.equal(
    shouldGrantPermission(
      "media",
      cameraRequest({
        securityOrigin: undefined,
        requestingUrl: `${IDP}/authorize`,
      }),
      SERVER,
    ),
    false,
  );
});

test("shouldGrantPermission refuses the camera to a third-party origin", () => {
  assert.equal(
    shouldGrantPermission(
      "media",
      cameraRequest({
        securityOrigin: "https://images.igdb.com",
        requestingUrl: "https://images.igdb.com/frame",
      }),
      SERVER,
    ),
    false,
  );
});

test("shouldGrantPermission refuses the camera to a nested frame", () => {
  assert.equal(
    shouldGrantPermission("media", cameraRequest({ isMainFrame: false }), SERVER),
    false,
  );
});

test("shouldGrantPermission refuses the microphone", () => {
  assert.equal(
    shouldGrantPermission("media", cameraRequest({ mediaTypes: ["audio"] }), SERVER),
    false,
  );
  assert.equal(
    shouldGrantPermission(
      "media",
      cameraRequest({ mediaTypes: ["video", "audio"] }),
      SERVER,
    ),
    false,
  );
});

test("shouldGrantPermission refuses a device it does not recognise", () => {
  // Matched exactly rather than by excluding audio, so a type a later Electron
  // introduces cannot ride along with video.
  assert.equal(
    shouldGrantPermission(
      "media",
      cameraRequest({ mediaTypes: ["video", "something-new"] }),
      SERVER,
    ),
    false,
  );
  assert.equal(
    shouldGrantPermission(
      "media",
      cameraRequest({ mediaTypes: ["something-new"] }),
      SERVER,
    ),
    false,
  );
});

test("shouldGrantPermission refuses a media request it cannot inspect", () => {
  assert.equal(
    shouldGrantPermission("media", cameraRequest({ mediaTypes: undefined }), SERVER),
    false,
  );
  assert.equal(
    shouldGrantPermission("media", cameraRequest({ mediaTypes: [] }), SERVER),
    false,
  );
});

test("shouldGrantPermission denies everything else, server origin included", () => {
  for (const permission of [
    "geolocation",
    "notifications",
    "midi",
    "clipboard-read",
    "openExternal",
    "display-capture",
  ]) {
    assert.equal(
      shouldGrantPermission(permission, cameraRequest(), SERVER),
      false,
      permission,
    );
  }
});

test("classifyNavigation follows an http address upgraded to https", () => {
  // A proxy in front of the server answers the first load with this, and
  // sending it to the browser would empty the window before it drew anything.
  assert.equal(
    classifyNavigation("https://romm.example.com/", "http://romm.example.com"),
    "in-window",
  );
  assert.equal(
    classifyNavigation(
      "https://romm.example.com:8080/",
      "http://romm.example.com:8080",
    ),
    "in-window",
  );
});

test("classifyNavigation does not follow https back down to http", () => {
  assert.equal(
    classifyNavigation("http://romm.example.com/", SERVER),
    "external",
  );
});

test("classifyNavigation upgrades only the same host and port", () => {
  assert.equal(
    classifyNavigation("https://other.example.com/", "http://romm.example.com"),
    "external",
  );
  assert.equal(
    classifyNavigation(
      "https://romm.example.com:8443/",
      "http://romm.example.com",
    ),
    "external",
  );
});

test("classifyNavigation still reaches the auth window over an upgrade", () => {
  assert.equal(
    classifyNavigation(
      "https://romm.example.com/api/login/openid",
      "http://romm.example.com",
    ),
    "auth-window",
  );
});
