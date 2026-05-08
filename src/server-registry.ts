import { getAvesStateDir } from "./paths.ts";

// ============================================================
// Server registry — manages a persistent HTTP server instance
// Uses mkdir-based atomic lock (cross-platform, no syscall deps)
// ============================================================

export interface ServerEndpoint {
  pid: number;
  transport: "http";
  host: string;
  port: number;
  started_at: string;
}

/**
 * SHA-256 hash of the scope (state dir path) for server isolation.
 */
async function getScopeHash(): Promise<string> {
  const scope = getAvesStateDir();
  const enc = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", enc.encode(scope));
  return Array.from(new Uint8Array(hash)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("").slice(0, 16);
}

/**
 * Directory for this scope's server registry files.
 */
export async function getServerDir(): Promise<string> {
  const hash = await getScopeHash();
  return `${getAvesStateDir()}/servers/${hash}`;
}

/**
 * Path to the endpoint.json file.
 */
export async function getEndpointPath(): Promise<string> {
  return `${await getServerDir()}/endpoint.json`;
}

/**
 * Path to the lock directory (used as atomic mkdir lock).
 */
export async function getLockDir(): Promise<string> {
  return `${await getServerDir()}/lock`;
}

/**
 * Path to PID file inside the lock dir.
 */
export async function getPidPath(): Promise<string> {
  return `${await getLockDir()}/pid`;
}

/**
 * Register the running server's endpoint info to disk.
 * The server dir must already exist (created by acquireLock).
 */
export async function registerEndpoint(
  endpoint: ServerEndpoint,
): Promise<void> {
  await Deno.writeTextFile(
    await getEndpointPath(),
    JSON.stringify(endpoint, null, 2),
  );
}

/**
 * Try to find a running server by reading endpoint.json and checking PID.
 */
export async function findRunningServer(): Promise<ServerEndpoint | null> {
  try {
    const raw = await Deno.readTextFile(await getEndpointPath());
    const endpoint: ServerEndpoint = JSON.parse(raw);

    // Check if the process is still alive (signal 0 = test existence)
    try {
      Deno.kill(endpoint.pid, 0);
      return endpoint;
    } catch {
      // Dead — clean up and return null
      await cleanupStaleRegistry();
      return null;
    }
  } catch {
    return null;
  }
}

/**
 * Try to acquire the server lock atomically using mkdir.
 * mkdir is atomic on all Unix filesystems and most Windows ones.
 *
 * On success: creates lock dir, stores PID, returns the lock dir path.
 * On failure (another server holds it): returns null if the other
 * server is alive; removes stale lock and returns "retry" signal.
 */
export async function acquireLock(): Promise<
  { ok: true } | { ok: false; reason: string }
> {
  const serverDir = await getServerDir();
  await Deno.mkdir(serverDir, { recursive: true });

  const lockDir = await getLockDir();

  try {
    // Atomic: mkdir fails atomically if the dir already exists
    await Deno.mkdir(lockDir);
  } catch {
    // Lock dir exists — check if the holder is alive
    const existing = await findRunningServer();
    if (existing) {
      return {
        ok: false,
        reason:
          `already running on ${existing.host}:${existing.port} (pid ${existing.pid})`,
      };
    }

    // Stale lock — remove and retry
    try {
      await Deno.remove(lockDir, { recursive: true });
    } catch {
      return { ok: false, reason: "stale lock present but cannot remove" };
    }

    // Retry once
    try {
      await Deno.mkdir(lockDir);
    } catch {
      return { ok: false, reason: "lock race lost on retry" };
    }
  }

  // We hold the lock — write PID
  await Deno.writeTextFile(await getPidPath(), String(Deno.pid));
  return { ok: true };
}

/**
 * Release the lock by removing the lock dir.
 */
export async function releaseLock(): Promise<void> {
  try {
    await Deno.remove(await getPidPath());
  } catch { /* no-op */ }
  try {
    await Deno.remove(await getLockDir());
  } catch { /* no-op */ }
}

/**
 * Clean up stale registry files (endpoint.json, lock dir).
 */
export async function cleanupStaleRegistry(): Promise<void> {
  try {
    await Deno.remove(await getEndpointPath());
  } catch { /* no-op */ }
  try {
    await Deno.remove(await getLockDir(), { recursive: true });
  } catch { /* no-op */ }
}

/**
 * Full cleanup: endpoint, lock, and server dir if empty.
 */
export async function cleanupAll(): Promise<void> {
  await releaseLock();
  await cleanupStaleRegistry();
  try {
    await Deno.remove(await getServerDir());
  } catch { /* no-op */ }
}
