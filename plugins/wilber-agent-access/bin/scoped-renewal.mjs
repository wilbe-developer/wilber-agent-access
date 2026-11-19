import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { createServer } from "node:net";

const accessPattern = /^wb_agent_[A-Za-z0-9_-]{43,128}$/;
const refreshPattern = /^wb_refresh_[A-Za-z0-9_-]{43,128}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const failure = (message, code, status) => Object.assign(new Error(message), { code, status });

// A loopback bind acts only as a cross-process mutex, with no request API.
// Unlike lock files it is released by the kernel even if a process crashes.
// Aliases of the same store share one identity. A hash collision or another
// local service can cause a busy error; never pick a second port and lose
// mutual exclusion. This service receives and returns no credential data.
async function withCredentialLock(directory, operation) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let canonical = await realpath(directory);
  if (process.platform === "win32") canonical = canonical.toLowerCase();
  const port = 49152 + createHash("sha256").update(`wilber-connection-renewal:${canonical}`).digest().readUInt16BE(0) % 16384;
  const deadline = Date.now() + 30_000;
  let lock;
  while (!lock) {
    const server = createServer(socket => socket.destroy());
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
      });
      lock = server;
    } catch (error) {
      server.close();
      if (error.code !== "EADDRINUSE") throw failure("Wilber could not coordinate connection renewal on this device.", "connection_renewal_lock_unavailable");
      if (Date.now() >= deadline) throw failure("Wilber connection renewal is busy on this device. Another task or local service may be using its coordination port. Try again shortly.", "connection_renewal_busy");
      await pause(50);
    }
  }
  try { return await operation(); }
  finally { await new Promise(resolve => lock.close(resolve)); }
}

export async function renewScopedCredential({ credential, directory, readCredential, saveCredential, endpoint, forceRefresh = false }) {
  if (credential.refreshToken && !credential.pendingRenewal && !forceRefresh &&
      accessPattern.test(credential.accessToken || "") && refreshPattern.test(credential.refreshToken) &&
      Date.parse(credential.expiresAt) > Date.now() + 60_000 && Date.parse(credential.refreshExpiresAt) > Date.now()) return credential;
  let recoveryRotations = 0;
  return withCredentialLock(directory, async function renewLocked() {
    const stored = await readCredential();
    if (!stored || stored.kind !== "scoped" || stored.endpoint !== endpoint) {
      throw failure("Your Wilber connection changed. Try again with the current connection.", "connection_changed");
    }
    let current = stored;
    const now = Date.now();
    const expires = Date.parse(current.expiresAt);
    if (!accessPattern.test(current.accessToken || "") || !Number.isFinite(expires)) {
      throw failure("This Wilber connection needs a fresh sign-in.", "connection_invalid", 401);
    }
    const changed = credential.accessToken !== current.accessToken;
    if (current.refreshToken && !current.pendingRenewal && expires > now + 60_000 && (!forceRefresh || changed)) return current;
    if (current.refreshToken && (!refreshPattern.test(current.refreshToken) || (Date.parse(current.refreshExpiresAt) <= now && !current.pendingRenewal) || !Number.isFinite(Date.parse(current.refreshExpiresAt)))) {
      throw failure(`Your Wilber connection is no longer active. Run wilber auth login --audience ${current.audience} to reconnect.`, "connection_expired", 401);
    }

    // Persist the proposed replacement before sending it. If the response is
    // lost, the next process retries this exact rotation and can recover safely.
    if (!current.pendingRenewal) {
      current = { ...current, pendingRenewal: {
        rotationId: randomUUID(),
        accessToken: `wb_agent_${randomBytes(32).toString("hex")}`,
        refreshToken: `wb_refresh_${randomBytes(32).toString("hex")}`,
      } };
      await saveCredential(current);
    }
    const pending = current.pendingRenewal;
    if (!uuidPattern.test(pending.rotationId || "") || !accessPattern.test(pending.accessToken || "") || !refreshPattern.test(pending.refreshToken || "")) {
      throw failure("This Wilber connection needs a fresh sign-in.", "connection_invalid", 401);
    }
    const api = new URL("/api/wilber/agent-connection", new URL(endpoint).origin);
    let response;
    try {
      response = await fetch(api, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "renew", credential: current.refreshToken || current.accessToken,
          access_token: pending.accessToken, refresh_token: pending.refreshToken, rotation_id: pending.rotationId }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw failure("Wilber could not confirm connection renewal. Try again; your saved renewal will be recovered automatically.", "connection_renewal_pending");
    }
    // Backend-first rollout: an older server can still use an unexpired legacy
    // credential. Never downgrade a renewable credential or an uncertain result.
    if ([400, 404, 405].includes(response.status) && !current.refreshToken) {
      if (expires <= now) throw failure(`Your Wilber connection has expired. Run wilber auth login --audience ${current.audience} to reconnect.`, "connection_expired", 401);
      const { pendingRenewal, ...legacy } = current;
      await saveCredential(legacy);
      return legacy;
    }
    if (!response.ok) {
      if ([401, 403].includes(response.status)) throw failure(`Your Wilber connection is no longer active. Run wilber auth login --audience ${current.audience} to reconnect.`, "connection_expired", response.status);
      throw failure("Wilber could not confirm connection renewal. Try again; your saved renewal will be recovered automatically.", "connection_renewal_pending", response.status);
    }
    let result;
    try { result = await response.json(); } catch { throw failure("Wilber could not confirm connection renewal. Try again to recover it.", "connection_renewal_pending"); }
    if (result.connection_id !== current.connectionId || result.audience !== current.audience ||
        !Array.isArray(result.permissions) || !Number.isFinite(Date.parse(result.expires_at)) ||
        !Number.isFinite(Date.parse(result.refresh_expires_at)) || Date.parse(result.refresh_expires_at) <= Date.parse(result.expires_at)) {
      throw failure("Wilber returned an invalid renewal response. Try again to recover the saved connection.", "connection_renewal_pending");
    }
    const { pendingRenewal, ...previous } = current;
    const renewed = { ...previous, accessToken: pending.accessToken, refreshToken: pending.refreshToken,
      expiresAt: result.expires_at, refreshExpiresAt: result.refresh_expires_at };
    await saveCredential(renewed);
    if (Date.parse(renewed.expiresAt) <= Date.now() + 60_000) {
      if (++recoveryRotations > 1) throw failure("Wilber could not confirm fresh connection access. Try again to recover it.", "connection_renewal_pending");
      return renewLocked();
    }
    return renewed;
  });
}
