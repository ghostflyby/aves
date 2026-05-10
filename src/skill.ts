import { resolvePermissions } from "./policy.ts";
import {
  ensureSkillRoots,
  getSkillRoots,
  getWritableSkillRoot,
} from "./config.ts";
import { saveRun } from "./run-store.ts";
import type { RunRecord, SkillManifest } from "./schemas.ts";
import { SkillManifestSchema } from "./schemas.ts";

// ============================================================
// Skill manifest loading
// ============================================================

export type LoadManifestResult =
  | { ok: true; manifest: SkillManifest }
  | { ok: false; error: string };

function validateManifest(raw: unknown): LoadManifestResult {
  const parsed = SkillManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    };
  }
  return { ok: true, manifest: parsed.data };
}

/**
 * Load and validate a skill manifest from a directory.
 */
export async function loadSkillManifest(
  skillDir: string,
): Promise<LoadManifestResult> {
  try {
    const raw = JSON.parse(
      await Deno.readTextFile(`${skillDir}/skill.json`),
    );
    return validateManifest(raw);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Hash a manifest for content-change detection.
 */
export async function hashManifest(manifest: SkillManifest): Promise<string> {
  const json = JSON.stringify(manifest);
  const enc = new TextEncoder();
  const data = enc.encode(json);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ============================================================
// Entrypoint resolution
// ============================================================

export function resolveSkillEntrypoint(
  skillDir: string,
  manifest: SkillManifest,
): string {
  return `${skillDir}/${manifest.entrypoint.replace(/^\.\//, "")}`;
}

// ============================================================
// SKILL.md generation
// ============================================================

/** Extract the zod.object({...}) expression from code, balancing parens. */
function extractZodInputSchema(code: string): string | null {
  const idx = code.search(/export const inputSchema\s*=\s*z\.object\(/);
  if (idx === -1) return null;

  let depth = 0;
  let i = code.indexOf("(", idx);
  if (i === -1) return null;
  const start = i;

  for (; i < code.length; i++) {
    const ch = code[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        const expr = code.slice(start, i + 1);
        return `export const inputSchema = ${expr}`;
      }
    }
  }
  return null;
}

function generateSkillMarkdown(
  name: string,
  description: string,
  manifest?: SkillManifest,
  code?: string,
): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`name: ${name}`);
  lines.push(
    `description: "${description}. Requires the Aves MCP server \u2014 use the \`run_skill\` tool with skill_path set to this directory."`,
  );
  lines.push("aves: true");
  lines.push("---");
  lines.push("");
  lines.push(`# ${name}`);
  lines.push("");
  lines.push("An Aves runtime skill. Do not execute the Deno script directly.");
  lines.push("");
  lines.push("## How to Use");
  lines.push("");
  lines.push("Call the `run_skill` MCP tool from the **aves** server:");
  lines.push("");
  lines.push("- `skill_path`: absolute path to this directory");
  lines.push(
    "- `input`: JSON matching the schema in `skill.json` \u2192 `input_schema`",
  );
  lines.push("");
  lines.push(
    "The Zod input definition is exported as `inputSchema` from `./mod.ts`.",
  );
  lines.push("");
  lines.push(
    "Add `./examples.json` with sample input/output pairs for testing.",
  );
  lines.push("");

  // Inline Zod schema
  lines.push("## Input Schema");
  lines.push("");
  if (code) {
    const zodExpr = extractZodInputSchema(code);
    if (zodExpr) {
      lines.push("```ts");
      lines.push(zodExpr);
      lines.push("```");
    } else {
      lines.push("**No inputSchema defined.** Consider adding a Zod schema:");
      lines.push("");
      lines.push("```ts");
      lines.push('import { z } from "zod";');
      lines.push("");
      lines.push("export const inputSchema = z.object({");
      lines.push("  // add your fields here");
      lines.push("});");
      lines.push("```");
    }
  } else {
    lines.push(
      "**No inputSchema defined.** Consider adding one to `./mod.ts`.",
    );
  }
  lines.push("");

  lines.push("## Notes");
  lines.push("");
  lines.push("- First run will prompt for permission approval");
  lines.push(
    "- This skill requires the `aves` MCP server to be configured and available",
  );
  lines.push("");

  if (manifest?.permission_justifications) {
    lines.push("## Permission Justifications");
    lines.push("");
    for (
      const [path, reason] of Object.entries(manifest.permission_justifications)
    ) {
      lines.push(`- **${path}**: ${reason}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ============================================================
// Listing & discovery
// ============================================================

export interface SkillInfo {
  name: string;
  path: string;
  manifest: SkillManifest;
  manifestHash?: string;
}

/**
 * Scan all skill roots for valid skills.
 */
export async function listSkills(): Promise<SkillInfo[]> {
  const roots = await getSkillRoots();
  const skills: SkillInfo[] = [];

  for (const root of roots) {
    try {
      for await (const entry of Deno.readDir(root)) {
        if (!entry.isDirectory) continue;
        const skillDir = `${root}/${entry.name}`;
        const result = await loadSkillManifest(skillDir);
        if (result.ok) {
          skills.push({
            name: entry.name,
            path: skillDir,
            manifest: result.manifest,
            manifestHash: await hashManifest(result.manifest),
          });
        }
      }
    } catch {
      continue;
    }
  }

  return skills;
}

// ============================================================
// Promotion (run → skill)
// ============================================================

/**
 * Promote a run record to a skill, writing to disk.
 * Returns the skill directory path and any warnings.
 */
export async function promoteRunToSkill(
  run: RunRecord,
  name: string,
  description: string,
  options?: {
    entrypointContent?: string;
    skipIfExists?: boolean;
  },
): Promise<
  { ok: true; skillDir: string; warnings: string[] } | {
    ok: false;
    error: string;
  }
> {
  if (!name.match(/^[a-z][a-z0-9_-]*$/)) {
    return {
      ok: false,
      error: `Invalid skill name: "${name}". Must match [a-z][a-z0-9_-]`,
    };
  }

  const warnings: string[] = [];

  if (!run.schema_hash) {
    warnings.push(
      "No inputSchema: consider adding Zod schema to mod.ts and inlining it in SKILL.md",
    );
  }

  const { denied } = resolvePermissions(run.granted_permissions);
  if (denied.length > 0) {
    return {
      ok: false,
      error: `Cannot promote: permissions were denied for: ${
        denied.join(
          ", ",
        )
      }`,
    };
  }

  const manifest = {
    permissions: run.granted_permissions,
    input_schema: run.parsed_input ? run.input_schema_json : undefined,
    entrypoint: "./mod.ts",
  };

  const validation = validateManifest(manifest);
  if (!validation.ok) return validation;

  await ensureSkillRoots();
  const skillRoot = await getWritableSkillRoot();
  const skillDir = `${skillRoot}/${name}`;

  if (options?.skipIfExists) {
    try {
      await Deno.stat(`${skillDir}/skill.json`);
      return { ok: true, skillDir, warnings };
    } catch {
      // Doesn't exist, continue
    }
  }

  await Deno.mkdir(skillDir, { recursive: true });

  await Deno.writeTextFile(
    `${skillDir}/skill.json`,
    JSON.stringify(manifest, null, 2),
  );

  await Deno.writeTextFile(
    `${skillDir}/SKILL.md`,
    generateSkillMarkdown(name, description, manifest, run.code),
  );

  const entrypointContent = options?.entrypointContent ??
    run.code ??
    `
// Skill: ${name}
// Description: ${description}

export default async function main(input: unknown) {
  return { ok: true, message: "Skill stub — replace with actual implementation" };
}
`;
  await Deno.writeTextFile(`${skillDir}/mod.ts`, entrypointContent.trimStart());

  // examples.json and test.ts are NOT auto-generated for safety.
  // The run's raw_input/output may contain sensitive data.
  warnings.push(
    "No examples/test auto-generated for safety — consider adding examples.json and test.ts manually",
  );

  run.promoted_to_skill = skillDir;
  await saveRun(run);

  return { ok: true, skillDir, warnings };
}

// ============================================================
// Approval checking
// ============================================================

export type SkillApprovalStatus =
  | { status: "approved" }
  | {
    status: "content_changed";
    skillPath: string;
    manifestHash: string;
    contentHash: string;
  }
  | { status: "need_approval"; skillPath: string; manifestHash: string }
  | { status: "not_found"; error: string };

/**
 * Check whether a skill has been approved for execution.
 */
export async function checkSkillApproval(
  skillDir: string,
): Promise<SkillApprovalStatus> {
  const manifestResult = await loadSkillManifest(skillDir);
  if (!manifestResult.ok) {
    return { status: "not_found", error: manifestResult.error };
  }

  const manifest = manifestResult.manifest;
  const mHash = await hashManifest(manifest);

  // Check if previously approved
  try {
    const approvedHash = await Deno.readTextFile(
      `${skillDir}/.aves-approved`,
    );
    const trimmed = approvedHash.trim();
    if (trimmed === mHash) {
      return { status: "approved" };
    }
    return {
      status: "content_changed",
      skillPath: skillDir,
      manifestHash: mHash,
      contentHash: trimmed,
    };
  } catch {
    return {
      status: "need_approval",
      skillPath: skillDir,
      manifestHash: mHash,
    };
  }
}

/**
 * Mark a skill as approved by writing its manifest hash.
 */
export async function approveSkill(
  skillDir: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const manifestResult = await loadSkillManifest(skillDir);
  if (!manifestResult.ok) {
    return { ok: false, error: manifestResult.error };
  }

  const mHash = await hashManifest(manifestResult.manifest);
  await Deno.writeTextFile(`${skillDir}/.aves-approved`, mHash);
  return { ok: true };
}

// ============================================================
// Replay test generation (public utility, not called from promote)
// ============================================================

function _generateReplayTest(skillName: string, examples: unknown[]): string {
  const lines = [
    `import { assertEquals } from "@std/assert";`,
    `import main from "./mod.ts";`,
    ``,
  ];
  for (let i = 0; i < examples.length; i++) {
    const ex = examples[i] as { input?: unknown; output?: unknown };
    lines.push(
      `Deno.test("${skillName} replay ${i}", async () => {`,
      `  const result = await main(${JSON.stringify(ex.input ?? {})});`,
      `  assertEquals(result, ${JSON.stringify(ex.output)});`,
      `});`,
      ``,
    );
  }
  return lines.join("\n");
}
