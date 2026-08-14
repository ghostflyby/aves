// ============================================================
// src/repl/utils_test.ts — global-install utils
//
// installPromptInput / installConsoleCapture are host-side helpers
// that wire globals to an input channel / output sink. The kernel
// never uses them; these tests verify routing, restore behavior,
// and that nothing leaks across tests.
// ============================================================

import { assertEquals } from "@std/assert";
import {
  type InputFn,
  installConsoleCapture,
  installPromptInput,
} from "./utils.ts";

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

Deno.test("utils - console capture routes methods to the sink", () => {
  const emitted: Array<{ kind: "stdout" | "stderr"; text: string }> = [];
  const restore = installConsoleCapture((kind, text) =>
    emitted.push({ kind, text })
  );
  try {
    console.log("hello", 42);
    console.warn("careful");
    console.error("boom");
    console.trace("traced");
    console.assert(false, "asserted");
  } finally {
    restore();
  }
  assertEquals(emitted.length, 5);
  assertEquals(emitted[0], { kind: "stdout", text: "hello 42" });
  assertEquals(emitted[1].kind, "stderr");
  assertEquals(emitted[1].text, "careful");
  assertEquals(emitted[2].text, "boom");
  assertEquals(emitted[3].text, "traced");
  assertEquals(emitted[4].text, "asserted");
});

Deno.test("utils - console capture restore puts originals back", () => {
  const originalLog = console.log;
  const restore = installConsoleCapture(() => {});
  restore();
  assertEquals(console.log, originalLog);
});
