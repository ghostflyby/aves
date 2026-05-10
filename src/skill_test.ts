import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import {
  approveSkill,
  checkSkillApproval,
  listSkills,
  loadSkillManifest,
  promoteRunToSkill,
} from "./skill.ts";
import type { RunRecord } from "./schemas.ts";

// ============================================================
// Test helpers
// ============================================================

const TEST_RUN: RunRecord = {
  run_id: "test-promote-001",
  mode: "eval",
  code_hash: "abc123",
  schema_hash: "schema-hash",
  raw_input: { text: "hello" },
  parsed_input: { text: "hello" },
  permissions: { read: ["/tmp/data"] },
  granted_permissions: { read: ["/tmp/data"] },
  stdout: "",
  stderr: "",
  exit_code: 0,
  output: {
    hex: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  },
  started_at: new Date().toISOString(),
  finished_at: new Date().toISOString(),
  duration_ms: 10,
  code: `import { z } from "zod";

export const inputSchema = z.object({
  text: z.string().describe("Text to hash"),
});

export default async function main(input: z.infer<typeof inputSchema>) {
  const data = new TextEncoder().encode(input.text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return {
    hex: Array.from(new Uint8Array(hash)).map((b) =>
      b.toString(16).padStart(2, "0")
    ).join(""),
  };
}`,
  input_schema_json: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
};

// ============================================================
// Tests
// ============================================================

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

    const statManifest = await Deno.stat(`${result.skillDir}/skill.json`);
    assertEquals(statManifest.isFile, true);
    const statMod = await Deno.stat(`${result.skillDir}/mod.ts`);
    assertEquals(statMod.isFile, true);
    const statSkMd = await Deno.stat(`${result.skillDir}/SKILL.md`);
    assertEquals(statSkMd.isFile, true);

    // test.ts should NOT exist
    try {
      await Deno.stat(`${result.skillDir}/test.ts`);
      console.assert(false, "test.ts should not be auto-generated");
    } catch { /* expected */ }
    // examples.json should NOT exist
    try {
      await Deno.stat(`${result.skillDir}/examples.json`);
      console.assert(false, "examples.json should not be auto-generated");
    } catch { /* expected */ }

    const skMdContent = await Deno.readTextFile(`${result.skillDir}/SKILL.md`);
    assertStringIncludes(skMdContent, "test-promote-skill");
    assertStringIncludes(skMdContent, "aves: true");
    assertStringIncludes(skMdContent, "run_skill");
    assertStringIncludes(skMdContent, "Add `./examples.json`");
    assertStringIncludes(skMdContent, "export const inputSchema");
    assertStringIncludes(skMdContent, "Text to hash");

    const manifestResult = await loadSkillManifest(result.skillDir);
    assertEquals(manifestResult.ok, true);

    const hasExampleWarning = result.warnings.some((w) =>
      w.includes("examples/test")
    );
    assertEquals(hasExampleWarning, true);
  }

  try {
    await Deno.remove("/tmp/aves-test-promote", { recursive: true });
  } catch {
    /* skip */
  }
  if (prevData) Deno.env.set("AVES_DATA_DIR", prevData);
  else Deno.env.delete("AVES_DATA_DIR");
});

Deno.test("promoteRunToSkill - invalid name rejected", async () => {
  const result = await promoteRunToSkill(TEST_RUN, "Invalid Name!", "test");
  assertEquals(result.ok, false);
});

Deno.test("promoteRunToSkill - no schema_hash allowed with warning", async () => {
  const prevData = Deno.env.get("AVES_DATA_DIR");
  Deno.env.set("AVES_DATA_DIR", "/tmp/aves-test-no-schema");
  const noSchema = {
    ...TEST_RUN,
    schema_hash: undefined,
    parsed_input: undefined,
    input_schema_json: undefined,
  };
  const result = await promoteRunToSkill(noSchema, "no-schema", "test");
  assertEquals(result.ok, true);
  if (result.ok) {
    const hasSchemaWarning = result.warnings.some((w) =>
      w.includes("inputSchema")
    );
    assertEquals(hasSchemaWarning, true);
  }
  try {
    await Deno.remove("/tmp/aves-test-no-schema", { recursive: true });
  } catch {
    /* skip */
  }
  if (prevData) Deno.env.set("AVES_DATA_DIR", prevData);
  else Deno.env.delete("AVES_DATA_DIR");
});

Deno.test("listSkills - returns empty for clean state", async () => {
  const prevData = Deno.env.get("AVES_DATA_DIR");
  Deno.env.set("AVES_DATA_DIR", "/tmp/aves-test-empty-skills");
  try {
    const skills = await listSkills();
    assertEquals(skills.length, 0);
  } finally {
    if (prevData) Deno.env.set("AVES_DATA_DIR", prevData);
    else Deno.env.delete("AVES_DATA_DIR");
    try {
      await Deno.remove("/tmp/aves-test-empty-skills", { recursive: true });
    } catch {
      /* skip */
    }
  }
});

Deno.test("skill approval - save and load", async () => {
  const prevData = Deno.env.get("AVES_DATA_DIR");
  Deno.env.set("AVES_DATA_DIR", "/tmp/aves-test-skill-approval");
  const skillPath = "/tmp/test-skill";

  try {
    await Deno.mkdir(skillPath, { recursive: true });
    await Deno.writeTextFile(
      `${skillPath}/skill.json`,
      JSON.stringify({
        permissions: { read: ["/tmp"] },
        entrypoint: "./mod.ts",
      }),
    );
    await Deno.writeTextFile(skillPath + "/SKILL.md", "# test");

    const check = await checkSkillApproval(skillPath);
    assertEquals(check.status, "need_approval");

    const approved = await approveSkill(skillPath);
    assertEquals(approved.ok, true);

    const recheck = await checkSkillApproval(skillPath);
    assertEquals(recheck.status, "approved");
  } finally {
    if (prevData) Deno.env.set("AVES_DATA_DIR", prevData);
    else Deno.env.delete("AVES_DATA_DIR");
    try {
      await Deno.remove(skillPath, { recursive: true });
    } catch {
      /* skip */
    }
    try {
      await Deno.remove("/tmp/aves-test-skill-approval", { recursive: true });
    } catch {
      /* skip */
    }
  }
});
