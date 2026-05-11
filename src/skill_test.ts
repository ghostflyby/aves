import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { listSkills, promoteRunToSkill } from "./skill.ts";
import type { RunRecord } from "./schemas.ts";

// ============================================================
// Test helpers
// ============================================================

const TEST_RUN: RunRecord = {
  run_id: "test-promote-001",
  mode: "eval",
  code_hash: "abc123",
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
};

// ============================================================
// Tests
// ============================================================

Deno.test("promoteRunToSkill - creates skill files on disk (no skill.json)", async () => {
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

    // skill.json should NOT exist
    try {
      await Deno.stat(`${result.skillDir}/skill.json`);
      console.assert(false, "skill.json should NOT be created");
    } catch { /* expected — skill.json is deprecated */ }

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

Deno.test("listSkills - discovers SKILL.md-based skills", async () => {
  const prevData = Deno.env.get("AVES_DATA_DIR");
  Deno.env.set("AVES_DATA_DIR", "/tmp/aves-test-skill-md");
  const skillPath = "/tmp/aves-test-skill-md/skills/test-skill-md";

  try {
    await Deno.mkdir(skillPath, { recursive: true });
    await Deno.writeTextFile(
      `${skillPath}/SKILL.md`,
      "---\nname: test-skill-md\ndescription: A skill discovered via SKILL.md\naves: true\n---\n\n# Test Skill",
    );
    await Deno.writeTextFile(
      `${skillPath}/mod.ts`,
      "export default async function main() { return { ok: true }; }",
    );

    const skills = await listSkills();
    assertEquals(skills.length >= 1, true);
    const found = skills.find((s) => s.name === "test-skill-md");
    if (found) {
      assertEquals(found.description, "A skill discovered via SKILL.md");
    }
  } finally {
    if (prevData) Deno.env.set("AVES_DATA_DIR", prevData);
    else Deno.env.delete("AVES_DATA_DIR");
    try {
      await Deno.remove("/tmp/aves-test-skill-md", { recursive: true });
    } catch {
      /* skip */
    }
  }
});
