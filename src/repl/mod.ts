// ============================================================
// src/repl/mod.ts — Aves REPL SDK — common basics
//
// The everyday entry point: `createReplKernel` plus the core types
// (execution handle, results, snapshot, options, transformer
// contract). For advanced customization import the sub-paths:
//
//   @ghostflyby/aves/repl/transform — AST cell transformer
//     (transform / rewriteReferences) for hosts that assemble
//     their own pipeline or swap the esbuild backend.
//   @ghostflyby/aves/repl/engine    — the bare EvalEngine (no
//     FIFO queue, no cancellation) for hosts that drive evaluation
//     themselves.
//
// The SDK imports only node: built-ins, acorn, astring, and
// esbuild-wasm — never Aves' runner/policy/run-store/config/skill/
// mcp modules. Transports, permission brokering, and global wiring
// (console.*, prompt, Deno.jupyter.*) are host-owned
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

export { createReplKernel } from "./kernel.ts";
