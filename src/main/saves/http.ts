// Talking to RomM's API for the two things save sync has to do that a plain
// download does not: send a body, and prove the request is not cross-site.
//
// Electron's `net.request` is what the ROM and firmware downloads use, but it
// hands back a stream and takes no body, so the JSON and multipart calls here go
// through the session's own `fetch` instead -- the same session, so the same
// authentication either way, with no credential ever passing through this code.
//
// Nothing here throws except on a cancel. "Could not ask" is a value: the caller
// decides what it means, and for save sync it always means the same thing, which
// is to leave the local file alone.

import { type Session } from "electron";
import { noteSignedOut } from "../auth/recover.ts";
import { resolveDownloadUrl } from "../safety.ts";

/** The cookie the server's CSRF middleware double-submits against. */
const CSRF_COOKIE = "romm_csrftoken";

/** The header it reads that value back from. */
const CSRF_HEADER = "x-csrftoken";

/**
 * A path that answers without authentication and warms the CSRF cookie.
 *
 * Every response from the middleware carries a `romm_csrftoken` cookie when the
 * request did not already have one for this user, so any endpoint would do. The
 * heartbeat is used because it is the cheapest, and because nothing in the
 * response is parsed.
 */
const WARMING_PATH = "/api/heartbeat";

export interface ApiResponse {
  status: number;
  /** The parsed JSON body, or null when the body was not JSON. */
  body: unknown;
}

export interface ApiRequest {
  serverUrl: string;
  session: Session;
  /** Path and query, starting at `/api/`. */
  path: string;
  method: "GET" | "POST" | "PUT";
  body?: BodyInit;
  headers?: Record<string, string>;
  signal: AbortSignal;
}

/**
 * The CSRF token this session's cookie currently holds.
 *
 * The cookie is not httpOnly, which is what lets the value be read here at all:
 * the check is a double submit, so the header has to carry a copy of what the
 * browser is already sending.
 *
 * The middleware binds the token to the user it was minted for, so a token left
 * over from before this user signed in will not verify. That is not worth
 * detecting: it fails identically to a missing one, which is to say a 403, and
 * the caller treats a 403 like any other failure.
 */
async function csrfToken(
  serverUrl: string,
  session: Session,
  signal: AbortSignal,
): Promise<string | null> {
  let origin: string;
  try {
    origin = resolveDownloadUrl(serverUrl, WARMING_PATH).toString();
  } catch {
    return null;
  }

  // Prefer the path the server sets. A duplicate name on another path would
  // otherwise be as likely to be picked, and the server reads only one of them.
  const read = async (): Promise<string | null> => {
    const cookies = await session.cookies
      .get({ url: origin, name: CSRF_COOKIE })
      .catch(() => []);
    const root = cookies.find((cookie) => cookie.path === "/");
    return (root ?? cookies[0])?.value ?? null;
  };

  const existing = await read();
  if (existing) return existing;

  // No cookie yet: ask for one. The answer is not looked at, only the
  // Set-Cookie riding on it.
  let url: URL;
  try {
    url = resolveDownloadUrl(serverUrl, WARMING_PATH);
  } catch {
    return null;
  }
  try {
    await session.fetch(url.toString(), { credentials: "include", signal });
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
  return read();
}

/**
 * Make one request, or report that it could not be made.
 *
 * `undefined` means no request happened: a path the shell is not allowed to
 * build, a network that is down, a server that closed the connection. A response
 * that arrived, whatever its status, comes back as itself -- a 409 and a 403 are
 * answers, and both are answers the caller acts on differently.
 */
export async function apiRequest({
  serverUrl,
  session,
  path,
  method,
  body,
  headers,
  signal,
}: ApiRequest): Promise<ApiResponse | undefined> {
  let url: URL;
  try {
    // On-origin and under /api/, or refused, exactly as the downloads are.
    url = resolveDownloadUrl(serverUrl, path);
  } catch {
    return undefined;
  }

  const token = await csrfToken(serverUrl, session, signal);

  try {
    const response = await session.fetch(url.toString(), {
      method,
      credentials: "include",
      // The URL was checked for being on-origin and under /api/, and following
      // a redirect would walk straight back out of that. A 307 or 308 keeps the
      // method and the body, so a POST forwarded off-origin would carry a save
      // file and the CSRF header with it. These are API endpoints: a redirect
      // from one is not something to chase quietly, and refusing reads here as
      // a server that did not answer, which every caller already handles.
      redirect: "error",
      signal,
      body,
      headers: {
        ...headers,
        // Only on a write: a GET is a safe method and the middleware never asks
        // it for one.
        ...(method === "POST" && token ? { [CSRF_HEADER]: token } : {}),
      },
    });

    noteSignedOut(serverUrl, response.status);

    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      // The CSRF failure is plain text, and so is anything a proxy in the middle
      // decides to say. The status is the part that carries meaning.
    }
    return { status: response.status, body: parsed };
  } catch (error) {
    // A cancel belongs to whoever asked for it and is re-thrown so the caller
    // can tell it apart from a server that said no.
    if (signal.aborted) throw error;
    return undefined;
  }
}
