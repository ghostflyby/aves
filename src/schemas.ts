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

// Base without refine — used for JSON Schema generation
export const RunRequestBaseSchema = z.object({
  mode: ScriptModeSchema,
  code: z.string().optional(),
  modulePath: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  permissions: PermissionsSchema.optional(),
});

export const RunRequestSchema = RunRequestBaseSchema.refine(
  (data) => {
    if (data.mode === "eval") return !!data.code;
    if (data.mode === "module") return !!data.modulePath;
    return true;
  },
  { message: "eval mode requires code, module mode requires modulePath" },
);

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
});

export const SkillManifestSchema = z.object({
  name: z.string(),
  description: z.string(),
  permissions: PermissionsSchema,
  input_schema: z.record(z.string(), z.unknown()).optional(),
});

// ============================================================
// Inferred TypeScript types
// ============================================================

export type ScriptMode = z.infer<typeof ScriptModeSchema>;
export type Permissions = z.infer<typeof PermissionsSchema>;
export type RunRequest = z.infer<typeof RunRequestSchema>;
export type RunRecord = z.infer<typeof RunRecordSchema>;
export type SkillManifest = z.infer<typeof SkillManifestSchema>;
