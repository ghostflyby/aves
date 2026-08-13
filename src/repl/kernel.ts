// ============================================================
// src/repl/kernel.ts — createReplKernel
//
// In-process evaluation kernel bound to a host ReplRuntime. The
// kernel owns NO child process: the host decides which process
// this code runs in, who spawned it, and who supervises it
// (design doc §5.3). It reports `fatal`-less results; hosts own
// recovery decisions.
// ============================================================

import { EvalEngine } from "./eval-engine.ts";
import type { ReplEvalResult, ReplKernel, ReplKernelOptions } from "./types.ts";

export function createReplKernel(
  options: ReplKernelOptions,
): Promise<ReplKernel> {
  const runtime = options.runtime;
  const engine = new EvalEngine({
    backend: options.transformBackend,
    consoleCapture: options.consoleCapture,
    installPrompt: options.installPrompt,
    emit: (event) => {
      // A throwing host emit must not kill the evaluation.
      Promise.resolve(runtime.emit(event)).catch(() => {});
    },
    requestInput: (prompt, password) => runtime.requestInput(prompt, password),
  });

  let current: AbortController | null = null;

  const kernel: ReplKernel = {
    async eval(code, evalOptions) {
      const ac = new AbortController();
      current = ac;
      await runtime.onEvalStart?.(code);
      let result: ReplEvalResult;
      try {
        const data = await engine.runCell(code, {
          timeoutMs: evalOptions?.timeoutMs,
          signal: ac.signal,
        });
        result = { ok: true, data };
      } catch (err) {
        result = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      } finally {
        current = null;
      }
      await runtime.onEvalEnd?.(result);
      return result;
    },

    interrupt() {
      current?.abort();
    },

    snapshot() {
      return engine.snapshot();
    },

    reset() {
      engine.reset();
    },

    dispose() {
      engine.dispose();
      return Promise.resolve();
    },
  };

  return Promise.resolve(kernel);
}
