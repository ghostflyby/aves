import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { getDefaultSkillRoot, parseConfig, resolvePath } from "./config.ts";
import {
  hashManifest,
  listSkills,
  loadSkillManifest,
  promoteRunToSkill,
  validateManifest,
} from "./skill.ts";
import {
  loadSkillApproval,
  removeSkillApproval,
  saveSkillApproval,
} from "./run-store.ts";
import type { RunRecord, SkillManifest } from "./types.ts";

// ============================================================
// Config tests
// ============================================================

Deno.test("resolvePath - tilde expansion", () => {
  const result = resolvePath("~/test/path");
  const home = Deno.env.get("HOME") ?? "";
  assertEquals(result.startsWith(home), true);
  assertEquals(result.endsWith("/test/path"), true);
});

Deno.test("resolvePath - env var expansion", () => {
  Deno.env.set("AVES_TEST_VAR", "/tmp/aves-env-test");
  const result = resolvePath("$AVES_TEST_VAR/skills");
  assertEquals(result, "/tmp/aves-env-test/skills");
  Deno.env.delete("AVES_TEST_VAR");
});

Deno.test("resolvePath - combined tilde and env", () => {
  const result = resolvePath("~/repo/$USER/proj");
  const home = Deno.env.get("HOME") ?? "";
  assertEquals(result.startsWith(home), true);
});

Deno.test("getDefaultSkillRoot - returns data dir + skills", () => {
  const root = getDefaultSkillRoot();
  assertStringIncludes(root, "aves");
  assertStringIncludes(root, "skills");
});

Deno.test("parseConfig - missing file returns defaults", async () => {
  const prev = Deno.env.get("AVES_CONFIG_DIR");
  Deno.env.set("AVES_CONFIG_DIR", "/tmp/aves-test-config-nonexistent");
  const config = await parseConfig();
  assertEquals(config.skillRoots, []);
  if (prev) Deno.env.set("AVES_CONFIG_DIR", prev);
  else Deno.env.delete("AVES_CONFIG_DIR");
});

// ============================================================
// Skill manifest tests
// ============================================================

Deno.test("validateManifest - valid manifest", () => {
  const result = validateManifest({
    permissions: { net: ["api.github.com"] },
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.manifest.entrypoint, "./mod.ts");
  }
});

Deno.test("validateManifest - valid with all optional fields", () => {
  const result = validateManifest({
    name: "github-issue-fetch",
    description: "Fetch GitHub issues",
    permissions: {},
  });
  assertEquals(result.ok, true);
});

Deno.test("validateManifest - missing permissions", () => {
  const result = validateManifest({});
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error, "permissions");
  }
});

Deno.test("hashManifest - deterministic", async () => {
  const manifest: SkillManifest = {
    permissions: { net: ["api.github.com"] },
    entrypoint: "./mod.ts",
  };
  const h1 = await hashManifest(manifest);
  const h2 = await hashManifest(manifest);
  assertEquals(h1, h2);
  assertEquals(h1.length, 64); // SHA-256 hex
});

Deno.test("hashManifest - different perms yield different hashes", async () => {
  const m1: SkillManifest = {
    permissions: {},
    entrypoint: "./mod.ts",
  };
  const m2: SkillManifest = {
    permissions: { net: ["x"] },
    entrypoint: "./mod.ts",
  };
  const h1 = await hashManifest(m1);
  const h2 = await hashManifest(m2);
  assertEquals(h1 !== h2, true);
});

// ============================================================
// Skill disk storage tests
// ============================================================

const TEST_RUN: RunRecord = {
  run_id: "test-promote-001",
  mode: "module",
  code_hash: "deadbeef",
  schema_hash:
    "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
  raw_input: { repo: "owner/name", issue: 42 },
  parsed_input: { repo: "owner/name", issue: 42 },
  permissions: { net: ["api.github.com"] },
  granted_permissions: { net: ["api.github.com"] },
  stdout: "",
  stderr: "",
  exit_code: 0,
  output: { title: "Bug: Something broke" },
  started_at: "2026-01-01T00:00:00Z",
  finished_at: "2026-01-01T00:00:01Z",
  duration_ms: 1000,
};

Deno.test("promoteRunToSkill - creates skill files on disk", async () => {
  const prevData = Deno.env.get("AVES_DATA_DIR");
  Deno.env.set("AVES_DATA_DIR", "/tmp/aves-test-promote");
  const result = await promoteRunToSkill(
    TEST_RUN,
    "test-promote-skill",
    "A promoted test skill",
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertExists(result.skillDir);

    // Verify files exist
    const statManifest = await Deno.stat(`${result.skillDir}/skill.json`);
    assertEquals(statManifest.isFile, true);

    const statMod = await Deno.stat(`${result.skillDir}/mod.ts`);
    assertEquals(statMod.isFile, true);

    const statSkMd = await Deno.stat(`${result.skillDir}/SKILL.md`);
    assertEquals(statSkMd.isFile, true);

    const statTest = await Deno.stat(`${result.skillDir}/test.ts`);
    assertEquals(statTest.isFile, true);

    // Verify SKILL.md content
    const skMdContent = await Deno.readTextFile(`${result.skillDir}/SKILL.md`);
    assertStringIncludes(skMdContent, "test-promote-skill");
    assertStringIncludes(skMdContent, "aves: true");
    assertStringIncludes(skMdContent, "run_skill");
    assertStringIncludes(skMdContent, "skill_path");
    assertStringIncludes(skMdContent, "skill.json");
    assertStringIncludes(skMdContent, "examples.json");

    // Verify manifest content
    const manifestResult = await loadSkillManifest(result.skillDir);
    assertEquals(manifestResult.ok, true);
  }

  // Cleanup
  try {
    await Deno.remove("/tmp/aves-test-promote", { recursive: true });
  } catch {}
  if (prevData) Deno.env.set("AVES_DATA_DIR", prevData);
  else Deno.env.delete("AVES_DATA_DIR");
});

Deno.test("promoteRunToSkill - invalid name rejected", async () => {
  const result = await promoteRunToSkill(TEST_RUN, "Invalid Name!", "test");
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error, "Invalid skill name");
  }
});

Deno.test("promoteRunToSkill - no schema_hash rejected", async () => {
  const noSchema = { ...TEST_RUN, schema_hash: undefined };
  const result = await promoteRunToSkill(noSchema, "no-schema", "test");
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error, "schema_hash");
  }
});

Deno.test("listSkills - returns empty for clean state", async () => {
  const prevData = Deno.env.get("AVES_DATA_DIR");
  Deno.env.set("AVES_DATA_DIR", "/tmp/aves-test-listskills");
  const skills = await listSkills();
  assertEquals(Array.isArray(skills), true);

  try {
    await Deno.remove("/tmp/aves-test-listskills", { recursive: true });
  } catch {}
  if (prevData) Deno.env.set("AVES_DATA_DIR", prevData);
  else Deno.env.delete("AVES_DATA_DIR");
});

// ============================================================
// Skill approval tests
// ============================================================

Deno.test("skill approval - save and load", async () => {
  const prevData = Deno.env.get("AVES_DATA_DIR");
  Deno.env.set("AVES_DATA_DIR", "/tmp/aves-test-approve-db");

  const testHash = "a".repeat(64);
  await saveSkillApproval({
    skillPath: "/tmp/test-skill",
    manifestHash: testHash,
    approvedAt: new Date().toISOString(),
    requiresApproval: true,
  });

  const loaded = await loadSkillApproval("/tmp/test-skill");
  assertExists(loaded);
  assertEquals(loaded!.manifestHash, testHash);
  assertEquals(loaded!.requiresApproval, true);

  await removeSkillApproval("/tmp/test-skill");
  const afterRemove = await loadSkillApproval("/tmp/test-skill");
  assertEquals(afterRemove, null);

  if (prevData) Deno.env.set("AVES_DATA_DIR", prevData);
  else Deno.env.delete("AVES_DATA_DIR");
});
