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

export interface ReplCreateOptions {
  description?: string;
  cwd?: string;
  permissions?: Permissions;
  codexCeiling?: SandboxState | null;
  timeoutMs?: number;
  onElicit?: (req: PermissionRequest, resolve: ElicitResolver) => Promise<void>;
}

export class ReplManager {
  private sessions = new Map<string, ReplSession>();

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

  async close(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    await session.close();
    this.sessions.delete(sessionId);
    return true;
  }

  list(): ReplSessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => s.getInfo());
  }

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

export const replManager: ReplManager = new ReplManager();
