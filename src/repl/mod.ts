// ============================================================
// src/repl/mod.ts — Aves REPL SDK public surface
//
// Host-neutral REPL machinery: in-process evaluation kernel with
// persistent scope, top-level await, and final-expression results;
// AST transformer. The SDK imports only node: built-ins, acorn,
// astring, and esbuild-wasm — never Aves' runner/policy/run-store/
// config/skill/mcp modules. Transports, permission brokering, and
// global wiring (console.*, prompt, Deno.jupyter.*) are host-owned
// (src/host/: StdioTransport, broker policy).
// ============================================================

export type {
  CodeTransform,
  ReplEvalResult,
  ReplExecution,
  ReplKernel,
  ReplKernelOptions,
  ReplSnapshot,
} from "./types.ts";

export { EvalEngine } from "./eval-engine.ts";
export { createReplKernel } from "./kernel.ts";
export { rewriteReferences, transform } from "./transform.ts";
