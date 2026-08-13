// ============================================================
// src/repl/mod.ts — Aves REPL SDK public surface
//
// Host-neutral REPL machinery: in-process kernel, stdio transport,
// AST transformer. The SDK imports only node: built-ins, acorn,
// astring, and esbuild-wasm — never Aves' runner/policy/run-store/
// config/skill/mcp modules. Permission brokering (the BrokerPolicy
// decision chain) is host-owned and lives in src/host/policy.ts.
// ============================================================

export type {
  MimeBundle,
  ReplEvalResult,
  ReplKernel,
  ReplKernelOptions,
  ReplOutputEvent,
  ReplRuntime,
  ReplSnapshot,
} from "./types.ts";

export { EvalEngine } from "./eval-engine.ts";
export { createReplKernel } from "./kernel.ts";
export { StdioTransport } from "./transport.ts";
export { rewriteReferences, transform } from "./transform.ts";
