// ============================================================
// src/repl/types.ts — SDK public types
//
// The SDK is host-neutral and owns NO child process: hosts decide
// which process this code runs in, who spawned it, and who
// supervises it (design doc §5.3). The kernel's only irreplaceable
// responsibility is evaluation: persistent scope, top-level await,
// import rewriting, and the final-expression value (ReplEvalResult).
// Everything else — console output routing, prompt/confirm,
// Deno.jupyter.* — is host-environment wiring the host injects
// itself (using kernel.current to attribute output to an execution).
// ============================================================

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
   * This execution's resident AbortController. `signal` is `controller.signal`,
   * so `controller` is both the handle to cancel this execution after the fact
   * and a reliable cancellation event source: every cancellation source —
   * the external `{ signal }` token, a direct `controller.abort()`,
   * `kernel.interrupt()`, or `dispose()` — is observed on `controller.signal`.
   */
  readonly controller: AbortController;
  /** This execution's cancellation signal (`=== controller.signal`). */
  readonly signal: AbortSignal;
  /** Settles when the cell's async IIFE settles. */
  readonly result: Promise<ReplEvalResult>;
}

export interface ReplSnapshot {
  /** Names declared by executed cells. */
  readonly names: string[];
  /** Current values of declared names. */
  readonly values: Record<string, unknown>;
}

/** Cell transformer: esbuild-compatible contract (TS/JS code in, ESM out). */
export type CodeTransform = (
  code: string,
  options: { loader: "ts"; format: "esm" },
) => Promise<{ code: string }>;

export interface ReplKernelOptions {
  /**
   * Replace the default esbuild-wasm transform. Hosts can supply a shared
   * instance, a worker-pool-backed transform (one esbuild-wasm isolate per
   * worker, message-forwarded), a pre-bundled wasm payload, or a test stub.
   * Default: the process-global esbuild-wasm singleton (initialized once per
   * process, shared by all kernels).
   */
  transform?: CodeTransform;
}

export interface ReplKernel extends AsyncDisposable {
  /**
   * Queue and run one cell. Returns immediately; executions run serially
   * (FIFO) because they share the persistent scope. Top-level await is
   * supported. Cancellation: pass `{ signal }`, `AbortSignal.timeout(ms)`,
   * `execution.controller.abort()`, or use `interrupt()`.
   */
  execute(code: string, options?: { signal?: AbortSignal }): ReplExecution;
  /**
   * The in-flight execution, or `null` when idle. Hosts use this to attribute
   * their own injected globals (console.*, Deno.jupyter.*) to the running
   * cell. References the execution object that was running when the queue
   * advanced, so it never points at a newly queued execution.
   */
  readonly current: ReplExecution | null;
  /** Abort the in-flight execution (`=== current?.controller.abort()`). */
  interrupt(): void;
  snapshot(): ReplSnapshot;
  /** Clear scope + declared names (restart without process respawn). */
  reset(): void;
  /**
   * Release the kernel: abort in-flight work, reject queued executions, and
   * free the engine. Same as `[Symbol.asyncDispose]()`, so
   * `await using kernel = await createReplKernel()` cleans up automatically
   * when the block exits.
   */
  dispose(): Promise<void>;
  /** Explicit resource management protocol (identical to `dispose()`). */
  [Symbol.asyncDispose](): Promise<void>;
}
