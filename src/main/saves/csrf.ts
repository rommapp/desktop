// Proving a request is not cross-site.
//
// RomM's middleware is a double submit: the cookie it sets has to come back in
// a header on anything it does not consider a safe method. Getting that wrong
// is refused with a 403, which reads like a permission problem and is not one,
// so the rule lives here on its own rather than inline in a fetch nothing can
// load without Electron.

/** The cookie the server's CSRF middleware double-submits against. */
export const CSRF_COOKIE = "romm_csrftoken";

/** The header it reads that value back from. */
export const CSRF_HEADER = "x-csrftoken";

/** What the middleware lets through unchallenged, taken from its own set
 *  rather than assumed from the methods the shell happens to send. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);

/** The CSRF header a request carries, if any. */
export function csrfHeaders(
  method: string,
  token: string | null,
): Record<string, string> {
  return token && !SAFE_METHODS.has(method) ? { [CSRF_HEADER]: token } : {};
}
