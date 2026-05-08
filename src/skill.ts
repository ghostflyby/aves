import { z } from "zod";
import { SkillManifestSchema } from "./schemas.ts";
import type { Permissions, RunRecord, SkillManifest } from "./types.ts";
import { resolvePermissions } from "./policy.ts";
import { saveRun } from "./run-store.ts";

// Skill directory structure (future use):
// skills/<name>/
//   mod.ts         — the skill module (export default main)
//   skill.json     — SkillManifest
//   input.schema.json
//   examples.json

const SKILLS_DIR = "skills";

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
 * Promote a run record to a skill.
 * Validates that:
 * 1. The run has a stable output schema (has inputSchema/schema_hash)
 * 2. The permissions are consistent
 * 3. The skill name is valid
 */
export async function promoteRunToSkill(
  run: RunRecord,
  name: string,
  description: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Validate name
  if (!name.match(/^[a-z][a-z0-9_]*$/)) {
    return {
      ok: false,
      error: `Invalid skill name: "${name}". Must match [a-z][a-z0-9_]`,
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
      error: `Cannot promote: permissions were denied for: ${
        denied.join(", ")
      }`,
    };
  }

  const manifest: SkillManifest = {
    name,
    description,
    permissions: run.granted_permissions,
  };

  const validation = validateManifest(manifest);
  if (!validation.ok) return validation;

  return { ok: true };
}
