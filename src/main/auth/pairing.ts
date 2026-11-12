// Device authorization is kept independent of Electron: the server controls the
// poll cadence, but never gets to choose a foreign approval URL or unbounded
// lifetime. Only the public approval code is shown; the polling secret stays in
// this process until it is exchanged once for an account-bound client token.

export const DEVICE_SCOPES = [
  "me.read", "roms.read", "platforms.read", "assets.read", "assets.write",
  "devices.read", "devices.write", "firmware.read", "roms.user.write",
] as const;

export const DEVICE_CAPABILITIES = {
  save_sync: true, state_sync: true, screenshots: true,
  play_sessions: true, remote_install: false,
};

export interface PairingRecord {
  server: string;
  userId: number;
  deviceId: string;
  tokenId: number;
  token: string;
  expiresAt: string | null;
}

type Reply = { status: number; body: unknown };
export type PairingRequest = (path: string, body: unknown) => Promise<Reply>;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error("Invalid pairing response.");
  return value as Record<string, unknown>;
}

export function readPairingRecord(value: unknown, server: string): PairingRecord {
  const row = object(value);
  if (row.server !== new URL(server).origin || !Number.isSafeInteger(row.userId) || (row.userId as number) < 1 ||
      !Number.isSafeInteger(row.tokenId) || (row.tokenId as number) < 1 ||
      typeof row.deviceId !== "string" || !row.deviceId || row.deviceId.length > 255 ||
      typeof row.token !== "string" || !/^rmm_[A-Za-z0-9_-]+$/.test(row.token) || row.token.length > 4096 ||
      (row.expiresAt !== null && (typeof row.expiresAt !== "string" || !Number.isFinite(Date.parse(row.expiresAt))))) {
    throw new Error("Invalid stored pairing.");
  }
  return row as unknown as PairingRecord;
}

export function mayUsePairing(cookieStatus: number, cookieUser: unknown, userId: number): boolean {
  if (cookieStatus === 401) return true;
  return cookieStatus === 200 && cookieUser !== null && typeof cookieUser === "object" &&
    (cookieUser as { id?: unknown }).id === userId;
}

/** Limit the bearer to the configured server's API, including every redirect. */
export function pairedHeaders(
  url: string, server: string, token: string, headers: Record<string, string>,
): Record<string, string> | null {
  let target: URL;
  try {
    target = new URL(url);
    if (target.origin !== new URL(server).origin || !["http:", "https:"].includes(target.protocol) ||
        !target.pathname.startsWith("/api/") || target.username || target.password) return null;
  } catch { return null; }
  const result = Object.fromEntries(Object.entries(headers).filter(([key]) =>
    !["cookie", "authorization", "x-csrftoken"].includes(key.toLowerCase()),
  ));
  return { ...result, Authorization: `Bearer ${token}` };
}

export async function pairDevice(options: {
  server: string;
  metadata: Record<string, unknown>;
  request: PairingRequest;
  show: (code: string, url: string) => Promise<void>;
  pause: (ms: number) => Promise<void>;
  now: () => number;
  signal: AbortSignal;
}): Promise<Omit<PairingRecord, "userId">> {
  const { request, signal } = options;
  signal.throwIfAborted();
  const init = await request("/api/auth/device/init", { ...options.metadata, requested_scopes: DEVICE_SCOPES });
  if (init.status !== 201) throw new Error(`Pairing could not start (HTTP ${init.status}).`);
  const row = object(init.body);
  if (typeof row.device_code !== "string" || !/^[a-f0-9]{64}$/.test(row.device_code) ||
      typeof row.user_code !== "string" || !/^[A-Z0-9]{8}$/.test(row.user_code) ||
      !Number.isInteger(row.expires_in) || (row.expires_in as number) < 1 || (row.expires_in as number) > 600 ||
      !Number.isInteger(row.interval) || (row.interval as number) < 1 || (row.interval as number) > 60) {
    throw new Error("Invalid pairing challenge.");
  }
  // Construct the route ourselves. No server-provided URL is opened externally.
  const server = new URL(options.server).origin;
  const approval = new URL("/pair/device", server);
  approval.searchParams.set("user_code", row.user_code);
  const deadline = options.now() + (row.expires_in as number) * 1000;
  let interval = (row.interval as number) * 1000;
  await options.show(row.user_code, approval.toString());
  while (options.now() < deadline) {
    await options.pause(Math.min(interval, deadline - options.now()));
    signal.throwIfAborted();
    if (options.now() >= deadline) break;
    const reply = await request("/api/auth/device/token", { device_code: row.device_code });
    if (reply.status === 429) { interval += 5000; continue; }
    const data = object(reply.body);
    if (reply.status === 200) {
      const record = readPairingRecord({
        server, userId: 1, deviceId: data.device_id, tokenId: data.id,
        token: data.access_token, expiresAt: data.expires_at,
      }, server);
      const { userId: _userId, ...result } = record;
      void _userId;
      return result;
    }
    if (reply.status === 400 && data.detail === "authorization_pending") continue;
    if (reply.status === 400 && data.detail === "slow_down") { interval += 5000; continue; }
    if (data.detail === "access_denied") throw new Error("Pairing was denied in RomM.");
    if (data.detail === "expired_token") break;
    throw new Error(`Pairing failed (HTTP ${reply.status}).`);
  }
  throw new Error("Pairing code expired. Start pairing again.");
}
