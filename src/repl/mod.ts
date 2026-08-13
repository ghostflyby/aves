// ============================================================
// src/repl/mod.ts — Aves REPL SDK public surface
//
// Host-neutral REPL machinery: in-process kernel, stdio transport,
// example default policy, AST transformer. The SDK imports only
// node: built-ins, acorn, astring, and esbuild-wasm — never Aves'
// runner/policy/run-store/config/skill/mcp modules.
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
export {
  createRunBrokerPolicy,
  DEFAULT_IMPORT_DOMAINS,
  isDefaultAllowed,
  type MidDecideHook,
  pathMatches,
  type RunElicitContext,
} from "./policy.ts";
export { rewriteReferences, transform } from "./transform.ts";
