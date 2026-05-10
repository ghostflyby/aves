import { parse as parseYaml } from "@std/yaml";
import { resolvePermissions } from "./policy.ts";
import {
  ensureSkillRoots,
  getSkillRoots,
  getWritableSkillRoot,
} from "./config.ts";
import { saveRun } from "./run-store.ts";
import type { RunRecord } from "./schemas.ts";

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
  _manifest: undefined,
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
    "- `input`: JSON matching the schema in `SKILL.md` \u2192 Input Schema",
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

  return lines.join("\n");
}

// ============================================================
// Listing & discovery
// ============================================================

export interface SkillInfo {
  name: string;
  path: string;
  description: string;
}

/**
 * Scan all skill roots for skills with SKILL.md (frontmatter `aves: true`).
 */
export async function listSkills(): Promise<SkillInfo[]> {
  const roots = await getSkillRoots();
  const skills: SkillInfo[] = [];
  for (const root of roots) {
    try {
      for await (const entry of Deno.readDir(root)) {
        if (!entry.isDirectory) continue;
        const skillDir = `${root}/${entry.name}`;
        try {
          const mdPath = `${skillDir}/SKILL.md`;
          const stat = await Deno.stat(mdPath);
          if (!stat.isFile) continue;
          const content = await Deno.readTextFile(mdPath);
          const frontmatter = extractFrontmatter(content);
          if (frontmatter?.aves === true) {
            skills.push({
              name: entry.name,
              path: skillDir,
              description: String(frontmatter.description ?? ""),
            });
          }
        } catch {
          continue;
        }
      }
    } catch {
      continue;
    }
  }
  return skills;
}

/** Extract YAML frontmatter between --- markers. */
function extractFrontmatter(md: string): Record<string, unknown> | null {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  try {
    return parseYaml(match[1]) as Record<string, unknown>;
  } catch {
    return null;
  }
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
        denied.join(", ")
      }`,
    };
  }

  await ensureSkillRoots();
  const skillRoot = await getWritableSkillRoot();
  const skillDir = `${skillRoot}/${name}`;

  if (options?.skipIfExists) {
    try {
      await Deno.stat(`${skillDir}/SKILL.md`);
      return { ok: true, skillDir, warnings };
    } catch {
      // Doesn't exist, continue
    }
  }

  await Deno.mkdir(skillDir, { recursive: true });

  // Write SKILL.md
  await Deno.writeTextFile(
    `${skillDir}/SKILL.md`,
    generateSkillMarkdown(name, description, undefined, run.code),
  );

  // Write mod.ts
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

  // Write permission module template (optional — user edits to enable fine-grained permissions)
  const permTemplate = `// Permission module for ${name}
// Return "allow", "deny", or undefined (let broker decide).
// Remove this file if not needed.
export default {
  read(path: string) {},
  write(path: string) {},
  net(host: string) {},
  env(name: string) {},
  sys(name: string) {},
};
`;
  await Deno.writeTextFile(`${skillDir}/mod.permission.ts`, permTemplate);

  // examples.json and test.ts are NOT auto-generated for safety.
  // The run's raw_input/output may contain sensitive data.
  warnings.push(
    "No examples/test auto-generated for safety — consider adding examples.json and test.ts manually",
  );

  run.promoted_to_skill = skillDir;
  await saveRun(run);

  return { ok: true, skillDir, warnings };
}
