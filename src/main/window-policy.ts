// The navigation and permission rules for the shell's windows. Deliberately
// free of Electron imports, the way safety.ts is, so each decision can be
// tested on its own: this module decides, window.ts only wires the decisions
// to the events that ask for them.

/** Schemes we are willing to hand to the user's browser or shell. */
const EXTERNAL_SCHEMES = new Set(["https:", "http:", "mailto:"]);

/**
 * RomM's own OIDC endpoints, as `backend/endpoints/auth.py` routes them:
 * `/api/login/openid` answers with a redirect to your identity provider, and
 * `/api/oauth/openid` is the address the provider sends you back to, which
 * establishes the session and then redirects to `/`.
 *
 * Both sit on the server origin, so neither is what the confinement below
 * would otherwise stop. They are named here because the hop *out* of the first
 * one is: recognising the flow at its start is what lets the whole excursion
 * happen somewhere it is allowed to finish.
 */
const AUTH_PATHS = new Set(["/api/login/openid", "/api/oauth/openid"]);

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Whether a URL is the same server reached over TLS, when the configured
 * address was plain http.
 *
 * A server behind a proxy that redirects http to https answers the very first
 * load with one of these, and treating it as a foreign origin would empty the
 * window and open a browser before the app had drawn anything. The host and
 * port have to be identical, and the direction is one way -- an https address
 * is never followed back down to http.
 */
function isSecureUpgrade(target: URL, server: URL): boolean {
  return (
    server.protocol === "http:" &&
    target.protocol === "https:" &&
    target.hostname === server.hostname &&
    target.port === server.port
  );
}

/**
 * Whether a URL belongs to the RomM server this shell is bound to.
 *
 * The configured origin, or that origin upgraded to https, and nothing else:
 * a port, a scheme or a host that differs any other way is a different server,
 * and a host that merely ends with the configured one is a different party.
 */
export function isServerOrigin(url: string, serverUrl: string): boolean {
  const target = parse(url);
  const server = parse(serverUrl);
  if (target === null || server === null) return false;
  return target.origin === server.origin || isSecureUpgrade(target, server);
}

/** Whether a URL is one of RomM's auth endpoints on the bound server. A path
 *  is matched without its trailing slash, which the backend redirects anyway. */
export function isAuthEndpoint(url: string, serverUrl: string): boolean {
  if (!isServerOrigin(url, serverUrl)) return false;
  const { pathname } = parse(url) as URL;
  return AUTH_PATHS.has(pathname.replace(/\/$/, ""));
}

/** Where a navigation the main window asks for should actually go. */
export type NavigationTarget =
  | "in-window"
  | "auth-window"
  | "external"
  | "blocked";

/**
 * Decide a navigation for the main window.
 *
 * The server's own pages stay in-window, as before, with one exception: an
 * auth endpoint is the start of a flow that has to leave the origin to work,
 * so it goes to a window that permits that rather than to one that will
 * strand it. Everything else off-origin is still handed to the user's browser,
 * and a URL that is not a scheme we would open is not opened at all.
 */
export function classifyNavigation(
  url: string,
  serverUrl: string,
): NavigationTarget {
  const target = parse(url);
  if (target === null) return "blocked";
  if (isServerOrigin(url, serverUrl)) {
    return isAuthEndpoint(url, serverUrl) ? "auth-window" : "in-window";
  }
  return EXTERNAL_SCHEMES.has(target.protocol) ? "external" : "blocked";
}

/**
 * Whether an auth window has arrived back where it started and can be closed.
 *
 * Complete means the server's origin at anything but an auth endpoint. The
 * callback endpoint is on that origin too, and stopping there would cut the
 * flow off one hop early: it is the response to *that* request which
 * establishes the session, and the redirect it answers with is the first URL
 * that means the login is done.
 */
export function isAuthFlowComplete(url: string, serverUrl: string): boolean {
  return isServerOrigin(url, serverUrl) && !isAuthEndpoint(url, serverUrl);
}

/** The subset of Electron's permission-request details this policy reads.
 *  Every variant of that union extends PermissionRequest, so the first two are
 *  always there and the media-specific two only for a media request. */
export interface PermissionDetails {
  /** The last URL the requesting frame loaded. */
  requestingUrl: string;
  /** Whether the frame asking is the page's top-level one. */
  isMainFrame: boolean;
  /** Origin of the request, which Electron reports for a media request. */
  securityOrigin?: string;
  /** Which devices a `media` request wants. */
  mediaTypes?: readonly string[];
}

/**
 * Whether to grant a permission the page has asked for.
 *
 * Fullscreen and pointer lock are what a player needs and carry nothing with
 * them. The camera is different: RomM scans a physical game's barcode with
 * `getUserMedia`, so the feature cannot work without it, but the same window
 * renders artwork and descriptions from third-party metadata providers. So it
 * is granted on three conditions, all of which the scanner meets and none of
 * which a piece of embedded metadata does:
 *
 * - The server's own origin is asking. `securityOrigin` is what Electron
 *   reports for a media request; `requestingUrl` is on every request and says
 *   the same thing, so it stands in should the first ever be absent.
 * - The top-level frame is asking, so a nested one cannot reach the camera
 *   even on an origin that could.
 * - Video is the only thing wanted, and the only thing named. The scanner asks
 *   for `{ video: { facingMode: "environment" } }`, so anything else in the
 *   list -- the microphone, or a device type a later Electron introduces --
 *   makes this a request other than the one this exists for. Matched exactly
 *   rather than by excluding audio, so a device nobody here has heard of is
 *   refused by default instead of riding along with video.
 */
export function shouldGrantPermission(
  permission: string,
  details: PermissionDetails,
  serverUrl: string,
): boolean {
  if (permission === "fullscreen" || permission === "pointerLock") return true;
  if (permission !== "media") return false;

  if (!details.isMainFrame) return false;
  if (
    !isServerOrigin(details.securityOrigin ?? details.requestingUrl, serverUrl)
  )
    return false;

  const devices = details.mediaTypes;
  return devices !== undefined && devices.length === 1 && devices[0] === "video";
}
