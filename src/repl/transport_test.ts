// ============================================================
// src/repl/transport_test.ts — StdioTransport framing tests
//
// Pure I/O: drives StdioTransport against in-memory reader/writer
// streams and a stub kernel. No subprocess is involved. Verifies
// the legacy wire protocol byte-for-byte: `eval` / `result` /
// `close` / `closed`, optional `timeout_ms`, malformed-line
// tolerance, and non-serializable result fallback.
// ============================================================

import { assertEquals } from "@std/assert";
import { StdioTransport } from "./transport.ts";
import type { ReplEvalResult, ReplKernel } from "./types.ts";

class MemReader {
  private chunks: Uint8Array[];
  private pos = 0;
  constructor(text: string) {
    this.chunks = [new TextEncoder().encode(text)];
  }
  read(buf: Uint8Array): Promise<number | null> {
    if (this.pos >= this.chunks.length) return Promise.resolve(null);
    const chunk = this.chunks[this.pos];
    const n = Math.min(buf.length, chunk.length);
    buf.set(chunk.subarray(0, n));
    if (n === chunk.length) this.pos++;
    else this.chunks[this.pos] = chunk.subarray(n);
    return Promise.resolve(n);
  }
}

class MemWriter {
  text = "";
  write(bytes: Uint8Array): Promise<number> {
    this.text += new TextDecoder().decode(bytes);
    return Promise.resolve(bytes.length);
  }
}

function stubKernel(handler: {
  eval(code: string, options?: { timeoutMs?: number }): Promise<ReplEvalResult>;
}): ReplKernel {
  return {
    eval: handler.eval,
    interrupt() {},
    snapshot() {
      return { declaredNames: [], values: {} };
    },
    reset() {},
    async dispose() {},
  };
}

Deno.test("transport - eval result round-trip", async () => {
  const writer = new MemWriter();
  const reader = new MemReader(
    '{"type":"eval","id":"1","code":"1+1"}\n{"type":"close"}\n',
  );
  const kernel = stubKernel({
    eval: () => Promise.resolve({ ok: true, data: 2 }),
  });
  await StdioTransport.attach(kernel, reader, writer);
  const lines = writer.text.trim().split("\n").map((l) => JSON.parse(l));
  assertEquals(lines.length, 2);
  assertEquals(lines[0].type, "result");
  assertEquals(lines[0].id, "1");
  assertEquals(lines[0].ok, true);
  assertEquals(lines[0].data, 2);
  assertEquals(lines[1], { type: "closed" });
});

Deno.test("transport - forwards timeout_ms to kernel.eval", async () => {
  const writer = new MemWriter();
  const reader = new MemReader(
    '{"type":"eval","id":"1","code":"x","timeout_ms":123}\n{"type":"close"}\n',
  );
  let seenTimeout: number | undefined;
  const kernel = stubKernel({
    eval: (_code, options) => {
      seenTimeout = options?.timeoutMs;
      return Promise.resolve({ ok: false, error: "REPL eval timed out" });
    },
  });
  await StdioTransport.attach(kernel, reader, writer);
  assertEquals(seenTimeout, 123);
});

Deno.test("transport - result failure carries error", async () => {
  const writer = new MemWriter();
  const reader = new MemReader(
    '{"type":"eval","id":"1","code":"boom"}\n{"type":"close"}\n',
  );
  const kernel = stubKernel({
    eval: () => Promise.resolve({ ok: false, error: "boom" }),
  });
  await StdioTransport.attach(kernel, reader, writer);
  const lines = writer.text.trim().split("\n").map((l) => JSON.parse(l));
  assertEquals(lines[0].ok, false);
  assertEquals(lines[0].error, "boom");
});

Deno.test("transport - non-serializable result falls back to error", async () => {
  const writer = new MemWriter();
  const reader = new MemReader(
    '{"type":"eval","id":"1","code":"1"}\n{"type":"close"}\n',
  );
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const kernel = stubKernel({
    eval: () => Promise.resolve({ ok: true, data: circular }),
  });
  await StdioTransport.attach(kernel, reader, writer);
  const lines = writer.text.trim().split("\n").map((l) => JSON.parse(l));
  assertEquals(lines[0].ok, false);
  assertEquals(typeof lines[0].error, "string");
});

Deno.test("transport - malformed lines are ignored", async () => {
  const writer = new MemWriter();
  const reader = new MemReader(
    "garbage\nnot-json\n" +
      '{"type":"eval","id":"1","code":"1"}\n{"type":"close"}\n',
  );
  const kernel = stubKernel({
    eval: () => Promise.resolve({ ok: true, data: 1 }),
  });
  await StdioTransport.attach(kernel, reader, writer);
  const lines = writer.text.trim().split("\n").map((l) => JSON.parse(l));
  assertEquals(lines.length, 2);
  assertEquals(lines[0].id, "1");
});

Deno.test("transport - EOF without close ends the loop", async () => {
  const writer = new MemWriter();
  const reader = new MemReader('{"type":"eval","id":"1","code":"1"}\n');
  const kernel = stubKernel({
    eval: () => Promise.resolve({ ok: true, data: 1 }),
  });
  await StdioTransport.attach(kernel, reader, writer);
  const lines = writer.text.trim().split("\n");
  assertEquals(lines.length, 1);
});
