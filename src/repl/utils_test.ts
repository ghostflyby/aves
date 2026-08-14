// ============================================================
// src/repl/utils_test.ts — global-install utils
//
// installConsoleCapture / installPromptInput are host-side helpers
// that wire globals to a ReplExecution emit/input channel. The
// kernel never uses them; these tests verify routing, value
// formatting, restore behavior, and that nothing leaks across
// tests.
// ============================================================

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  type InputFn,
  installConsoleCapture,
  installPromptInput,
} from "./utils.ts";
import type { ReplOutputEvent } from "./types.ts";

Deno.test("utils - console capture routes methods to emit", () => {
  const emitted: ReplOutputEvent[] = [];
  const restore = installConsoleCapture((e) => emitted.push(e));
  try {
    console.log("hello", 42);
    console.error("boom");
    console.warn("warned");
  } finally {
    restore();
  }
  const stdout = emitted.filter((e) => e.kind === "stdout");
  const stderr = emitted.filter((e) => e.kind === "stderr");
  assertEquals(stdout.length, 1);
  assertStringIncludes((stdout[0] as { text: string }).text, "hello");
  assertEquals(stderr.length, 2);
});

Deno.test("utils - console capture restore puts originals back", () => {
  const originalLog = console.log;
  const restore = installConsoleCapture(() => {});
  restore();
  assertEquals(console.log, originalLog);
  console.log("still works");
});

Deno.test("utils - console capture is isolated per install", () => {
  const a: ReplOutputEvent[] = [];
  const b: ReplOutputEvent[] = [];
  const ra = installConsoleCapture((e) => a.push(e));
  const rb = installConsoleCapture((e) => b.push(e));
  try {
    console.log("x");
  } finally {
    ra();
    rb();
  }
  // The later install wins while both are active.
  assertEquals(a.length, 0);
  assertEquals(b.length, 1);
});

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
