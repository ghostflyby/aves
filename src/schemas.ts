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
  cwd: z.string().optional().describe(
    "Working directory for the script (default: temp dir)",
  ),
  timeout_ms: z.number().int().positive().optional().describe(
    "Timeout in milliseconds",
  ),
});

const ModuleRunRequestSchema = z.object({
  mode: z.literal("module"),
  code: z.string().describe(ScriptFormatDescription).optional(),
  modulePath: z.string(),
  input: z.record(z.string(), z.unknown()).optional(),
  permissions: PermissionsSchema.optional(),
  cwd: z.string().optional().describe(
    "Working directory for the script (default: temp dir)",
  ),
  timeout_ms: z.number().int().positive().optional().describe(
    "Timeout in milliseconds",
  ),
});

export const RunRequestSchema = z.discriminatedUnion("mode", [
  EvalRunRequestSchema,
  ModuleRunRequestSchema,
]);

export const RunRecordSchema = z.object({
  run_id: z.string(),
  mode: ScriptModeSchema,
  code_hash: z.string().optional(),
  exit_code: z.number().nullable(),
  stdout: z.string().optional(), // runtime only — not persisted
  stderr: z.string().optional(), // runtime only — not persisted
  output: z.unknown().optional(), // runtime only — not persisted
  error: z.string().optional(), // runtime only — not persisted
  started_at: z.string(),
  finished_at: z.string(),
  duration_ms: z.number(),
  code: z.string().optional(),
});

// ============================================================
// Inferred TypeScript types
// ============================================================

export type ScriptMode = z.infer<typeof ScriptModeSchema>;
export type Permissions = z.infer<typeof PermissionsSchema>;
export type RunRequest = z.infer<typeof RunRequestSchema>;
export type RunRecord = z.infer<typeof RunRecordSchema>;
