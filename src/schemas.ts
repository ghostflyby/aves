import { z } from "zod";

// ============================================================
// Zod schemas — the primary contract system for Aves
// ============================================================

export const ScriptModeSchema = z.enum(["eval", "module", "skill"]);

export const PermissionsSchema = z.object({
  read: z.array(z.string()).optional(),
  write: z.array(z.string()).optional(),
  net: z.array(z.string()).optional(),
  env: z.array(z.string()).optional(),
});

const ScriptFormatDescription =
  "TypeScript module: export default async function main(input: unknown) { ... } as entry point. Supports Zod@4, Deno/node built-ins, ES module syntax.";

const EvalRunRequestSchema = z.object({
  mode: z.literal("eval"),
  code: z.string().describe(ScriptFormatDescription),
  input: z.record(z.string(), z.unknown()).optional(),
  permissions: PermissionsSchema.optional(),
});

const ModuleRunRequestSchema = z.object({
  mode: z.literal("module"),
  code: z.string().describe(ScriptFormatDescription).optional(),
  modulePath: z.string(),
  input: z.record(z.string(), z.unknown()).optional(),
  permissions: PermissionsSchema.optional(),
});

export const RunRequestSchema = z.discriminatedUnion("mode", [
  EvalRunRequestSchema,
  ModuleRunRequestSchema,
]);

export const RunRecordSchema = z.object({
  run_id: z.string(),
  mode: ScriptModeSchema,
  code_hash: z.string().optional(),
  schema_hash: z.string().optional(),
  raw_input: z.record(z.string(), z.unknown()).optional(),
  parsed_input: z.record(z.string(), z.unknown()).optional(),
  permissions: PermissionsSchema,
  granted_permissions: PermissionsSchema,
  denied_permissions: z.array(z.string()).optional(),
  stdout: z.string(),
  stderr: z.string(),
  exit_code: z.number().nullable(),
  output: z.unknown(),
  error: z.string().optional(),
  started_at: z.string(),
  finished_at: z.string(),
  duration_ms: z.number(),
  // Skill evolution fields
  project_path: z.string().optional(),
  promoted_to_skill: z.string().optional(),
  skill_path: z.string().optional(),
  input_schema_json: z.record(z.string(), z.unknown()).optional(),
  code: z.string().optional(),
});

export const SkillManifestSchema = z.object({
  version: z.string().optional(),
  permissions: PermissionsSchema,
  input_schema: z.record(z.string(), z.unknown()).optional(),
  entrypoint: z.string().default("./mod.ts"),
});

// ============================================================
// Inferred TypeScript types
// ============================================================

export type ScriptMode = z.infer<typeof ScriptModeSchema>;
export type Permissions = z.infer<typeof PermissionsSchema>;
export type RunRequest = z.infer<typeof RunRequestSchema>;
export type RunRecord = z.infer<typeof RunRecordSchema>;
export type SkillManifest = z.infer<typeof SkillManifestSchema>;
