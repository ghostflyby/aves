// ============================================================
// src/repl/types.ts — SDK public types
//
// The SDK is host-neutral and owns NO child process: hosts decide
// which process this code runs in, who spawned it, and who
// supervises it (design doc §5.3). The kernel produces per-cell
// output streams and an emit port; every global install
// (console.*, prompt/confirm, Deno.jupyter.*) is host-owned and
// wired to those ports via the SDK utils (design doc §5.2).
// ============================================================

/** Plain MIME bundle shape used for display / execute_result payloads. */
export type MimeBundle = Record<string, string | Uint8Array>;

/** Structured output produced during a single execution. */
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

export interface ReplExecution {
  /** Monotonic sequence number (Jupyter execution_count counterpart). */
  readonly executionId: number;
  /**
   * Pull-based stream of this cell's structured output. The host consumes it
   * with pipeTo / for await / tee; `emit()` routes additional events into the
   * same stream while it is open.
   */
  readonly outputs: ReadableStream<ReplOutputEvent>;
  /** Combined cancellation signal (host signal + interrupt + timeout). */
  readonly signal: AbortSignal;
  /** Settles when the cell's async IIFE settles (the stream closes after). */
  readonly result: Promise<ReplEvalResult>;
  /** Route an output event into this execution's stream. */
  emit(event: ReplOutputEvent): void | Promise<void>;
  /** Abort only this execution. */
  abort(): void;
}

export interface ReplSnapshot {
  /** Names declared by executed cells. */
  readonly names: string[];
  /** Current values of declared names. */
  readonly values: Record<string, unknown>;
}

export interface ReplKernel {
  /**
   * Queue and run one cell. Returns immediately; executions run serially
   * (FIFO) because they share the persistent scope. Top-level await is
   * supported. Cancellation: pass `{ signal }`, `AbortSignal.timeout(ms)`, or
   * use `interrupt()`.
   */
  execute(code: string, options?: { signal?: AbortSignal }): ReplExecution;
  /** Abort the in-flight execution (Jupyter interrupt_request counterpart). */
  interrupt(): void;
  snapshot(): ReplSnapshot;
  /** Clear scope + declared names (restart without process respawn). */
  reset(): void;
  dispose(): Promise<void>;
}
