// What a refusal from the server means for the session the shell is borrowing.
//
// The shell holds no credentials of its own. Every request it makes to RomM --
// the ROM download, the disc list, the firmware list, the save negotiation --
// rides on the `romm_session` cookie the window already has. So the one
// distinction it has to be able to draw is between a request refused
// because that cookie is gone and a request refused for any other reason: only
// the first is something the user can fix, and only the first is worth
// interrupting them for.
//
// RomM draws exactly that line, and says so. `_raise_auth_error` in
// `backend/decorators/auth.py` answers 401 when the caller has no valid
// credentials, "so it can redirect to login", and 403 when it is signed in but
// lacks the scope for this endpoint -- "an inline permission error, not a
// session problem". A viewer who cannot write saves gets 403 every launch, and
// sending them to a login page would be a lie.
//
// Free of Electron imports, the way window-policy.ts is, so the distinction can
// be tested on its own.

/**
 * Whether a status says the session is gone, rather than insufficient.
 *
 * Only 401. A 403 is an answer from a server that knows who is asking, so it is
 * left to the caller to treat as it already does.
 */
export function isSignedOut(status: number): boolean {
  return status === 401;
}

/** What a launch says when it stopped because nobody is signed in. Written for
 *  the player rather than the log: the fix is theirs, and it is one step. */
export const SIGNED_OUT_MESSAGE =
  "You have been signed out of RomM. Sign in again, then press Play.";

/** Where RomM's frontend sends an unauthenticated visit. */
const LOGIN_PATH = "/login";

/**
 * Whether a window is already showing the login page.
 *
 * Reloading one would be a flicker that tells the user nothing they are not
 * already looking at, and it is the one page a sign-out can be observed from
 * repeatedly -- a queued report retrying against a server that still will not
 * have it.
 */
export function isOnLoginPage(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/\/$/, "") === LOGIN_PATH;
  } catch {
    return false;
  }
}
