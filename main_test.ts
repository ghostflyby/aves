import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { executeRun } from "./src/runner.ts";
import { listRuns, loadRun, saveRun } from "./src/run-store.ts";
import type { RunRecord, RunRequest } from "./src/types.ts";

import type { SandboxState } from "./src/sandbox-state.ts";

const TEST_CEILING: SandboxState = {
  meta: {
    permissionProfile: {
      type: "managed",
      file_system: { type: "unrestricted", entries: [] },
      network: "enabled",
    },
    sandboxPolicy: {
      type: "workspace-write",
      writable_roots: [],
      network_access: true,
      exclude_tmpdir_env_var: false,
      exclude_slash_tmp: false,
    },
    codexLinuxSandboxExe: null,
    sandboxCwd: "/Users/ghostflyby/repos/learn/aves",
    useLegacyLandlock: false,
  },
  workspaces: ["/Users/ghostflyby/repos/learn/aves"],
};

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

  const record = await executeRun(request, {}, TEST_CEILING);

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

  const record = await executeRun(request, {}, TEST_CEILING);

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

  const record = await executeRun(request, {}, TEST_CEILING);

  assertEquals(record.exit_code, 1);
  assertExists(record.error);
  assertStringIncludes(record.error!, "simulated failure");
});

Deno.test("run-store - save and load", async () => {
  const prevData = Deno.env.get("AVES_DATA_DIR");
  Deno.env.set("AVES_DATA_DIR", "/tmp/aves-test-runstore");
  await Deno.mkdir("/tmp/aves-test-runstore", { recursive: true });
  const record: RunRecord = {
    run_id: "test-run-001",
    mode: "eval",
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
  try {
    await Deno.remove("/tmp/aves-test-runstore", { recursive: true });
  } catch {
    _; /* skip */
  }
  if (prevData) Deno.env.set("AVES_DATA_DIR", prevData);
  else Deno.env.delete("AVES_DATA_DIR");
});

Deno.test("run-store - list runs", async () => {
  const prevData = Deno.env.get("AVES_DATA_DIR");
  Deno.env.set("AVES_DATA_DIR", "/tmp/aves-test-runstore2");
  await Deno.mkdir("/tmp/aves-test-runstore2", { recursive: true });
  const runs = await listRuns();
  assertExists(Array.isArray(runs));
  try {
    await Deno.remove("/tmp/aves-test-runstore2", { recursive: true });
  } catch {
    _; /* skip */
  }
  if (prevData) Deno.env.set("AVES_DATA_DIR", prevData);
  else Deno.env.delete("AVES_DATA_DIR");
});

Deno.test("executeRun - invalid request throws", async () => {
  try {
    await executeRun({ mode: "eval" } as RunRequest);
  } catch (err) {
    assertStringIncludes((err as Error).message, "Invalid request");
  }
});

// ============================================================
// Integration tests: approval and sandbox-state
// ============================================================
import {
  applyCodexCeiling,
  isReadOnly,
  isWithinCodexCeiling,
} from "./src/policy.ts";
import { extractSandboxState } from "./src/sandbox-state.ts";

Deno.test("integration: applyCodexCeiling with null sandbox passes all", () => {
  const { granted, dropped } = applyCodexCeiling(
    {
      read: ["/tmp/test.ts"],
      write: ["/tmp/test.ts"],
      net: ["api.example.com"],
    },
    null,
  );
  assertEquals(granted.read, ["/tmp/test.ts"]);
  assertEquals(granted.write, ["/tmp/test.ts"]);
  assertEquals(granted.net, ["api.example.com"]);
  assertEquals(dropped.read, undefined);
  assertEquals(dropped.write, undefined);
  assertEquals(dropped.net, undefined);
});

Deno.test("integration: isReadOnly true for read-only", () => {
  assertEquals(isReadOnly({ read: ["/tmp"] }), true);
});

Deno.test("integration: isReadOnly false with write", () => {
  assertEquals(isReadOnly({ read: ["/tmp"], write: ["/tmp"] }), false);
});

Deno.test("integration: isReadOnly false with only write", () => {
  assertEquals(isReadOnly({ write: ["/tmp"] }), false);
});

Deno.test("integration: isReadOnly false with only net", () => {
  assertEquals(isReadOnly({ net: ["example.com"] }), false);
});

Deno.test("integration: sandbox state extraction from null", () => {
  assertEquals(extractSandboxState(null), null);
});

Deno.test("integration: sandbox state extraction from empty object", () => {
  assertEquals(extractSandboxState({}), null);
});

Deno.test("integration: isWithinCodexCeiling empty drops", () => {
  assertEquals(isWithinCodexCeiling({}), true);
});

Deno.test("integration: isWithinCodexCeiling with read drop", () => {
  assertEquals(isWithinCodexCeiling({ read: ["/etc/passwd"] }), false);
});

Deno.test("integration: isWithinCodexCeiling with write drop", () => {
  assertEquals(isWithinCodexCeiling({ write: ["/etc/hosts"] }), false);
});

Deno.test("integration: isWithinCodexCeiling with net drop", () => {
  assertEquals(isWithinCodexCeiling({ net: ["evil.com"] }), false);
});

Deno.test("integration: isWithinCodexCeiling with empty array drops", () => {
  assertEquals(isWithinCodexCeiling({ read: [], write: [] }), true);
});

Deno.test("integration: isWithinCodexCeiling with mixed drops", () => {
  assertEquals(
    isWithinCodexCeiling({ read: ["/etc/passwd"], write: ["/etc/hosts"] }),
    false,
  );
});
