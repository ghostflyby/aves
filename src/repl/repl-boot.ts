// ============================================================
// src/repl/repl-boot.ts — REPL child process entry point
// ============================================================

import * as esbuild from "esbuild";
import { transform } from "./transform.ts";

const scope: Record<string, unknown> = {};
const declaredNames: Set<string> = new Set();
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let buf = "";

async function main(): Promise<void> {
  const rb = new Uint8Array(65536);
  while (true) {
    const n = await Deno.stdin.read(rb);
    if (n === null) break;
    buf += decoder.decode(rb.subarray(0, n), { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.type === "close") {
        await w({ type: "closed" });
        return;
      }
      if (
        m.type === "eval" &&
        typeof m.id === "string" &&
        typeof m.code === "string"
      ) {
        await ev(
          m.id,
          m.code,
          typeof m.timeout_ms === "number" ? m.timeout_ms : undefined,
        );
      }
    }
  }
}

async function ev(id: string, code: string, timeoutMs?: number): Promise<void> {
  try {
    const r = await esbuild.transform(code, { loader: "ts", format: "esm" });
    const wrapped = transform(r.code, declaredNames);
    const AF = Object.getPrototypeOf(async function () {}).constructor as new (
      ...args: string[]
    ) => (...args: unknown[]) => Promise<unknown>;
    const fn = new AF("scope", wrapped);
    const data = await withTimeout(fn(scope), timeoutMs);
    await w({ type: "result", id, ok: true, data });
  } catch (err) {
    await w({
      type: "result",
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs?: number,
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return await promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("REPL eval timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function w(obj: Record<string, unknown>): Promise<void> {
  await Deno.stdout.write(encoder.encode(JSON.stringify(obj) + "\n"));
}

main().catch((err) => {
  console.error("REPL boot crashed:", err);
  Deno.exit(1);
});
