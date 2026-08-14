// ============================================================
// src/repl/utils_test.ts — global-install utils
//
// installPromptInput is a host-side helper that wires global
// prompt/confirm to an async input channel. The kernel never uses
// it; these tests verify routing, restore behavior, and that
// nothing leaks across tests.
// ============================================================

import { assertEquals } from "@std/assert";
import { type InputFn, installPromptInput } from "./utils.ts";

Deno.test("utils - prompt input binds async prompt/confirm", async () => {
  const calls: Array<{ prompt: string; password: boolean }> = [];
  const input: InputFn = (prompt, options) => {
    calls.push({ prompt, password: options?.password ?? false });
    return Promise.resolve("42");
  };
  const restore = installPromptInput(input);
  try {
    const g = globalThis as Record<string, unknown>;
    const v = await (g.prompt as (message?: string) => Promise<string>)("num?");
    assertEquals(v, "42");
    assertEquals(calls.length, 1);
    assertEquals(calls[0].prompt, "num?");
    assertEquals(calls[0].password, false);
  } finally {
    restore();
  }
});

Deno.test("utils - prompt input restore removes globals", () => {
  const g = globalThis as Record<string, unknown>;
  const before = g.prompt;
  const restore = installPromptInput(() => Promise.resolve(""));
  assertEquals(typeof g.prompt, "function");
  restore();
  assertEquals(g.prompt, before);
});

Deno.test("utils - using restore undoes the install on block exit", () => {
  const g = globalThis as Record<string, unknown>;
  const before = g.prompt;
  {
    using _ = installPromptInput(() => Promise.resolve(""));
    assertEquals(typeof g.prompt, "function");
  }
  assertEquals(g.prompt, before);
});
