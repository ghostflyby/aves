// ============================================================
// src/repl/kernel_test.ts — createReplKernel unit tests
//
// Exercises the in-process kernel: FIFO serialization, scope
// persistence, top-level await, per-execution output streams,
// emit port, interrupt, AbortSignal cancellation, snapshot/reset.
// No child processes are involved.
// ============================================================

import { assertEquals, assertStringIncludes } from "@std/assert";
import { createReplKernel } from "./kernel.ts";
import type {
  ReplEvalResult,
  ReplExecution,
  ReplOutputEvent,
} from "./types.ts";

async function collect(ex: ReplExecution): Promise<ReplOutputEvent[]> {
  const events: ReplOutputEvent[] = [];
  await ex.outputs.pipeTo(
    new WritableStream<ReplOutputEvent>({
      write(event) {
        events.push(event);
      },
    }),
  );
  return events;
}

async function evalCollect(
  kernel: {
    execute(code: string, options?: { signal?: AbortSignal }): ReplExecution;
  },
  code: string,
  options?: { signal?: AbortSignal },
): Promise<{ result: ReplEvalResult; events: ReplOutputEvent[] }> {
  const ex = kernel.execute(code, options);
  const eventsP = collect(ex);
  const result = await ex.result;
  return { result, events: await eventsP };
}

Deno.test("kernel - persists declarations across evals", async () => {
  const kernel = await createReplKernel();
  const r1 = await evalCollect(kernel, "const x = 1");
  assertEquals(r1.result.ok, true);
  const r2 = await evalCollect(kernel, "x + 1");
  assertEquals(r2.result.ok, true);
  assertEquals(r2.result.data, 2);
  await kernel.dispose();
});

Deno.test("kernel - auto-returns final expression", async () => {
  const kernel = await createReplKernel();
  const { result } = await evalCollect(kernel, "1 + 1");
  assertEquals(result.ok, true);
  assertEquals(result.data, 2);
  await kernel.dispose();
});

Deno.test("kernel - top-level await", async () => {
  const kernel = await createReplKernel();
  const { result } = await evalCollect(
    kernel,
    "const p = await Promise.resolve(99); p + 1",
  );
  assertEquals(result.ok, true);
  assertEquals(result.data, 100);
  await kernel.dispose();
});

Deno.test("kernel - runtime error yields ok:false with message", async () => {
  const kernel = await createReplKernel();
  const { result } = await evalCollect(kernel, 'throw new Error("boom")');
  assertEquals(result.ok, false);
  assertStringIncludes(result.error ?? "", "boom");
  await kernel.dispose();
});

Deno.test("kernel - class declaration persists across evals", async () => {
  const kernel = await createReplKernel();
  const r1 = await evalCollect(kernel, "class Foo { static v = 42 }");
  assertEquals(r1.result.ok, true);
  const r2 = await evalCollect(kernel, "Foo.v");
  assertEquals(r2.result.ok, true);
  assertEquals(r2.result.data, 42);
  await kernel.dispose();
});

Deno.test("kernel - emit routes events into the execution stream", async () => {
  const kernel = await createReplKernel();
  const ex = kernel.execute("await new Promise(r => setTimeout(r, 20)); 1");
  ex.emit({ kind: "stdout", text: "hello" });
  ex.emit({ kind: "display", data: { "text/html": "<b>x</b>" }, metadata: {} });
  const result = await ex.result;
  const events = await collect(ex);
  assertEquals(result.ok, true);
  assertEquals(result.data, 1);
  assertEquals(events, [
    { kind: "stdout", text: "hello" },
    { kind: "display", data: { "text/html": "<b>x</b>" }, metadata: {} },
  ]);
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
  assertEquals(r.result.data, "a-start,a-end,b");
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

Deno.test("kernel - abort() aborts only that execution", async () => {
  const kernel = await createReplKernel();
  const ex = kernel.execute("await new Promise(r => setTimeout(r, 5000)); 1");
  ex.abort();
  const result = await ex.result;
  assertEquals(result.ok, false);
  assertStringIncludes(result.error ?? "", "interrupt");
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
  assertEquals(r.result.ok, true);
  assertEquals(r.result.data, "undefined");
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
