// This machine's identity in the user's RomM device list.
//
// RomM pairs a save with the device that last synced it, and decides whether a
// push would clobber someone else's progress by comparing against that pairing.
// So there has to be a device, and it has to be the same device across launches:
// a fresh id every time would mean no baselines, and no baselines means a
// negotiation that falls back to comparing timestamps, which is the case the
// pull's archival step exists to survive rather than a case worth inviting.
//
// Registering is idempotent. The id is kept in the config file, so this asks the
// server once per machine rather than once per launch, and a re-registration
// after the config is cleared returns the same device rather than a second one.

import { app, type Session } from "electron";
import { hostname, platform } from "node:os";
import { type DesktopConfig } from "../../shared/types.ts";
import { updateConfig } from "../config.ts";
import { untilSettledOrCancelled } from "../firmware/queue.ts";
import { apiRequest } from "./http.ts";

/** What the device row says about this machine. */
export interface HostFacts {
  name: string;
  platform: string;
  hostname: string;
}

/**
 * How this machine should read in the RomM device list.
 *
 * The identity the server fingerprints on is deliberately only the hostname and
 * the platform. A MAC address would fingerprint better in principle, but which
 * interface is "first" changes with what is plugged in and what is switched on,
 * and a fingerprint that moves is a second device row with a second set of
 * baselines, which is a worse outcome than two machines sharing a name.
 */
export function hostFacts(): HostFacts {
  const host = hostname();
  return {
    name: `RomM Desktop on ${host}`,
    platform: platform(),
    hostname: host,
  };
}

export interface DeviceOptions {
  config: DesktopConfig;
  session: Session;
  signal: AbortSignal;
}

/**
 * The device id to sync as, registering this machine if it has not been.
 *
 * Returns null when there is no id and one could not be obtained, which leaves
 * the caller with nothing to sync as. That is not fatal: it means no save moves
 * this launch, exactly as if the server had been unreachable.
 */
/** A registration in flight, if one is. */
let registering: Promise<string | null> | null = null;

/**
 * The signal the shared registration runs under, which is to say none.
 *
 * Registering is the machine's business rather than any one launch's: the id it
 * produces is written to the config and is what every later launch syncs as. A
 * launch that walks away from it should not take it down for the launch beside
 * it, or for the next one.
 */
const OUTLIVES_ANY_LAUNCH = new AbortController().signal;

export function ensureDeviceId(options: DeviceOptions): Promise<string | null> {
  if (options.config.deviceId) return Promise.resolve(options.config.deviceId);

  // Shared between callers rather than queued behind each other. Two games
  // started at once on a machine that has never registered both arrive here,
  // and the config each was handed still says null -- so taking turns would be
  // the same two requests in order rather than one. RomM does dedupe on the
  // fingerprint, but two requests that both miss that lookup are the server
  // racing itself, and one request cannot.
  const shared = (registering ??= register({
    ...options,
    signal: OUTLIVES_ANY_LAUNCH,
  })
    // Never rejects: this promise has more than one caller, and a failure is
    // an absence of an id rather than something to throw at all of them.
    .catch(() => null)
    // Cleared once it settles, so a failure is not remembered as an answer.
    .finally(() => {
      registering = null;
    }));

  // The waiting is this launch's to abandon, the request is not. A launch
  // cancelled while queued behind someone else's registration stops waiting
  // here and reads as cancelled, and the registration carries on to be
  // persisted for whoever asks next.
  return untilSettledOrCancelled(shared, options.signal);
}

async function register({
  config,
  session,
  signal,
}: DeviceOptions): Promise<string | null> {
  const response = await apiRequest({
    serverUrl: config.serverUrl ?? "",
    session,
    path: "/api/devices",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...hostFacts(),
      // A short slug rather than a display name: RomM's activity feed reads this
      // field as the device type, and anything it does not recognize is shown as
      // "unknown".
      client: "desktop",
      client_version: app.getVersion(),
    }),
    signal,
  });
  if (!response || response.status >= 300) return null;

  const id = deviceIdFrom(response.body);
  if (!id) return null;

  // Persisted so the next launch skips this, and so the device the server
  // remembers is the device this machine keeps syncing as.
  await updateConfig({ deviceId: id }).catch(() => {});
  return id;
}

/**
 * Drop the remembered device id.
 *
 * For the server saying it does not know this device any more: the row was
 * deleted from the device list, or the database was restored without it. The
 * next registration then mints a new one, which starts with no baselines and
 * therefore negotiates conservatively, which is the safe direction to recover in.
 */
export async function forgetDeviceId(): Promise<void> {
  await updateConfig({ deviceId: null }).catch(() => {});
}

/** The `device_id` out of a registration response, if it is the shape expected. */
function deviceIdFrom(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const id = (body as { device_id?: unknown }).device_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}
