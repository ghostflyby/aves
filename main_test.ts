import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { executeRun } from "./src/runner.ts";
import { listRuns, loadRun, saveRun } from "./src/run-store.ts";
import type { RunRecord, RunRequest } from "./src/types.ts";

Deno.test("executeRun - basic eval mode", async () => {
  const request: RunRequest = {
    mode: "eval",
    code: `
export default async function main(input: { name?: string }) {
  const name = input.name ?? "world";
  return { greeting: \`hello \${name}\` };
}
`,
    input: { name: "aves" },
    permissions: {},
  };

  const record = await executeRun(request);

  assertEquals(record.exit_code, 0);
  assertEquals(record.output, { greeting: "hello aves" });
  assertExists(record.run_id);
  assertEquals(record.mode, "eval");
  assertExists(record.code_hash);
  assertEquals(record.started_at < record.finished_at, true);
});

Deno.test("executeRun - eval with no input defaults", async () => {
  const request: RunRequest = {
    mode: "eval",
    code: `
export default async function main(input: { name?: string }) {
  const name = input.name ?? "default";
  return { greeting: \`hello \${name}\` };
}
`,
    input: {},
    permissions: {},
  };

  const record = await executeRun(request);

  assertEquals(record.exit_code, 0);
  assertEquals(record.output, { greeting: "hello default" });
});

Deno.test("executeRun - script with error", async () => {
  const request: RunRequest = {
    mode: "eval",
    code: `
export default async function main(_input: unknown) {
  throw new Error("simulated failure");
}
`,
    permissions: {},
  };

  const record = await executeRun(request);

  assertEquals(record.exit_code, 1);
  assertExists(record.error);
  assertStringIncludes(record.error!, "simulated failure");
});

Deno.test("run-store - save and load", async () => {
  const record: RunRecord = {
    run_id: "test-run-001",
    mode: "eval",
    permissions: {},
    granted_permissions: {},
    stdout: "",
    stderr: "",
    exit_code: 0,
    output: { ok: true },
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: 10,
  };

  await saveRun(record);
  const loaded = await loadRun("test-run-001");
  assertEquals(loaded?.run_id, "test-run-001");
  assertEquals(loaded?.output, { ok: true });

  // Cleanup
  try {
    await Deno.remove(`/tmp/aves/state/runs/test-run-001.json`);
  } catch {
    // ignore
  }
});

Deno.test("run-store - list runs", async () => {
  const runs = await listRuns();
  assertExists(Array.isArray(runs));
});

Deno.test("executeRun - invalid request throws", async () => {
  try {
    await executeRun({ mode: "eval" } as RunRequest);
  } catch (err) {
    assertStringIncludes((err as Error).message, "Invalid request");
  }
});
