import { SkillManifestSchema } from "./schemas.ts";
import type {
  RunRecord,
  SkillInstallOptions,
  SkillManifest,
} from "./types.ts";
import { resolvePermissions } from "./policy.ts";
import { saveRun, saveSkillApproval, loadSkillApproval } from "./run-store.ts";
import {
  getWritableSkillRoot,
  getSkillRoots,
  ensureSkillRoots,
} from "./config.ts";

// ============================================================
// Manifest helpers
// ============================================================

/**
 * Validate a skill manifest against the schema.
 */
export function validateManifest(
  data: unknown,
): { ok: true; manifest: SkillManifest } | { ok: false; error: string } {
  const result = SkillManifestSchema.safeParse(data);
  if (!result.success) {
    return {
      ok: false,
      error: `Invalid skill manifest: ${
        result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")
      }`,
    };
  }
  return { ok: true, manifest: result.data };
}

/**
 * Compute an SHA-256 hash of the manifest (canonical JSON).
 */
export async function hashManifest(
  manifest: SkillManifest,
): Promise<string> {
  // Recursive stable JSON serialization
  function stableStringify(val: unknown): string {
    if (val === null) return "null";
    if (typeof val !== "object" || Array.isArray(val)) {
      return JSON.stringify(val);
    }
    const keys = Object.keys(val as Record<string, unknown>).sort();
    const pairs = keys.map((k) =>
      `${JSON.stringify(k)}:${stableStringify((val as Record<string, unknown>)[k])}`
    );
    return `{${pairs.join(",")}}`;
  }
  const canonical = stableStringify(manifest);
  const enc = new TextEncoder();
  const data = enc.encode(canonical);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

// ============================================================
// Disk I/O
// ============================================================

/**
 * Load and validate a skill manifest from disk.
 */
export async function loadSkillManifest(
  skillDir: string,
): Promise<{ ok: true; manifest: SkillManifest } | { ok: false; error: string }> {
  try {
    const raw = await Deno.readTextFile(`${skillDir}/skill.json`);
    const parsed = JSON.parse(raw);
    return validateManifest(parsed);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Resolve the entrypoint path for a skill directory.
 */
export function resolveSkillEntrypoint(
  skillDir: string,
  manifest: SkillManifest,
): string {
  return `${skillDir}/${manifest.entrypoint.replace(/^\.\//, "")}`;
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
            name: result.manifest.name,
            path: skillDir,
            manifest: result.manifest,
            manifestHash: await hashManifest(result.manifest),
          });
        }
      }
    } catch {
      // Skip unreadable roots
      continue;
    }
  }

  return skills;
}

// ============================================================
// Markdown generation for Codex skills
// ============================================================

/**
 * Generate SKILL.md content for a Codex-compatible skill entry.
 */
export function generateSkillMarkdown(
  manifest: SkillManifest,
  skillDir: string,
): string {
  const lines: string[] = [
    `# ${manifest.name}`,
    "",
    `${manifest.description}`,
    "",
    "This skill is managed by the **Aves** runtime.",
    "",
    "## Usage",
    "",
    `Call the \`run_skill\` tool from the aves MCP server:`,
    `- \`skill_path\`: \`${skillDir}\``,
    "",
  ];

  if (manifest.input_schema) {
    lines.push("## Input Schema", "");
    lines.push("```json");
    lines.push(JSON.stringify(manifest.input_schema, null, 2));
    lines.push("```", "");
  }

  lines.push("## Permissions", "");
  lines.push("```json");
  lines.push(JSON.stringify(manifest.permissions, null, 2));
  lines.push("```", "");

  if (manifest.examples && manifest.examples.length > 0) {
    lines.push("## Examples", "");
    for (let i = 0; i < Math.min(manifest.examples.length, 3); i++) {
      lines.push("### Example " + (i + 1), "");
      lines.push("```json");
      lines.push(JSON.stringify(manifest.examples[i], null, 2));
      lines.push("```", "");
    }
  }

  return lines.join("\n");
}

// ============================================================
// Codex skill installation
// ============================================================

/**
 * Install a skill as a Codex-compatible skill entry.
 * Creates a directory with SKILL.md and symlinks/copies skill.json.
 */
export async function installCodexSkill(
  skillDir: string,
  manifest: SkillManifest,
  options: SkillInstallOptions,
): Promise<string> {
  const installPath = options.installPath ??
    `${Deno.env.get("HOME") ?? ""}/.codex/skills/deno-${manifest.name}`;

  // Create the install directory
  await Deno.mkdir(installPath, { recursive: true });

  // Write SKILL.md
  const markdown = generateSkillMarkdown(manifest, skillDir);
  await Deno.writeTextFile(`${installPath}/SKILL.md`, markdown);

  if (options.installMethod === "symlink") {
    // Symlink skill.json back to aves root
    try {
      await Deno.remove(`${installPath}/skill.json`);
    } catch {
      /* ignore */
    }
    await Deno.symlink(
      `${skillDir}/skill.json`,
      `${installPath}/skill.json`,
    );

    // Symlink mod.ts
    try {
      await Deno.remove(`${installPath}/mod.ts`);
    } catch {
      /* ignore */
    }
    await Deno.symlink(
      resolveSkillEntrypoint(skillDir, manifest),
      `${installPath}/mod.ts`,
    );
  } else {
    // Copy files
    const entrypoint = resolveSkillEntrypoint(skillDir, manifest);
    await Deno.copyFile(`${skillDir}/skill.json`, `${installPath}/skill.json`);
    await Deno.copyFile(entrypoint, `${installPath}/mod.ts`);
  }

  return installPath;
}

// ============================================================
// Promotion (run → skill)
// ============================================================

/**
 * Promote a run record to a skill, writing to disk.
 * Optionally installs as a Codex skill entry.
 */
export async function promoteRunToSkill(
  run: RunRecord,
  name: string,
  description: string,
  options?: SkillInstallOptions & {
    entrypointContent?: string;
    skipIfExists?: boolean;
  },
): Promise<
  { ok: true; skillDir: string; installPath?: string }
  | { ok: false; error: string }
> {
  // Validate name
  if (!name.match(/^[a-z][a-z0-9_-]*$/)) {
    return {
      ok: false,
      error: `Invalid skill name: "${name}". Must match [a-z][a-z0-9_-]`,
    };
  }

  // Need schema_hash (means the run used an inputSchema)
  if (!run.schema_hash) {
    return {
      ok: false,
      error:
        "Cannot promote: run has no schema_hash (module did not export inputSchema)",
    };
  }

  // Validate permissions are safe
  const { denied } = resolvePermissions(run.granted_permissions);
  if (denied.length > 0) {
    return {
      ok: false,
      error: `Cannot promote: permissions were denied for: ${denied.join(", ")}`,
    };
  }

  // Build manifest
  const manifest: SkillManifest = {
    name,
    description,
    permissions: run.granted_permissions,
    input_schema: run.parsed_input
      ? { properties: Object.keys(run.parsed_input) }
      : undefined,
    entrypoint: "./mod.ts",
    requires_approval: true,
    examples: run.raw_input && run.output !== undefined
      ? [{ input: run.raw_input, output: run.output }]
      : undefined,
  };

  const validation = validateManifest(manifest);
  if (!validation.ok) return validation;

  // Ensure skill roots exist
  await ensureSkillRoots();
  const skillRoot = await getWritableSkillRoot();
  const skillDir = `${skillRoot}/${name}`;

  // Check if already exists
  if (options?.skipIfExists) {
    try {
      await Deno.stat(`${skillDir}/skill.json`);
      return { ok: true, skillDir };
    } catch {
      // Doesn't exist, continue
    }
  }

  // Create skill directory
  await Deno.mkdir(skillDir, { recursive: true });

  // Write skill.json
  await Deno.writeTextFile(
    `${skillDir}/skill.json`,
    JSON.stringify(manifest, null, 2),
  );

  // Write mod.ts
  const entrypointContent = options?.entrypointContent ?? `
// Skill: ${name}
// Description: ${description}
// Generated by Aves from run ${run.run_id}

export default async function main(input: unknown) {
  // TODO: implement skill logic
  return { ok: true, message: "Skill stub — replace with actual implementation" };
}
`;
  await Deno.writeTextFile(`${skillDir}/mod.ts`, entrypointContent.trimStart());

  // Write examples.json
  if (manifest.examples && manifest.examples.length > 0) {
    await Deno.writeTextFile(
      `${skillDir}/examples.json`,
      JSON.stringify(manifest.examples, null, 2),
    );
  }

  // Update run record
  run.promoted_to_skill = skillDir;
  await saveRun(run);

  // Optional Codex skill installation
  let installPath: string | undefined;
  if (options?.installPath || options?.installMethod) {
    installPath = await installCodexSkill(skillDir, manifest, {
      installPath: options.installPath,
      installMethod: options.installMethod ?? "symlink",
    });
  }

  return { ok: true, skillDir, installPath };
}

// ============================================================
// Approval checking
// ============================================================

export type SkillApprovalStatus =
  | { status: "approved" }
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

  const existing = await loadSkillApproval(skillDir);

  // If requires_approval is false and hash matches → approved
  if (!manifest.requires_approval && existing?.manifestHash === mHash) {
    return { status: "approved" };
  }

  // If already approved with matching hash → approved
  if (existing?.manifestHash === mHash) {
    return { status: "approved" };
  }

  // Needs approval
  return {
    status: "need_approval",
    skillPath: skillDir,
    manifestHash: mHash,
  };
}

/**
 * Record an approval for a skill.
 */
export async function approveSkill(
  skillDir: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const manifestResult = await loadSkillManifest(skillDir);
  if (!manifestResult.ok) {
    return { ok: false, error: manifestResult.error };
  }

  const mHash = await hashManifest(manifestResult.manifest);

  await saveSkillApproval({
    skillPath: skillDir,
    manifestHash: mHash,
    approvedAt: new Date().toISOString(),
    requiresApproval: manifestResult.manifest.requires_approval,
  });

  return { ok: true };
}
