import { SkillManifestSchema } from "./schemas.ts";
import type { RunRecord, SkillManifest } from "./types.ts";
import { resolvePermissions } from "./policy.ts";
import { loadSkillApproval, saveRun, saveSkillApproval } from "./run-store.ts";
import {
  ensureSkillRoots,
  getSkillRoots,
  getWritableSkillRoot,
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
        result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")
      }`,
    };
  }
  return { ok: true, manifest: result.data };
}

async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string"
    ? new TextEncoder().encode(data)
    : data;
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const GENERATED_SKILL_FILES = new Set([
  "SKILL.md",
  "skill.json",
  "examples.json",
  "test.ts",
]);

const GENERATED_SKILL_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
]);

function shouldHashSkillEntry(relativePath: string, name: string): boolean {
  if (name.startsWith(".")) return false;
  return !GENERATED_SKILL_FILES.has(relativePath);
}

/**
 * Compute a content hash for a skill directory.
 * Hashes user-authored files recursively, excluding generated metadata.
 */
export async function hashSkillContent(skillDir: string): Promise<string> {
  const entries: Array<{ path: string; hash: string }> = [];

  async function collect(dir: string, prefix = ""): Promise<void> {
    for await (const entry of Deno.readDir(dir)) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!shouldHashSkillEntry(relativePath, entry.name)) continue;
      if (entry.isSymlink) continue;

      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        if (GENERATED_SKILL_DIRS.has(entry.name)) continue;
        await collect(path, relativePath);
        continue;
      }

      if (!entry.isFile) continue;
      const data = await Deno.readFile(path);
      entries.push({ path: relativePath, hash: await sha256Hex(data) });
    }
  }

  await collect(skillDir);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const combined = entries.map((e) => `${e.path}:${e.hash}`).join("\n");
  return sha256Hex(combined);
}

/**
 * Compute an SHA-256 hash of the manifest using stable JSON serialization.
 */
export async function hashManifest(manifest: SkillManifest): Promise<string> {
  function stableStringify(val: unknown): string {
    if (val === null) return "null";
    if (typeof val !== "object" || Array.isArray(val)) {
      return JSON.stringify(val);
    }
    const keys = Object.keys(val as Record<string, unknown>).sort();
    const pairs = keys.map(
      (k) =>
        `${JSON.stringify(k)}:${
          stableStringify(
            (val as Record<string, unknown>)[k],
          )
        }`,
    );
    return `{${pairs.join(",")}}`;
  }
  const canonical = stableStringify(manifest);
  const enc = new TextEncoder();
  const data = enc.encode(canonical);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ============================================================
// Disk I/O
// ============================================================

/**
 * Load and validate a skill manifest from disk.
 */
export async function loadSkillManifest(
  skillDir: string,
): Promise<
  { ok: true; manifest: SkillManifest } | { ok: false; error: string }
> {
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
// SKILL.md generation
// ============================================================

function generateSkillMarkdown(
  name: string,
  description: string,
  manifest?: SkillManifest,
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
  lines.push("See `./examples.json` for sample input/output pairs.");
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
 * Returns the skill directory path.
 */
export async function promoteRunToSkill(
  run: RunRecord,
  name: string,
  description: string,
  options?: {
    entrypointContent?: string;
    skipIfExists?: boolean;
  },
): Promise<{ ok: true; skillDir: string } | { ok: false; error: string }> {
  if (!name.match(/^[a-z][a-z0-9_-]*$/)) {
    return {
      ok: false,
      error: `Invalid skill name: "${name}". Must match [a-z][a-z0-9_-]`,
    };
  }

  if (!run.schema_hash) {
    return {
      ok: false,
      error:
        "Cannot promote: run has no schema_hash (module did not export inputSchema)",
    };
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
      return { ok: true, skillDir };
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
    generateSkillMarkdown(name, description, manifest),
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

  const example = run.raw_input && run.output !== undefined
    ? { input: run.raw_input, output: run.output }
    : null;

  if (example) {
    await Deno.writeTextFile(
      `${skillDir}/examples.json`,
      JSON.stringify([example], null, 2),
    );
  }

  if (example) {
    const testContent = generateReplayTest(name, [example]);
    await Deno.writeTextFile(`${skillDir}/test.ts`, testContent);
  }

  run.promoted_to_skill = skillDir;
  await saveRun(run);

  return { ok: true, skillDir };
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

  const existing = await loadSkillApproval(skillDir);

  // No prior approval record
  if (!existing) {
    return {
      status: "need_approval",
      skillPath: skillDir,
      manifestHash: mHash,
    };
  }

  // Manifest (permissions) changed — re-approve
  if (existing.manifestHash !== mHash) {
    return {
      status: "need_approval",
      skillPath: skillDir,
      manifestHash: mHash,
    };
  }

  // Content changed — soft notification
  const cHash = await hashSkillContent(skillDir);
  if (existing.contentHash !== cHash) {
    return {
      status: "content_changed",
      skillPath: skillDir,
      manifestHash: mHash,
      contentHash: cHash,
    };
  }

  // Everything matches
  return { status: "approved" };
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
  const cHash = await hashSkillContent(skillDir);
  await saveSkillApproval({
    skillPath: skillDir,
    manifestHash: mHash,
    contentHash: cHash,
    approvedAt: new Date().toISOString(),
    requiresApproval: true,
  });

  return { ok: true };
}

function generateReplayTest(skillName: string, examples: unknown[]): string {
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
