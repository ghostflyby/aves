// ============================================================
// src/host/manager.ts — Aves host-side ReplManager registry
// ============================================================

import type { Permissions } from "../types.ts";
import type { SandboxState } from "../sandbox-state.ts";
import type { ElicitResolver, PermissionRequest } from "../broker.ts";
import {
  type ReplSession,
  type ReplSessionInfo,
  spawnReplSession,
} from "./child-session.ts";

/** Options for ReplManager.create (forwarded to spawnReplSession). */
export interface ReplCreateOptions {
  description?: string;
  cwd?: string;
  permissions?: Permissions;
  codexCeiling?: SandboxState | null;
  timeoutMs?: number;
  onElicit?: (req: PermissionRequest, resolve: ElicitResolver) => Promise<void>;
}

/**
 * Registry of live REPL sessions keyed by session id. Aves' host-side
 * assembly: create spawns a session, eval routes to it (auto-removing on
 * `fatal`), close tears it down. `replManager` is the process-wide instance
 * used by the MCP server.
 */
export class ReplManager {
  private sessions = new Map<string, ReplSession>();

  /** Spawn a new session and register it; returns its metadata. */
  async create(options: ReplCreateOptions = {}): Promise<ReplSessionInfo> {
    const session = await spawnReplSession({
      description: options.description,
      cwd: options.cwd,
      permissions: options.permissions,
      codexCeiling: options.codexCeiling,
      timeoutMs: options.timeoutMs,
      onElicit: options.onElicit,
    });
    this.sessions.set(session.id, session);
    return session.getInfo();
  }

  /**
   * Evaluate in the named session. Returns `{ok:false, error}` when the
   * session is unknown; drops the session from the registry when its result
   * is `fatal`.
   */
  async eval(
    sessionId: string,
    code: string,
    timeoutMs?: number,
  ): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { ok: false, error: `session not found: ${sessionId}` };
    }
    const result = await session.eval(code, timeoutMs);
    if (result.fatal) {
      this.sessions.delete(sessionId);
    }
    const { fatal: _fatal, ...publicResult } = result;
    return publicResult;
  }

  /** Close and remove a session; returns false when it was unknown. */
  async close(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    await session.close();
    this.sessions.delete(sessionId);
    return true;
  }

  /** Metadata for all live sessions. */
  list(): ReplSessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => s.getInfo());
  }

  /** Close every live session (best-effort; used on shutdown). */
  async closeAll(): Promise<void> {
    const sessions = Array.from(this.sessions.values());
    for (const session of sessions) {
      try {
        await session.close();
      } catch { /* best-effort */ }
      this.sessions.delete(session.id);
    }
  }
}

/** Process-wide session registry used by the MCP server. */
export const replManager: ReplManager = new ReplManager();
