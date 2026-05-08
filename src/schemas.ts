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
  input: z.record(z.unknown()).optional(),
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
  raw_input: z.record(z.unknown()).optional(),
  parsed_input: z.record(z.unknown()).optional(),
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
  input_schema: z.record(z.unknown()).optional(),
});

// ============================================================
// Inferred TypeScript types
// ============================================================

export type ScriptMode = z.infer<typeof ScriptModeSchema>;
export type Permissions = z.infer<typeof PermissionsSchema>;
export type RunRequest = z.infer<typeof RunRequestSchema>;
export type RunRecord = z.infer<typeof RunRecordSchema>;
export type SkillManifest = z.infer<typeof SkillManifestSchema>;

// ============================================================
// Zod -> JSON Schema converter (for MCP tool definitions)
// ============================================================

export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  if (schema instanceof z.ZodString) return { type: "string" };
  if (schema instanceof z.ZodNumber) return { type: "number" };
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };
  if (schema instanceof z.ZodArray) {
    return { type: "array", items: zodToJsonSchema(schema.element) };
  }
  if (schema instanceof z.ZodObject) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(schema.shape)) {
      properties[key] = zodToJsonSchema(value as z.ZodType);
      const v = value as z.ZodType;
      if (!(v instanceof z.ZodOptional) && !(v instanceof z.ZodDefault)) {
        required.push(key);
      }
    }
    const result: Record<string, unknown> = { type: "object", properties };
    if (required.length > 0) result.required = required;
    return result;
  }
  if (schema instanceof z.ZodOptional) return zodToJsonSchema(schema.unwrap());
  if (schema instanceof z.ZodNullable) {
    return { ...zodToJsonSchema(schema.unwrap()), nullable: true };
  }
  if (schema instanceof z.ZodEnum) {
    return { type: "string", enum: [...schema._def.values] };
  }
  if (schema instanceof z.ZodUnion) {
    const options = (schema._def as { options: z.ZodType[] }).options;
    return { oneOf: options.map(zodToJsonSchema) };
  }
  if (schema instanceof z.ZodDefault) return zodToJsonSchema(schema._def.innerType);
  if (schema instanceof z.ZodRecord) return { type: "object" };
  if (schema instanceof z.ZodEffects) return zodToJsonSchema(schema.innerType());
  return {};
}
