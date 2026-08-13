// ============================================================
// src/repl/types.ts — SDK public types
//
// Host-neutral contracts for the REPL kernel. The kernel owns NO
// child process: hosts decide which process this code runs in,
// who spawned it, and who supervises it (see the extraction
// design doc §5.3).
// ============================================================

/** Plain MIME bundle shape used for display / execute_result payloads. */
export type MimeBundle = Record<string, string | Uint8Array>;

/** Structured output emitted during an evaluation. */
export type ReplOutputEvent =
  | { kind: "stdout"; text: string }
  | { kind: "stderr"; text: string }
  | {
    kind: "display";
    data: MimeBundle;
    metadata: Record<string, unknown>;
    displayId?: string;
    update?: boolean;
  }
  | { kind: "clear"; wait: boolean }
  | { kind: "execute_result"; data: MimeBundle; executionCount: number }
  | { kind: "error"; name: string; value: string; traceback: string[] };

/**
 * Host-provided I/O the kernel calls during eval. The host binds this to its
 * own channel (notebook, log, control socket, JSON line, ...).
 */
export interface ReplRuntime {
  /** Route a structured output event to the host. */
  emit(event: ReplOutputEvent): void | Promise<void>;
  /** Host answers an input prompt (Jupyter input_request, terminal, ...). */
  requestInput(prompt: string, password: boolean): Promise<string>;
  /** Lifecycle hooks so the host can publish busy/idle. */
  onEvalStart?(code: string): void | Promise<void>;
  onEvalEnd?(result: ReplEvalResult): void | Promise<void>;
}

export interface ReplKernelOptions {
  runtime: ReplRuntime;
  /**
   * How console output is handled:
   *  - "protocol": console.log/warn/info/debug/error are captured into
   *    stdout/stderr events (required when stdout is the protocol channel);
   *  - "sideband": console.* untouched; host reads child stdout separately;
   *  - "off": console.* untouched and ignored.
   */
  consoleCapture?: "protocol" | "sideband" | "off";
  /** Bind globalThis.prompt/confirm to runtime.requestInput (default true). */
  installPrompt?: boolean;
  /** Bind globalThis.Deno.jupyter.* to runtime.emit (default false). */
  jupyterShim?: boolean;
}

export interface ReplEvalResult {
  ok: boolean;
  /** Final-expression value (host may ignore in notebook mode). */
  data?: unknown;
  error?: string;
  /**
   * True when the in-process state is unusable. The host owns the recovery
   * decision (restart the child, mark the session faulted, ...); the SDK never
   * kills or respawns anything itself.
   */
  fatal?: boolean;
}

/** Persistent scope snapshot (declared names + value reference). */
export interface ReplSnapshot {
  declaredNames: string[];
  values: Record<string, unknown>;
}

export interface ReplKernel {
  /** Evaluate one cell; resolves when the cell's async IIFE settles. */
  eval(code: string, options?: { timeoutMs?: number }): Promise<ReplEvalResult>;
  /** Cooperative interrupt of the in-flight eval (rejects the race). */
  interrupt(): void;
  /** Persistent scope snapshot (declared names + values reference). */
  snapshot(): ReplSnapshot;
  /** Clear scope + declared names (restart without process respawn). */
  reset(): void;
  dispose(): Promise<void>;
}
