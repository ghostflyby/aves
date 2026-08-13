// ============================================================
// src/host/child-session.ts — Aves host-side REPL session
//
// Aves' host assembly (design doc §5.3): spawns `deno run boot.ts`
// with broker + env + cwd, drives the stdio transport, and owns
// the supervision state machine (timeouts, SIGKILL escalation,
// broker lifecycle, restart signalling). The SDK kernel never
// spawns or kills anything.
// ============================================================

import { fileURLToPath } from "node:url";
import {
  type BrokerHandle,
  type ElicitResolver,
  type PermissionRequest,
  startBroker,
} from "../broker.ts";
import { globalAbort, resolveModuleSpecifier } from "../runner.ts";
import {
  createRunBrokerPolicy,
  type RunElicitContext,
} from "../repl/policy.ts";
import type { Permissions } from "../types.ts";
import type { SandboxState } from "../sandbox-state.ts";

export interface ReplResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  fatal?: boolean;
}

export interface ReplSessionInfo {
  id: string;
  description: string;
  evalCount: number;
  pid: number;
  startedAt: string;
  cwd: string;
}

export class ReplSession {
  readonly id: string;
  readonly description: string;
  readonly startedAt: string;
  readonly cwd: string;
  private proc: Deno.ChildProcess;
  private broker: BrokerHandle | null = null;
  private evalCount = 0;
  private defaultTimeoutMs?: number;
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();
  private stdoutBuf = "";
  private resolveMap = new Map<
    string,
    {
      resolve: (v: ReplResult) => void;
      reject: (e: Error) => void;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();
  private closed = false;
  private stdinWriter: WritableStreamDefaultWriter<Uint8Array>;
  private closedPromise: Promise<void>;
  private resolveClosed!: () => void;
  private readAbort = new AbortController();
  private cleanupStarted: Promise<void> | null = null;

  constructor(
    proc: Deno.ChildProcess,
    id: string,
    description: string,
    cwd: string,
    timeoutMs?: number,
  ) {
    this.id = id;
    this.description = description;
    this.startedAt = new Date().toISOString();
    this.cwd = cwd;
    this.defaultTimeoutMs = timeoutMs;
    this.proc = proc;
    this.closedPromise = new Promise((r) => {
      this.resolveClosed = r;
    });
    this.stdinWriter = proc.stdin.getWriter();
    this.readLoop();
    this.stderrLoop();
  }

  private async readLoop(): Promise<void> {
    const reader = this.proc.stdout.getReader();

    try {
      const signal = this.readAbort.signal;
      while (!signal.aborted) {
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await reader.read();
        } catch {
          break;
        }
        if (result.done) break;
        const { value } = result;
        this.stdoutBuf += this.decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = this.stdoutBuf.indexOf("\n")) !== -1) {
          const line = this.stdoutBuf.slice(0, nl).trim();
          this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.type === "result" && msg.id) {
              const pending = this.resolveMap.get(msg.id);
              if (pending) {
                if (pending.timer !== undefined) clearTimeout(pending.timer);
                this.resolveMap.delete(msg.id);
                pending.resolve({
                  ok: msg.ok as boolean,
                  data: msg.data,
                  error: msg.error,
                });
              }
            } else if (msg.type === "closed") {
              this.resolveClosed();
              return;
            }
          } catch { /* malformed */ }
        }
      }
    } catch (err) {
      for (const [, pending] of this.resolveMap) {
        pending.reject(err as Error);
      }
      this.resolveMap.clear();
    } finally {
      reader.releaseLock();
    }
    // Reject any remaining pending evals on process exit
    if (this.resolveMap.size > 0) {
      for (const [, pending] of this.resolveMap) {
        if (pending.timer !== undefined) clearTimeout(pending.timer);
        pending.resolve({
          ok: false,
          error: "REPL process exited unexpectedly",
        });
      }
      this.resolveMap.clear();
    }
    this.closed = true;
  }

  private async stderrLoop(): Promise<void> {
    const stderr = this.proc.stderr;
    if (!stderr) return;
    const reader = stderr.getReader();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        const text = this.decoder.decode(result.value, { stream: true });
        if (text) {
          console.error(`[aves repl ${this.id}] ${text.trimEnd()}`);
        }
      }
    } catch {
      // Best-effort diagnostics only.
    } finally {
      reader.releaseLock();
    }
  }

  eval(code: string, timeoutMs?: number): Promise<ReplResult> {
    if (this.closed) {
      return Promise.resolve({ ok: false, error: "session closed" });
    }
    this.evalCount++;
    const effectiveTimeout = timeoutMs ?? this.defaultTimeoutMs;
    const id = `eval_${this.evalCount}`;

    return new Promise<ReplResult>((resolve, reject) => {
      const pending = { resolve, reject } as {
        resolve: (v: ReplResult) => void;
        reject: (e: Error) => void;
        timer?: ReturnType<typeof setTimeout>;
      };
      this.resolveMap.set(id, pending);
      const msg = JSON.stringify({
        type: "eval",
        id,
        code,
        timeout_ms: effectiveTimeout,
      }) + "\n";
      this.stdinWriter.write(this.encoder.encode(msg))
        .catch((err) => {
          if (pending.timer !== undefined) clearTimeout(pending.timer);
          this.resolveMap.delete(id);
          reject(err);
        });

      if (effectiveTimeout && effectiveTimeout > 0) {
        const timer = setTimeout(() => {
          const pending = this.resolveMap.get(id);
          if (pending) {
            if (pending.timer !== undefined) clearTimeout(pending.timer);
            this.resolveMap.delete(id);
            resolve({ ok: false, error: "REPL eval timed out", fatal: true });
            void this.forceShutdown("SIGKILL", "session closed");
          }
        }, effectiveTimeout);
        pending.timer = timer;
      }
    });
  }

  getInfo(): ReplSessionInfo {
    return {
      id: this.id,
      description: this.description,
      evalCount: this.evalCount,
      pid: this.proc.pid,
      startedAt: this.startedAt,
      cwd: this.cwd,
    };
  }

  async close(): Promise<void> {
    if (this.cleanupStarted) {
      await this.cleanupStarted;
      return;
    }

    if (!this.closed) {
      this.closed = true;
      try {
        const msg = JSON.stringify({ type: "close" }) + "\n";
        await this.stdinWriter.write(this.encoder.encode(msg));
        this.stdinWriter.releaseLock();
      } catch { /* dead */ }

      await Promise.race([this.closedPromise, delay(2000)]);
    }

    await this.forceShutdown("SIGKILL", "session closed");
  }

  private forceShutdown(
    signal: Deno.Signal,
    pendingError: string,
  ): Promise<void> {
    if (!this.cleanupStarted) {
      this.cleanupStarted = this.forceShutdownOnce(signal, pendingError);
    }
    return this.cleanupStarted;
  }

  private async forceShutdownOnce(
    signal: Deno.Signal,
    pendingError: string,
  ): Promise<void> {
    this.closed = true;
    this.readAbort.abort();
    try {
      this.stdinWriter.releaseLock();
    } catch { /* already released */ }
    try {
      this.proc.kill(signal);
    } catch { /* dead */ }
    await this.waitForExit();

    if (this.broker) {
      this.broker.cancel();
      try {
        await this.broker.done;
      } catch { /* best-effort */ }
      this.broker = null;
    }

    for (const [, pending] of this.resolveMap) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: pendingError });
    }
    this.resolveMap.clear();
  }

  private async waitForExit(timeoutMs = 2000): Promise<void> {
    await Promise.race([
      this.proc.status.then(() => undefined).catch(() => undefined),
      delay(timeoutMs),
    ]);
  }

  setBroker(broker: BrokerHandle): void {
    this.broker = broker;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================
// Spawn — host assembly with broker + supervision
// ============================================================

// Resolve boot.ts relative to this source.
const BOOT_SPECIFIER = resolveModuleSpecifier(
  "../repl/boot.ts",
  import.meta.url,
);
const DEFAULT_IMPORT_DOMAINS = [
  "deno.land:443",
  "jsr.io:443",
  "esm.sh:443",
  "raw.esm.sh:443",
  "cdn.jsdelivr.net:443",
  "raw.githubusercontent.com:443",
  "gist.githubusercontent.com:443",
  "registry.npmjs.org:443",
];

export interface SpawnOptions {
  description?: string;
  cwd?: string;
  permissions?: Permissions;
  codexCeiling?: SandboxState | null;
  timeoutMs?: number;
  onElicit?: (req: PermissionRequest, resolve: ElicitResolver) => Promise<void>;
}

export async function spawnReplSession(
  options: SpawnOptions = {},
): Promise<ReplSession> {
  const id = crypto.randomUUID();
  const description = options.description ?? `REPL ${id.slice(0, 8)}`;
  const cwd = options.cwd ?? Deno.cwd();
  const defaultTimeoutMs = options.timeoutMs;
  const realCwd = await Deno.realPath(cwd);
  const permissions = options.permissions ?? {};
  const codexCeiling = options.codexCeiling ?? null;

  // Build extraDirs from cwd + granted read/write paths
  const extraDirs = [realCwd];
  if (permissions.read) extraDirs.push(...permissions.read);
  if (permissions.write) extraDirs.push(...permissions.write);
  // esbuild-wasm runs fully in-process (lib/browser.js, worker:false), but it
  // reads the package's esbuild.wasm payload once at first transform. Pre-allow
  // that one read so REPL startup never fires broker elicitation — this replaces
  // the native esbuild binary path pre-approval that the run-spawning backend
  // required.
  try {
    const wasmDir = fileURLToPath(
      new URL("..", import.meta.resolve("esbuild-wasm/lib/browser.js")),
    );
    extraDirs.push(wasmDir);
  } catch { /* keep going if resolution fails */ }

  const ctx: RunElicitContext = {
    codeHash: null,
    codexCeiling,
    extraDirs,
  };

  const policy = createRunBrokerPolicy(ctx);
  if (options.onElicit) {
    policy.onElicit = (_id, req, resolve) => {
      options.onElicit!(req, resolve).catch(() => resolve(false));
    };
  }

  let broker: BrokerHandle;
  try {
    broker = await startBroker(policy);
  } catch (err) {
    console.error(`[aves] broker start failed for REPL ${id}: ${err}`);
    throw err;
  }

  const args = [
    "run",
    "--no-prompt",
    "--allow-import=" + DEFAULT_IMPORT_DOMAINS.join(","),
    BOOT_SPECIFIER,
  ];

  const cmd = new Deno.Command("deno", {
    args,
    cwd: realCwd,
    stdout: "piped",
    stdin: "piped",
    stderr: "piped",
    env: {
      ...Deno.env.toObject(),
      DENO_PERMISSION_BROKER_PATH: broker.sockPath,
    },
  });

  let proc: Deno.ChildProcess;
  try {
    proc = cmd.spawn();
  } catch (err) {
    broker.cancel();
    throw err;
  }

  const onGlobalAbort = () => {
    try {
      proc.kill("SIGKILL");
    } catch { /* dead */ }
    broker.cancel();
  };
  globalAbort.signal.addEventListener("abort", onGlobalAbort);
  proc.status.then(() => {
    globalAbort.signal.removeEventListener("abort", onGlobalAbort);
  }).catch(() => {});

  const session = new ReplSession(
    proc,
    id,
    description,
    realCwd,
    defaultTimeoutMs,
  );
  session.setBroker(broker);
  return session;
}
