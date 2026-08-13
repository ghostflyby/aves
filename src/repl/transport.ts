// ============================================================
// src/repl/transport.ts — StdioTransport
//
// Newline-delimited JSON codec for child processes whose
// stdin/stdout is the channel. PURE I/O: it parses `eval` /
// `result` / `close` / `closed` / `timeout_ms` lines and drives a
// ReplKernel, but never spawns or supervises a process (design
// doc §5.4). The wire protocol is byte-identical to Aves' legacy
// repl-boot child.
// ============================================================

import type { ReplEvalResult, ReplKernel } from "./types.ts";

interface StdioReader {
  read(buf: Uint8Array): Promise<number | null>;
}

interface StdioWriter {
  write(buf: Uint8Array): Promise<number>;
}

export class StdioTransport {
  /**
   * Drive `kernel` from a stdin/stdout channel until the child sends
   * `{"type":"close"}` (responds `{"type":"closed"}` and returns) or stdin
   * reaches EOF. Malformed lines are ignored, matching the legacy child.
   */
  static async attach(
    kernel: ReplKernel,
    stdin: StdioReader,
    stdout: StdioWriter,
  ): Promise<void> {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let buf = "";
    const rb = new Uint8Array(65536);

    while (true) {
      const n = await stdin.read(rb);
      if (n === null) break;
      buf += decoder.decode(rb.subarray(0, n), { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let m: Record<string, unknown>;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.type === "close") {
          await writeLine(stdout, encoder, { type: "closed" });
          return;
        }
        if (
          m.type === "eval" &&
          typeof m.id === "string" &&
          typeof m.code === "string"
        ) {
          const result = await kernel.eval(m.code, {
            timeoutMs: typeof m.timeout_ms === "number"
              ? m.timeout_ms
              : undefined,
          });
          await writeResult(stdout, encoder, m.id, result);
        }
      }
    }
  }
}

async function writeLine(
  stdout: StdioWriter,
  encoder: TextEncoder,
  obj: Record<string, unknown>,
): Promise<void> {
  await stdout.write(encoder.encode(JSON.stringify(obj) + "\n"));
}

async function writeResult(
  stdout: StdioWriter,
  encoder: TextEncoder,
  id: string,
  result: ReplEvalResult,
): Promise<void> {
  let line: string;
  try {
    line = JSON.stringify({
      type: "result",
      id,
      ok: result.ok,
      data: result.data,
      error: result.error,
    });
  } catch (err) {
    // Non-serializable final value: fall back to an error result, exactly
    // like the legacy child's JSON.stringify inside the eval try-block did.
    line = JSON.stringify({
      type: "result",
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  await stdout.write(encoder.encode(line + "\n"));
}
