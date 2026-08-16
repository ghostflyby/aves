// ============================================================
// src/repl/kernel_test.ts — createReplKernel unit tests
//
// Exercises the in-process kernel: FIFO serialization, scope
// persistence, top-level await, final-expression results,
// interrupt, AbortSignal cancellation, snapshot/reset. No child
// processes are involved.
// ============================================================

import {
  assertEquals,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { createReplKernel } from "./kernel.ts";
import type { ReplEvalResult, ReplExecution } from "./types.ts";

async function evalCollect(
  kernel: {
    execute(code: string, options?: { signal?: AbortSignal }): ReplExecution;
  },
  code: string,
  options?: { signal?: AbortSignal },
): Promise<ReplEvalResult> {
  return await kernel.execute(code, options).result;
}

Deno.test("kernel - persists declarations across evals", async () => {
  const kernel = await createReplKernel();
  const r1 = await evalCollect(kernel, "const x = 1");
  assertEquals(r1.ok, true);
  const r2 = await evalCollect(kernel, "x + 1");
  assertEquals(r2.ok, true);
  assertEquals(r2.data, 2);
  await kernel.dispose();
});

Deno.test("kernel - auto-returns final expression", async () => {
  const kernel = await createReplKernel();
  const result = await evalCollect(kernel, "1 + 1");
  assertEquals(result.ok, true);
  assertEquals(result.data, 2);
  await kernel.dispose();
});

Deno.test("kernel - top-level await", async () => {
  const kernel = await createReplKernel();
  const result = await evalCollect(
    kernel,
    "const p = await Promise.resolve(99); p + 1",
  );
  assertEquals(result.ok, true);
  assertEquals(result.data, 100);
  await kernel.dispose();
});

Deno.test("kernel - runtime error yields ok:false with message", async () => {
  const kernel = await createReplKernel();
  const result = await evalCollect(kernel, 'throw new Error("boom")');
  assertEquals(result.ok, false);
  assertStringIncludes(result.error ?? "", "boom");
  await kernel.dispose();
});

Deno.test("kernel - class declaration persists across evals", async () => {
  const kernel = await createReplKernel();
  const r1 = await evalCollect(kernel, "class Foo { static v = 42 }");
  assertEquals(r1.ok, true);
  const r2 = await evalCollect(kernel, "Foo.v");
  assertEquals(r2.ok, true);
  assertEquals(r2.data, 42);
  await kernel.dispose();
});

Deno.test("kernel - user may use a variable named scope", async () => {
  // The injection parameter is `$aves$scope`, so `scope` is an ordinary user
  // identifier that persists like any other declared name.
  const kernel = await createReplKernel();
  const r1 = await evalCollect(kernel, "const scope = 5; scope + 1");
  assertEquals(r1.ok, true);
  assertEquals(r1.data, 6);
  const r2 = await evalCollect(kernel, "scope + 1");
  assertEquals(r2.ok, true);
  assertEquals(r2.data, 6);
  await kernel.dispose();
});

Deno.test("kernel - method closures resolve persistent names", async () => {
  // Regression for the `this`-binding scheme: the scope travels via the
  // `$aves$scope` parameter, so methods called with another `this` still
  // resolve declared names correctly (lexical capture).
  const kernel = await createReplKernel();
  const r1 = await evalCollect(
    kernel,
    "const y = 7; class A { m() { return y } }",
  );
  assertEquals(r1.ok, true);
  const r2 = await evalCollect(kernel, "new A().m()");
  assertEquals(r2.ok, true);
  assertEquals(r2.data, 7);
  await kernel.dispose();
});

Deno.test("kernel - object method and static class field closures resolve", async () => {
  const kernel = await createReplKernel();
  const r1 = await evalCollect(
    kernel,
    "const q = 3; const obj = { m() { return q } }; const base = 10; class B { static v = base }",
  );
  assertEquals(r1.ok, true);
  const r2 = await evalCollect(kernel, "obj.m()");
  assertEquals(r2.ok, true);
  assertEquals(r2.data, 3);
  const r3 = await evalCollect(kernel, "B.v");
  assertEquals(r3.ok, true);
  assertEquals(r3.data, 10);
  await kernel.dispose();
});

Deno.test("kernel - FIFO serialization across queued executions", async () => {
  const kernel = await createReplKernel();
  await evalCollect(kernel, "const log: string[] = []");
  const a = kernel.execute(
    "log.push('a-start'); await new Promise(r => setTimeout(r, 30)); log.push('a-end'); 1",
  );
  const b = kernel.execute("log.push('b'); 2");
  await a.result;
  await b.result;
  const r = await evalCollect(kernel, "log.join(',')");
  assertEquals(r.data, "a-start,a-end,b");
  await kernel.dispose();
});

Deno.test("kernel - interrupt aborts the in-flight execution", async () => {
  const kernel = await createReplKernel();
  const ex = kernel.execute(
    "await new Promise(r => setTimeout(r, 5000)); 1",
  );
  setTimeout(() => kernel.interrupt(), 30);
  const result = await ex.result;
  assertEquals(result.ok, false);
  assertStringIncludes(result.error ?? "", "interrupt");
  await kernel.dispose();
});

Deno.test("kernel - aborting the host signal cancels that execution", async () => {
  const kernel = await createReplKernel();
  const ac = new AbortController();
  const ex = kernel.execute(
    "await new Promise(r => setTimeout(r, 5000)); 1",
    { signal: ac.signal },
  );
  ac.abort();
  const result = await ex.result;
  assertEquals(result.ok, false);
  assertStringIncludes(result.error ?? "", "interrupt");
  await kernel.dispose();
});

Deno.test("kernel - controller.abort() cancels the execution", async () => {
  const kernel = await createReplKernel();
  const ex = kernel.execute("await new Promise(r => setTimeout(r, 5000)); 1");
  ex.controller.abort();
  const result = await ex.result;
  assertEquals(result.ok, false);
  assertStringIncludes(result.error ?? "", "interrupt");
  await kernel.dispose();
});

Deno.test("kernel - host signal abort propagates to controller.signal", async () => {
  const kernel = await createReplKernel();
  const ac = new AbortController();
  const ex = kernel.execute(
    "await new Promise(r => setTimeout(r, 5000)); 1",
    { signal: ac.signal },
  );
  ac.abort();
  // The external token's abort is observable on the execution's own signal.
  assertEquals(ex.signal.aborted, true);
  const result = await ex.result;
  assertEquals(result.ok, false);
  await kernel.dispose();
});

Deno.test("kernel - current points to the in-flight execution", async () => {
  const kernel = await createReplKernel();
  const ex = kernel.execute(
    "await new Promise(r => setTimeout(r, 40)); 1",
  );
  // A queued second execution must not become `current` while the first runs.
  const queued = kernel.execute("2");
  // Identity, not deep equality: `current` references the exact handle.
  assertStrictEquals(kernel.current, ex);
  assertStrictEquals(kernel.current === queued, false);
  await ex.result;
  await queued.result;
  // Let the pump finish its loop (it nulls `current` after the last runOne).
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertStrictEquals(kernel.current, null);
  await kernel.dispose();
});

Deno.test("kernel - detaches host signal listener after settle", async () => {
  const kernel = await createReplKernel();
  const hostAc = new AbortController();
  const ex = kernel.execute("1 + 1", { signal: hostAc.signal });
  const result = await ex.result;
  assertEquals(result.ok, true);
  // After settle the bridge listener is gone: aborting the long-lived host
  // signal must not abort this (finished) execution's controller.
  hostAc.abort();
  assertEquals(ex.controller.signal.aborted, false);
  await kernel.dispose();
});

Deno.test("kernel - AbortSignal.timeout aborts with timeout message", async () => {
  const kernel = await createReplKernel();
  const ex = kernel.execute(
    "await new Promise(r => setTimeout(r, 5000)); 1",
    { signal: AbortSignal.timeout(30) },
  );
  const result = await ex.result;
  assertEquals(result.ok, false);
  assertStringIncludes(result.error ?? "", "timed out");
  await kernel.dispose();
});

Deno.test("kernel - pre-aborted signal skips the execution", async () => {
  const kernel = await createReplKernel();
  const ac = new AbortController();
  ac.abort();
  const ex = kernel.execute("1", { signal: ac.signal });
  const result = await ex.result;
  assertEquals(result.ok, false);
  await kernel.dispose();
});

Deno.test("kernel - injected transform is used and receives loader/format", async () => {
  let called = 0;
  const transform = (
    code: string,
    options: { loader: "ts"; format: "esm" },
  ) => {
    called++;
    assertEquals(options.loader, "ts");
    assertEquals(options.format, "esm");
    return Promise.resolve({ code }); // passthrough; the transformer runs it directly below
  };
  const kernel = await createReplKernel({ transform });
  const result = await evalCollect(kernel, "1 + 1");
  assertEquals(result.ok, true);
  assertEquals(result.data, 2);
  assertEquals(called, 1);
  await kernel.dispose();
});

Deno.test("kernel - custom transform still runs through the AST pipeline", async () => {
  // A hand-written passthrough transform (no esbuild-wasm dependency):
  // transform.ts still rewrites declarations into the persistent scope.
  const transform = (code: string) => Promise.resolve({ code });
  const kernel = await createReplKernel({ transform });
  const r1 = await evalCollect(kernel, "const deep = 1");
  assertEquals(r1.ok, true);
  const r2 = await evalCollect(kernel, "deep + 1");
  assertEquals(r2.ok, true);
  assertEquals(r2.data, 2);
  await kernel.dispose();
});

Deno.test("kernel - injected transform errors propagate as cell errors", async () => {
  const transform = (): Promise<{ code: string }> =>
    Promise.reject(new Error("transform exploded"));
  const kernel = await createReplKernel({ transform });
  const result = await evalCollect(kernel, "1");
  assertEquals(result.ok, false);
  assertStringIncludes(result.error ?? "", "transform exploded");
  await kernel.dispose();
});

Deno.test("kernel - default transform backend still works", async () => {
  // Regression: no options -> process-global esbuild-wasm singleton.
  const kernel = await createReplKernel();
  const result = await evalCollect(kernel, "const x: number = 1; x + 1");
  assertEquals(result.ok, true);
  assertEquals(result.data, 2);
  await kernel.dispose();
});

Deno.test("kernel - executionId increments monotonically", async () => {
  const kernel = await createReplKernel();
  const a = kernel.execute("1");
  const b = kernel.execute("2");
  await a.result;
  await b.result;
  assertEquals(b.executionId, a.executionId + 1);
  await kernel.dispose();
});

Deno.test("kernel - snapshot returns declared names and values", async () => {
  const kernel = await createReplKernel();
  await evalCollect(kernel, "const a = 1; let b = 2");
  const snap = kernel.snapshot();
  assertEquals(snap.names.includes("a"), true);
  assertEquals(snap.names.includes("b"), true);
  assertEquals(snap.values.a, 1);
  await kernel.dispose();
});

Deno.test("kernel - reset clears scope and names", async () => {
  const kernel = await createReplKernel();
  await evalCollect(kernel, "const a = 1");
  kernel.reset();
  const r = await evalCollect(kernel, "typeof a");
  assertEquals(r.ok, true);
  assertEquals(r.data, "undefined");
  await kernel.dispose();
});

Deno.test("kernel - dispose rejects pending and future executions", async () => {
  const kernel = await createReplKernel();
  const ex = kernel.execute("await new Promise(r => setTimeout(r, 5000)); 1");
  await kernel.dispose();
  const result = await ex.result;
  assertEquals(result.ok, false);
  const after = kernel.execute("1");
  assertEquals((await after.result).ok, false);
});

Deno.test("kernel - await using disposes the kernel on block exit", async () => {
  const ex = (async () => {
    await using kernel = await createReplKernel();
    await evalCollect(kernel, "const x = 1");
    return kernel;
  })();
  const kernel = await ex;
  // After the block, the kernel is disposed: new executions fail.
  const after = kernel.execute("1");
  assertEquals((await after.result).ok, false);
});
