// ============================================================
// src/repl/kernel.ts — createReplKernel
//
// In-process evaluation kernel. Executions run serially (FIFO) on
// a shared persistent scope and expose a resident AbortController
// as their cancellation handle + event source. The kernel's only
// job is evaluation; it produces no output events and installs no
// globals — hosts attribute their own console.* / Deno.jupyter.*
// wiring to the in-flight cell via kernel.current, and own the
// process, the supervision, and any routing (design doc §5.3).
// ============================================================

import { EvalEngine } from "./eval-engine.ts";
import type {
  ReplEvalResult,
  ReplExecution,
  ReplKernel,
  ReplKernelOptions,
} from "./types.ts";

interface QueueItem {
  code: string;
  controller: AbortController;
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
        // A timed-out execution may have left the persistent scope in an
        // unknown state (its async work can keep running after the race
        // settles), so the host must treat the session as unusable.
        fatal: isTimeout(item.controller.signal),
      });
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
        fatal: isTimeout(item.controller.signal),
      });
    }
  }

  const kernel: ReplKernel = {
    get current() {
      return currentExecution;
    },

    execute(code, options) {
      const controller = new AbortController();
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
        controller,
        signal: controller.signal,
        result,
      };
      const item: QueueItem = { code, controller, resolveResult, execution };

      if (disposed) {
        queueMicrotask(() => {
          resolveResult({ ok: false, error: "kernel disposed" });
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

function isTimeout(signal: AbortSignal): boolean {
  return signal.reason instanceof DOMException &&
    signal.reason.name === "TimeoutError";
}
