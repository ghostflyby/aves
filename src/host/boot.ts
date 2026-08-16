// ============================================================
// src/host/boot.ts — Aves' stdio child entry
//
// createReplKernel + StdioTransport over stdin/stdout. Aves' host
// transport for the MCP repl_create/repl_eval/repl_close path
// (design doc §5.4); external hosts write their own entry bound to
// their own transport.
//
// Wire protocol (unchanged): newline-JSON `eval` / `result` /
// `close` / `closed` with optional `timeout_ms`.
// ============================================================

import { createReplKernel } from "../repl/kernel.ts";
import { StdioTransport } from "./transport.ts";

const kernel = await createReplKernel();

// Console output is intentionally not captured in stdio mode: the child's
// stdout carries only JSON protocol lines, matching the legacy boot behavior.
await StdioTransport.attach(kernel, Deno.stdin, Deno.stdout);
