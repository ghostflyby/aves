// ============================================================
// src/repl/kernel.ts — createReplKernel
//
// In-process evaluation kernel. Executions run serially (FIFO) on
// a shared persistent scope; each execution exposes a pull-based
// console-output stream plus an `emit` port for host-routed console
// capture, and a resident AbortController as its cancellation
// handle + event source. The kernel owns NO child process and
// installs NO globals — hosts decide the process, the supervision,
// and any global wiring (design doc §5.3).
// ============================================================

import { EvalEngine } from "./eval-engine.ts";
import type {
  ReplEvalResult,
  ReplExecution,
  ReplKernel,
  ReplKernelOptions,
  ReplOutputEvent,
} from "./types.ts";

/**
 * Bound the output buffer before `emit()` starts waiting on the consumer
 * (backpressure). The stream's own high-water mark is the read-side cap.
 */
const OUTPUT_HIGH_WATER_MARK = 64;

class ExecutionOutput {
  readonly stream: ReadableStream<ReplOutputEvent>;
  #controller: ReadableStreamDefaultController<ReplOutputEvent> | null = null;
  private closed = false;
  private waiters: Array<() => void> = [];

  constructor() {
    this.stream = new ReadableStream<ReplOutputEvent>({
      start: (controller) => {
        this.#controller = controller;
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
      this.#controller!.enqueue(event);
    } catch {
      this.closed = true;
      this.resolveWaiters();
      return;
    }
    if ((this.#controller!.desiredSize ?? 0) < 0) {
      return new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.resolveWaiters();
    try {
      this.#controller!.close();
    } catch { /* already closed */ }
  }

  private resolveWaiters(): void {
    if (this.waiters.length === 0) return;
    if (this.closed || (this.#controller!.desiredSize ?? 0) > 0) {
      const ws = this.waiters;
      this.waiters = [];
      for (const resolve of ws) resolve();
    }
  }
}

interface QueueItem {
  code: string;
  controller: AbortController;
  sink: ExecutionOutput;
  resolveResult: (result: ReplEvalResult) => void;
  execution: ReplExecution;
}

export function createReplKernel(
  options?: ReplKernelOptions,
): Promise<ReplKernel> {
  const engine = new EvalEngine({ transform: options?.transform });
  const queue: QueueItem[] = [];
  let running = false;
  let currentExecution: ReplExecution | null = null;
  let executionCounter = 0;
  let disposed = false;

  async function pump(): Promise<void> {
    if (running || disposed) return;
    running = true;
    try {
      while (queue.length > 0 && !disposed) {
        const item = queue.shift()!;
        currentExecution = item.execution;
        await runOne(item);
        currentExecution = null;
      }
    } finally {
      running = false;
    }
  }

  async function runOne(item: QueueItem): Promise<void> {
    if (item.controller.signal.aborted) {
      item.resolveResult({
        ok: false,
        error: abortMessage(item.controller.signal),
      });
      item.sink.close();
      return;
    }
    try {
      const data = await engine.runCell(item.code, {
        signal: item.controller.signal,
      });
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
    get current() {
      return currentExecution;
    },

    execute(code, options) {
      const controller = new AbortController();
      const sink = new ExecutionOutput();
      const executionId = ++executionCounter;
      let resolveResult!: (result: ReplEvalResult) => void;
      const result = new Promise<ReplEvalResult>((resolve) => {
        resolveResult = resolve;
      });

      // External cancellation token -> this execution's controller. Every
      // cancellation source (host signal, controller.abort(), interrupt(),
      // dispose) is observed on the single controller.signal. The listener is
      // detached when the execution settles so long-lived host signals do not
      // leak listeners (their abort then cannot affect this execution).
      const hostSignal = options?.signal;
      const onHostAbort = () => controller.abort(hostSignal?.reason);
      if (hostSignal) {
        if (hostSignal.aborted) {
          controller.abort(hostSignal.reason);
        } else {
          hostSignal.addEventListener("abort", onHostAbort, { once: true });
          result.finally(() => {
            hostSignal.removeEventListener("abort", onHostAbort);
          }).catch(() => {});
        }
      }

      const execution: ReplExecution = {
        executionId,
        outputs: sink.stream,
        controller,
        signal: controller.signal,
        result,
        emit: (event) => sink.emit(event),
      };
      const item: QueueItem = {
        code,
        controller,
        sink,
        resolveResult,
        execution,
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

      return execution;
    },

    interrupt() {
      currentExecution?.controller.abort();
    },

    snapshot() {
      return engine.snapshot();
    },

    reset() {
      engine.reset();
    },

    dispose() {
      return release();
    },

    [Symbol.asyncDispose]() {
      return release();
    },
  };

  function release(): Promise<void> {
    if (disposed) return Promise.resolve();
    disposed = true;
    currentExecution?.controller.abort();
    const pending = queue.splice(0);
    for (const item of pending) {
      item.resolveResult({ ok: false, error: "kernel disposed" });
      item.sink.close();
    }
    engine.dispose();
    return Promise.resolve();
  }

  return Promise.resolve(kernel);
}

function abortMessage(signal: AbortSignal): string {
  const reason = signal.reason;
  if (reason instanceof DOMException && reason.name === "TimeoutError") {
    return "REPL eval timed out";
  }
  return "REPL eval interrupted";
}
