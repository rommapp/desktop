// Screenshots use the same authenticated, CSRF-protected API path as saves.
// The gallery endpoint is separate from state thumbnails: a capture is its own
// asset, not a savestate that the shell has to manufacture to carry a picture.

import type { Session } from "electron";
import { apiRequest } from "../saves/http.ts";
import { multipartBody } from "../saves/multipart.ts";
import { pushScreenshots } from "./capture.ts";

export async function uploadScreenshots(options: {
  serverUrl: string;
  session: Session;
  romId: number;
  directory: string;
  signal: AbortSignal;
}): Promise<void> {
  const { serverUrl, session, romId, directory, signal } = options;
  try {
    const result = await pushScreenshots({
      directory,
      signal,
      upload: async ({ fileName, bytes }) => {
        const body = multipartBody([{ field: "screenshotFile", fileName, bytes }]);
        const response = await apiRequest({
          serverUrl,
          session,
          path: `/api/screenshots?rom_id=${romId}`,
          method: "POST",
          headers: { "content-type": body.contentType },
          body: body.body,
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        });
        return Boolean(response && response.status >= 200 && response.status < 300);
      },
    });
    console.info(`[screenshots] rom ${romId}: ${result.uploaded} uploaded, ${result.failed} failed; local captures in ${directory}`);
  } catch (error) {
    console.warn(`[screenshots] rom ${romId}: upload failed; local captures in ${directory}`, error);
  }
}
