// ============================================================
// src/repl/eval-engine.ts — in-process evaluation engine
//
// Owns the persistent scope and the esbuild-wasm + AST transform
// pipeline behind the AsyncFunction wrapper (top-level await). The
// engine is a pure evaluator: it installs no globals and emits no
// events — output routing (console.*, Deno.jupyter.*, prompt) is
// host-owned and wired to ReplExecution.emit via the SDK utils
// (design doc §5.2).
// ============================================================

import esbuildWasmCjs from "esbuild-wasm/lib/browser.js";
import { transform } from "./transform.ts";

type TransformFn = (
  code: string,
  options: { loader: string; format: string },
) => Promise<{ code: string }>;

const esbuildWasm = esbuildWasmCjs as unknown as {
  initialize(options: {
    wasmModule: WebAssembly.Module;
    worker: boolean;
  }): Promise<void>;
  transform: TransformFn;
};

/**
 * esbuild-wasm's browser entry (lib/browser.js) runs the Go WASM service
 * in-process: initialize({ wasmModule, worker: false }) compiles the package's
 * esbuild.wasm on this thread — no native binary and no `node` subprocess.
 * The wasm payload is read from the package directory on first use; hosts
 * grant that one read (or route it through their permission broker).
 *
 * esbuild-wasm's initialize() may only run once per process, so the resolved
 * transform is memoised at module scope — all engines in a process share the
 * single WASM service.
 */
let transformPromise: Promise<TransformFn> | null = null;

function getTransform(): Promise<TransformFn> {
  if (!transformPromise) {
    transformPromise = (async () => {
      const entryUrl = import.meta.resolve("esbuild-wasm/lib/browser.js");
      const wasmBytes = await Deno.readFile(
        new URL("../esbuild.wasm", entryUrl),
      );
      const wasmModule = new WebAssembly.Module(wasmBytes);
      await esbuildWasm.initialize({ wasmModule, worker: false });
      return esbuildWasm.transform;
    })();
    transformPromise.catch(() => {
      transformPromise = null;
    });
  }
  return transformPromise;
}

export class EvalEngine {
  readonly scope: Record<string, unknown> = {};
  readonly declaredNames: Set<string> = new Set();
  private disposed = false;

  /**
   * Transform + evaluate one cell in the persistent scope. Rejects on
   * transform/parse errors, runtime errors, or abort (signal).
   */
  async runCell(
    code: string,
    options?: { signal?: AbortSignal },
  ): Promise<unknown> {
    if (this.disposed) throw new Error("REPL engine disposed");
    if (options?.signal?.aborted) throw abortError(options.signal);
    const t = await getTransform();
    const esm = await t(code, { loader: "ts", format: "esm" });
    const wrapped = transform(esm.code, this.declaredNames);
    const AF = Object.getPrototypeOf(async function () {}).constructor as new (
      ...args: string[]
    ) => (...args: unknown[]) => Promise<unknown>;
    const fn = new AF("scope", wrapped);
    const resultPromise = fn(this.scope);
    return await raceWithAbort(resultPromise, options?.signal);
  }

  /** Persistent scope snapshot (declared names + value reference). */
  snapshot(): { names: string[]; values: Record<string, unknown> } {
    const values: Record<string, unknown> = {};
    for (const name of this.declaredNames) {
      if (name in this.scope) values[name] = this.scope[name];
    }
    return { names: [...this.declaredNames], values };
  }

  /** Clear scope + declared names (restart without process respawn). */
  reset(): void {
    for (const key of Object.keys(this.scope)) delete this.scope[key];
    this.declaredNames.clear();
  }

  dispose(): void {
    this.disposed = true;
  }
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof DOMException && reason.name === "TimeoutError") {
    return new Error("REPL eval timed out");
  }
  return new Error("REPL eval interrupted");
}

async function raceWithAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return await promise;
  return await Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      if (signal.aborted) {
        reject(abortError(signal));
        return;
      }
      signal.addEventListener("abort", () => reject(abortError(signal)), {
        once: true,
      });
    }),
  ]);
}
