// ============================================================
// src/repl/eval-engine.ts — in-process evaluation engine
//
// Owns the persistent scope, the esbuild+AST transform pipeline,
// the AsyncFunction wrapper (top-level await), and the optional
// prompt/confirm + console capture installs. This is the SDK core:
// it knows nothing about processes, protocols, or permissions.
// ============================================================

import esbuildWasmCjs from "esbuild-wasm/lib/browser.js";
import { transform } from "./transform.ts";

export type TransformBackend = "esbuild-wasm" | "esbuild";

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
 * backend is memoised at module scope — all kernels/engines in a process share
 * the single WASM service.
 */
let wasmTransformPromise: Promise<TransformFn> | null = null;

function makeWasmTransform(): Promise<TransformFn> {
  if (!wasmTransformPromise) {
    wasmTransformPromise = (async () => {
      const entryUrl = import.meta.resolve("esbuild-wasm/lib/browser.js");
      const wasmBytes = await Deno.readFile(
        new URL("../esbuild.wasm", entryUrl),
      );
      const wasmModule = new WebAssembly.Module(wasmBytes);
      await esbuildWasm.initialize({ wasmModule, worker: false });
      return esbuildWasm.transform;
    })();
    wasmTransformPromise.catch(() => {
      wasmTransformPromise = null;
    });
  }
  return wasmTransformPromise;
}

function makeNativeTransform(): Promise<TransformFn> {
  // Dynamic import: the native esbuild package's node entry reads
  // process.env.ESBUILD_BINARY_PATH at module load (a permission-checked
  // access under the broker). Only pay that cost when the native backend is
  // actually selected; the default wasm path never loads it.
  return import("esbuild").then((nativeEsbuild) => (code, options) =>
    nativeEsbuild.transform(
      code,
      options as Parameters<typeof nativeEsbuild.transform>[1],
    )
  );
}

export interface EvalEngineOptions {
  backend?: TransformBackend;
  /** "protocol" mode wraps console.* so output lands in emit events. */
  consoleCapture?: "protocol" | "sideband" | "off";
  /** Bind globalThis.prompt/confirm to requestInput. */
  installPrompt?: boolean;
  /** Route captured stdout/stderr events here. */
  emit(event: { kind: "stdout" | "stderr"; text: string }): void;
  requestInput(prompt: string, password: boolean): Promise<string>;
}

export class EvalEngine {
  readonly scope: Record<string, unknown> = {};
  readonly declaredNames: Set<string> = new Set();

  private backend: TransformBackend;
  private transformPromise: Promise<TransformFn> | null = null;
  private emitFn: EvalEngineOptions["emit"];
  private requestInput: EvalEngineOptions["requestInput"];
  private consoleWrappers = new Map<
    keyof Console,
    (...args: unknown[]) => void
  >();
  private installedPrompt = false;
  private disposed = false;

  constructor(options: EvalEngineOptions) {
    this.backend = options.backend ?? "esbuild-wasm";
    this.emitFn = options.emit;
    this.requestInput = options.requestInput;
    if (options.consoleCapture === "protocol") this.installConsoleCapture();
    if (options.installPrompt) this.installPromptBindings();
  }

  /** Lazily resolve the process-global transform backend once per engine. */
  private getTransform(): Promise<TransformFn> {
    if (!this.transformPromise) {
      this.transformPromise = this.backend === "esbuild"
        ? makeNativeTransform()
        : makeWasmTransform();
    }
    return this.transformPromise;
  }

  /**
   * Transform + evaluate one cell in the persistent scope. Rejects on
   * transform/parse errors, runtime errors, timeout, or interrupt.
   */
  async runCell(
    code: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<unknown> {
    const t = await this.getTransform();
    const esm = await t(code, { loader: "ts", format: "esm" });
    const wrapped = transform(esm.code, this.declaredNames);
    const AF = Object.getPrototypeOf(async function () {}).constructor as new (
      ...args: string[]
    ) => (...args: unknown[]) => Promise<unknown>;
    const fn = new AF("scope", wrapped);
    const resultPromise = fn(this.scope);
    return await raceWithTimeoutAndAbort(
      resultPromise,
      options?.timeoutMs,
      options?.signal,
    );
  }

  /** Persistent scope snapshot (declared names + value reference). */
  snapshot(): { declaredNames: string[]; values: Record<string, unknown> } {
    const values: Record<string, unknown> = {};
    for (const name of this.declaredNames) {
      if (name in this.scope) values[name] = this.scope[name];
    }
    return { declaredNames: [...this.declaredNames], values };
  }

  /** Clear scope + declared names (restart without process respawn). */
  reset(): void {
    for (const key of Object.keys(this.scope)) delete this.scope[key];
    this.declaredNames.clear();
  }

  /** Restore console wrappers; release transform state. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.restoreConsole();
    if (this.installedPrompt) this.restorePromptBindings();
    this.transformPromise = null;
  }

  private installConsoleCapture(): void {
    const mapping: Array<[keyof Console, "stdout" | "stderr"]> = [
      ["log", "stdout"],
      ["info", "stdout"],
      ["debug", "stdout"],
      ["warn", "stderr"],
      ["error", "stderr"],
    ];
    for (const [method, kind] of mapping) {
      const original = console[method];
      if (typeof original !== "function") continue;
      const wrapper = (...args: unknown[]) => {
        if (this.disposed) {
          (original as (...a: unknown[]) => void).apply(console, args);
          return;
        }
        this.emitFn({ kind, text: args.map(formatConsoleArg).join(" ") });
      };
      this.consoleWrappers.set(method, wrapper);
      console[method] = wrapper as typeof console.log;
    }
  }

  private restoreConsole(): void {
    for (const [method, wrapper] of this.consoleWrappers) {
      // Deno's console methods are plain writable properties.
      (console as Record<keyof Console, unknown>)[method] = wrapper;
    }
    this.consoleWrappers.clear();
  }

  private installPromptBindings(): void {
    const g = globalThis as Record<string, unknown>;
    const prompt = (message?: string) =>
      this.requestInput(String(message ?? ""), false);
    const confirm = async (message?: string) => {
      const answer = (await this.requestInput(String(message ?? ""), false))
        .trim()
        .toLowerCase();
      return answer !== "" && answer !== "0" && answer !== "no" &&
        answer !== "false";
    };
    g.prompt = prompt;
    g.confirm = confirm;
    this.installedPrompt = true;
  }

  private restorePromptBindings(): void {
    const g = globalThis as Record<string, unknown>;
    delete g.prompt;
    delete g.confirm;
  }
}

function formatConsoleArg(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return Deno.inspect(value, { colors: false }) ?? String(value);
  } catch {
    return String(value);
  }
}

async function raceWithTimeoutAndAbort<T>(
  promise: Promise<T>,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const racers: Promise<T>[] = [promise];
    if (timeoutMs && timeoutMs > 0) {
      racers.push(
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("REPL eval timed out")),
            timeoutMs,
          );
        }),
      );
    }
    if (signal) {
      racers.push(
        new Promise<never>((_, reject) => {
          if (signal.aborted) {
            reject(new Error("REPL eval interrupted"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => reject(new Error("REPL eval interrupted")),
            { once: true },
          );
        }),
      );
    }
    return await Promise.race(racers);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
