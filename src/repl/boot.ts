// ============================================================
// src/repl/boot.ts — default stdio child entry (Aves' reference
// assembly)
//
// createReplKernel + StdioTransport over stdin/stdout. This is
// the SDK's default transport for hosts that use a stdio child
// (the MCP repl_create/repl_eval/repl_close path). External hosts
// write their own entry bound to their own transport (design doc
// §5.4).
//
// Wire protocol (unchanged): newline-JSON `eval` / `result` /
// `close` / `closed` with optional `timeout_ms`.
// ============================================================

import { createReplKernel } from "./kernel.ts";
import { StdioTransport } from "./transport.ts";

const kernel = await createReplKernel({
  runtime: {
    emit() {
      // Console output is intentionally not captured in stdio mode
      // (consoleCapture "off"): the child's stdout carries only JSON
      // protocol lines, matching the legacy boot behavior.
    },
    requestInput() {
      return Promise.reject(
        new Error("prompt()/confirm() are not supported in stdio mode"),
      );
    },
  },
  consoleCapture: "off",
  installPrompt: false,
});

await StdioTransport.attach(kernel, Deno.stdin, Deno.stdout);
