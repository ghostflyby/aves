// ============================================================
// src/repl/mod.ts — Aves REPL SDK public surface
//
// Host-neutral REPL machinery: in-process kernel with per-execution
// output streams, stdio transport, AST transformer, and host-side
// global-install utils. The SDK imports only node: built-ins,
// acorn, astring, and esbuild-wasm — never Aves' runner/policy/
// run-store/config/skill/mcp modules. Permission brokering (the
// BrokerPolicy decision chain) is host-owned and lives in
// src/host/policy.ts.
// ============================================================

export type {
  CodeTransform,
  MimeBundle,
  ReplEvalResult,
  ReplExecution,
  ReplKernel,
  ReplKernelOptions,
  ReplOutputEvent,
  ReplSnapshot,
} from "./types.ts";

export { EvalEngine } from "./eval-engine.ts";
export { createReplKernel } from "./kernel.ts";
export { StdioTransport } from "./transport.ts";
export {
  type InputFn,
  installConsoleCapture,
  installPromptInput,
} from "./utils.ts";
export { rewriteReferences, transform } from "./transform.ts";
