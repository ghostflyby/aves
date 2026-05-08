import { z } from "zod";
import { PermissionsSchema } from "../schemas.ts";

/**
 * Zod schemas for MCP tool inputs.
 * Single source of truth for both JSON Schema generation and runtime validation.
 */

export const ReplayRunInputSchema = z.object({
  run_id: z.string().describe("Run ID to replay"),
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
