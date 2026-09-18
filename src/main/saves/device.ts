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
export async function ensureDeviceId({
  config,
  session,
  signal,
}: DeviceOptions): Promise<string | null> {
  if (config.deviceId) return config.deviceId;

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
