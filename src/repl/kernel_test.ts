// ============================================================
// src/repl/kernel_test.ts — createReplKernel unit tests
//
// Exercises the in-process kernel against a fake ReplRuntime:
// scope persistence, top-level await, console capture modes,
// prompt round-trip, interrupt, reset, and timeout. No child
// processes are involved.
// ============================================================

import { assertEquals, assertStringIncludes } from "@std/assert";
import { createReplKernel } from "./kernel.ts";
import type { ReplOutputEvent, ReplRuntime } from "./types.ts";

interface FakeRuntimeOpts {
  onEmit?: (event: ReplOutputEvent) => void;
  inputAnswer?: string;
  inputHook?: (prompt: string, password: boolean) => Promise<string>;
}

function makeRuntime(opts: FakeRuntimeOpts = {}): {
  runtime: ReplRuntime;
  emitted: ReplOutputEvent[];
  inputRequests: Array<{ prompt: string; password: boolean }>;
  evalStarts: number;
  evalEnds: number;
} {
  const emitted: ReplOutputEvent[] = [];
  const inputRequests: Array<{ prompt: string; password: boolean }> = [];
  const state = {
    runtime: {
      emit: (event: ReplOutputEvent) => {
        emitted.push(event);
        opts.onEmit?.(event);
      },
      requestInput: (prompt: string, password: boolean) => {
        inputRequests.push({ prompt, password });
        return opts.inputHook
          ? opts.inputHook(prompt, password)
          : Promise.resolve(opts.inputAnswer ?? "");
      },
      onEvalStart: () => {
        state.evalStarts++;
      },
      onEvalEnd: () => {
        state.evalEnds++;
      },
    } as ReplRuntime,
    emitted,
    inputRequests,
    evalStarts: 0,
    evalEnds: 0,
  };
  return state;
}

Deno.test("kernel - persists declarations across evals", async () => {
  const { runtime } = makeRuntime();
  const kernel = await createReplKernel({ runtime });
  const r1 = await kernel.eval("const x = 1");
  assertEquals(r1.ok, true);
  const r2 = await kernel.eval("x + 1");
  assertEquals(r2.ok, true);
  assertEquals(r2.data, 2);
  await kernel.dispose();
});

Deno.test("kernel - auto-returns final expression", async () => {
  const { runtime } = makeRuntime();
  const kernel = await createReplKernel({ runtime });
  const r = await kernel.eval("1 + 1");
  assertEquals(r.ok, true);
  assertEquals(r.data, 2);
  await kernel.dispose();
});

Deno.test("kernel - top-level await", async () => {
  const { runtime } = makeRuntime();
  const kernel = await createReplKernel({ runtime });
  const r = await kernel.eval("const p = await Promise.resolve(99); p + 1");
  assertEquals(r.ok, true);
  assertEquals(r.data, 100);
  await kernel.dispose();
});

Deno.test("kernel - runtime error yields ok:false with message", async () => {
  const { runtime } = makeRuntime();
  const kernel = await createReplKernel({ runtime });
  const r = await kernel.eval('throw new Error("boom")');
  assertEquals(r.ok, false);
  assertStringIncludes(r.error ?? "", "boom");
  await kernel.dispose();
});

Deno.test("kernel - class declaration persists across evals", async () => {
  const { runtime } = makeRuntime();
  const kernel = await createReplKernel({ runtime });
  const r1 = await kernel.eval("class Foo { static v = 42 }");
  assertEquals(r1.ok, true);
  const r2 = await kernel.eval("Foo.v");
  assertEquals(r2.ok, true);
  assertEquals(r2.data, 42);
  await kernel.dispose();
});

Deno.test("kernel - consoleCapture protocol routes console.log to stdout events", async () => {
  const { runtime, emitted } = makeRuntime();
  const kernel = await createReplKernel({
    runtime,
    consoleCapture: "protocol",
  });
  const r = await kernel.eval('console.log("hello", 42); 1');
  assertEquals(r.ok, true);
  const stdoutEvents = emitted.filter((e) => e.kind === "stdout");
  assertEquals(stdoutEvents.length, 1);
  assertStringIncludes((stdoutEvents[0] as { text: string }).text, "hello");
  await kernel.dispose();
});

Deno.test("kernel - consoleCapture off leaves console untouched", async () => {
  const { runtime, emitted } = makeRuntime();
  const kernel = await createReplKernel({ runtime, consoleCapture: "off" });
  const r = await kernel.eval('console.log("silent"); 1');
  assertEquals(r.ok, true);
  assertEquals(emitted.filter((e) => e.kind === "stdout").length, 0);
  await kernel.dispose();
});

Deno.test("kernel - prompt round-trips through runtime.requestInput", async () => {
  const { runtime, inputRequests } = makeRuntime({ inputAnswer: "42" });
  const kernel = await createReplKernel({ runtime, installPrompt: true });
  // requestInput is asynchronous (e.g. a Jupyter input_request round-trip),
  // so the installed prompt()/confirm() return promises user code must await.
  const r = await kernel.eval("const v = await prompt('num?'); Number(v) + 1");
  assertEquals(r.ok, true);
  assertEquals(inputRequests.length, 1);
  assertEquals(inputRequests[0].prompt, "num?");
  assertEquals(inputRequests[0].password, false);
  assertEquals(r.data, 43);
  await kernel.dispose();
});

Deno.test("kernel - interrupt rejects the in-flight eval", async () => {
  const { runtime } = makeRuntime();
  const kernel = await createReplKernel({ runtime });
  const p = kernel.eval("await new Promise(r => setTimeout(r, 5000)); 1");
  setTimeout(() => kernel.interrupt(), 50);
  const r = await p;
  assertEquals(r.ok, false);
  assertStringIncludes(r.error ?? "", "interrupt");
  await kernel.dispose();
});

Deno.test("kernel - timeout rejects with ok:false", async () => {
  const { runtime } = makeRuntime();
  const kernel = await createReplKernel({ runtime });
  const r = await kernel.eval(
    "await new Promise(r => setTimeout(r, 5000)); 1",
    { timeoutMs: 50 },
  );
  assertEquals(r.ok, false);
  assertStringIncludes(r.error ?? "", "timed out");
  await kernel.dispose();
});

Deno.test("kernel - snapshot returns declared names and values", async () => {
  const { runtime } = makeRuntime();
  const kernel = await createReplKernel({ runtime });
  await kernel.eval("const a = 1; let b = 2;");
  const snap = kernel.snapshot();
  assertEquals(snap.declaredNames.includes("a"), true);
  assertEquals(snap.declaredNames.includes("b"), true);
  assertEquals(snap.values.a, 1);
  await kernel.dispose();
});

Deno.test("kernel - reset clears scope and names", async () => {
  const { runtime } = makeRuntime();
  const kernel = await createReplKernel({ runtime });
  await kernel.eval("const a = 1");
  kernel.reset();
  const r = await kernel.eval("typeof a");
  assertEquals(r.ok, true);
  assertEquals(r.data, "undefined");
  await kernel.dispose();
});

Deno.test("kernel - busy/idle hooks fire around eval", async () => {
  const state = makeRuntime();
  const kernel = await createReplKernel({ runtime: state.runtime });
  await kernel.eval("1");
  // Read counters off the state object — destructuring would copy the
  // pre-eval primitives.
  assertEquals(state.evalStarts, 1);
  assertEquals(state.evalEnds, 1);
  await kernel.dispose();
});
