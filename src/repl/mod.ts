// ============================================================
// src/repl/mod.ts — Aves REPL SDK public surface
//
// Host-neutral REPL machinery: in-process evaluation kernel with
// persistent scope, top-level await, and final-expression results;
// stdio transport; AST transformer; and host-side global-install
// utils. The SDK imports only node: built-ins, acorn, astring, and
// esbuild-wasm — never Aves' runner/policy/run-store/config/skill/
// mcp modules. Permission brokering (the BrokerPolicy decision
// chain) is host-owned and lives in src/host/policy.ts.
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
export { StdioTransport } from "./transport.ts";
export { type InputFn, installPromptInput, type Restore } from "./utils.ts";
export { rewriteReferences, transform } from "./transform.ts";
