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
  modulePath: z.string().describe("Path to external module file (module mode)")
    .optional(),
  input: z.record(z.string(), z.unknown()).describe(
    "Input arguments for the script",
  ).optional(),
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
  cluster_by: z.enum(["code"]).default("code")
    .describe("Clustering dimension"),
});

export const PromoteToSkillInputSchema = z.object({
  run_id: z.string().describe("Run ID to promote"),
  name: z.string()
    .regex(/^[a-z][a-z0-9_-]*$/)
    .describe("Skill name (used as directory name)"),
  description: z.string().describe("Human-readable skill description"),
});

export const ListRunsInputSchema = z.object({
  mode: z.enum(["eval", "module", "skill"]).describe("Filter by execution mode")
    .optional(),
  exit_code: z.number().int().describe("Filter by exact exit code").optional(),
  started_after: z.string().describe(
    "ISO timestamp: only runs started at or after this time",
  ).optional(),
  started_before: z.string().describe(
    "ISO timestamp: only runs started before this time",
  ).optional(),
  limit: z.number().int().min(1).max(1000).default(100).describe(
    "Max records to return",
  ),
  offset: z.number().int().min(0).default(0).describe("Skip N records"),
  order_by: z.enum(["started_at", "duration_ms", "exit_code", "mode"]).default(
    "started_at",
  ).describe("Sort column"),
  order_dir: z.enum(["asc", "desc"]).default("desc").describe("Sort direction"),
});

export const QueryRunsInputSchema = z.object({
  sql: z.string().describe("Read-only SQL query (SELECT/PRAGMA only)"),
  params: z.array(z.union([z.string(), z.number(), z.null()])).optional()
    .describe("Query parameters for prepared statement"),
  timeout_ms: z.number().int().min(100).max(30000).default(10000).describe(
    "Query timeout in milliseconds",
  ),
});

// Inferred types
export type ReplayRunInput = z.infer<typeof ReplayRunInputSchema>;
export type RunSkillInput = z.infer<typeof RunSkillInputSchema>;
export type SuggestSkillsInput = z.infer<typeof SuggestSkillsInputSchema>;
export type PromoteToSkillInput = z.infer<typeof PromoteToSkillInputSchema>;
export type ListRunsInput = z.infer<typeof ListRunsInputSchema>;
export type QueryRunsInput = z.infer<typeof QueryRunsInputSchema>;
