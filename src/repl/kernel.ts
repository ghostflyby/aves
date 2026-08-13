// ============================================================
// src/repl/kernel.ts — createReplKernel
//
// In-process evaluation kernel. Executions run serially (FIFO) on
// a shared persistent scope; each execution exposes a pull-based
// output stream plus an `emit` port for host-routed events
// (console capture, Deno.jupyter.display, ...). The kernel owns NO
// child process and installs NO globals — hosts decide the process,
// the supervision, and any global wiring (design doc §5.3).
// ============================================================

import { EvalEngine } from "./eval-engine.ts";
import type {
  ReplEvalResult,
  ReplExecution,
  ReplKernel,
  ReplOutputEvent,
} from "./types.ts";

/**
 * Bound the output buffer before `emit()` starts waiting on the consumer
 * (backpressure). The stream's own high-water mark is the read-side cap.
 */
const OUTPUT_HIGH_WATER_MARK = 64;

class ExecutionOutput {
  readonly stream: ReadableStream<ReplOutputEvent>;
  private controller: ReadableStreamDefaultController<ReplOutputEvent> | null =
    null;
  private closed = false;
  private waiters: Array<() => void> = [];

  constructor() {
    this.stream = new ReadableStream<ReplOutputEvent>({
      start: (controller) => {
        this.controller = controller;
      },
      pull: () => this.resolveWaiters(),
      cancel: () => {
        this.closed = true;
        this.resolveWaiters();
      },
    }, { highWaterMark: OUTPUT_HIGH_WATER_MARK });
  }

  /**
   * Route an event into the stream. Returns a promise when the consumer has
   * not kept up (backpressure) — hosts that want flow control await it; hosts
   * that only care about ordering may ignore it (events still buffer).
   */
  emit(event: ReplOutputEvent): void | Promise<void> {
    if (this.closed) return;
    try {
      this.controller!.enqueue(event);
    } catch {
      this.closed = true;
      this.resolveWaiters();
      return;
    }
    if ((this.controller!.desiredSize ?? 0) < 0) {
      return new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.resolveWaiters();
    try {
      this.controller!.close();
    } catch { /* already closed */ }
  }

  private resolveWaiters(): void {
    if (this.waiters.length === 0) return;
    if (this.closed || (this.controller!.desiredSize ?? 0) > 0) {
      const ws = this.waiters;
      this.waiters = [];
      for (const resolve of ws) resolve();
    }
  }
}

interface QueueItem {
  code: string;
  signal: AbortSignal;
  sink: ExecutionOutput;
  resolveResult: (result: ReplEvalResult) => void;
  internalAbort: AbortController;
}

export function createReplKernel(): Promise<ReplKernel> {
  const engine = new EvalEngine();
  const queue: QueueItem[] = [];
  let running = false;
  let current: QueueItem | null = null;
  let executionCounter = 0;
  let disposed = false;

  async function pump(): Promise<void> {
    if (running || disposed) return;
    running = true;
    try {
      while (queue.length > 0 && !disposed) {
        const item = queue.shift()!;
        current = item;
        await runOne(item);
        current = null;
      }
    } finally {
      running = false;
    }
  }

  async function runOne(item: QueueItem): Promise<void> {
    if (item.signal.aborted) {
      item.resolveResult({ ok: false, error: abortMessage(item.signal) });
      item.sink.close();
      return;
    }
    try {
      const data = await engine.runCell(item.code, { signal: item.signal });
      item.resolveResult({ ok: true, data });
    } catch (err) {
      item.resolveResult({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      item.sink.close();
    }
  }

  const kernel: ReplKernel = {
    execute(code, options) {
      const internalAbort = new AbortController();
      const signal = options?.signal
        ? AbortSignal.any([options.signal, internalAbort.signal])
        : internalAbort.signal;
      const sink = new ExecutionOutput();
      const executionId = ++executionCounter;
      let resolveResult!: (result: ReplEvalResult) => void;
      const result = new Promise<ReplEvalResult>((resolve) => {
        resolveResult = resolve;
      });
      const item: QueueItem = {
        code,
        signal,
        sink,
        resolveResult,
        internalAbort,
      };

      if (disposed) {
        queueMicrotask(() => {
          resolveResult({ ok: false, error: "kernel disposed" });
          sink.close();
        });
      } else {
        queue.push(item);
        void pump();
      }

      return {
        executionId,
        outputs: sink.stream,
        signal,
        result,
        emit: (event) => sink.emit(event),
      } satisfies ReplExecution;
    },

    interrupt() {
      current?.internalAbort.abort();
    },

    snapshot() {
      return engine.snapshot();
    },

    reset() {
      engine.reset();
    },

    dispose() {
      if (disposed) return Promise.resolve();
      disposed = true;
      current?.internalAbort.abort();
      const pending = queue.splice(0);
      for (const item of pending) {
        item.resolveResult({ ok: false, error: "kernel disposed" });
        item.sink.close();
      }
      engine.dispose();
      return Promise.resolve();
    },
  };

  return Promise.resolve(kernel);
}

function abortMessage(signal: AbortSignal): string {
  const reason = signal.reason;
  if (reason instanceof DOMException && reason.name === "TimeoutError") {
    return "REPL eval timed out";
  }
  return "REPL eval interrupted";
}
