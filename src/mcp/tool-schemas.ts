import { z } from "zod";
import { PermissionsSchema } from "../schemas.ts";

/**
 * Zod schemas for MCP tool inputSchema (flat object — MCP SDK requires type:object at root).
 * Runtime validation still uses the stricter RunRequestSchema in schemas.ts.
 */

export const ReplayRunInputSchema = z.object({
  run_id: z.string().describe("Run ID to replay"),
});

export const RunScriptInputSchema = z.object({
  mode: z.enum(["eval", "module"]).describe("Script execution mode"),
  code: z.string().describe(
    "TypeScript module: export default async function main(input: unknown) { ... } as entry point. Supports Zod@4, Deno/node built-ins, ES module syntax.",
  ).optional(),
  modulePath: z.string().describe("Path to external module file (module mode)").optional(),
  input: z.record(z.string(), z.unknown()).describe("Input arguments for the script").optional(),
  permissions: PermissionsSchema.optional().describe("Permission overrides"),
});

export const RunSkillInputSchema = z.object({
  skill_path: z.string().describe("Path to the skill directory"),
  input: z.record(z.string(), z.unknown()).optional()
    .describe("Input arguments for the skill"),
  permissions: PermissionsSchema.optional()
    .describe("Permission overrides (can only shrink)"),
});

export const SuggestSkillsInputSchema = z.object({
  min_runs: z.number().int().min(1).default(2)
    .describe("Minimum runs to consider a cluster"),
  cluster_by: z.enum(["schema", "code", "both"]).default("schema")
    .describe("Clustering dimension"),
});

export const PromoteToSkillInputSchema = z.object({
  run_id: z.string().describe("Run ID to promote"),
  name: z.string()
    .regex(/^[a-z][a-z0-9_-]*$/)
    .describe("Skill name (used as directory name)"),
  description: z.string().describe("Human-readable skill description"),
});

// Inferred types
export type ReplayRunInput = z.infer<typeof ReplayRunInputSchema>;
export type RunSkillInput = z.infer<typeof RunSkillInputSchema>;
export type SuggestSkillsInput = z.infer<typeof SuggestSkillsInputSchema>;
export type PromoteToSkillInput = z.infer<typeof PromoteToSkillInputSchema>;
