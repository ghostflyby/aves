import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  type CallToolRequest,
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { executeRun, executeSkillRun } from "../runner.ts";
import { findClusteredRuns, listRuns, loadRun, saveRun } from "../run-store.ts";
import { RunRequestSchema } from "../schemas.ts";
import { listSkills, promoteRunToSkill } from "../skill.ts";
import {
  PromoteToSkillInputSchema,
  ReplayRunInputSchema,
  RunSkillInputSchema,
  SuggestSkillsInputSchema,
} from "./tool-schemas.ts";

// ============================================================
// Tool definitions — inputSchema generated from Zod (single source of truth)
// ============================================================

const RUN_SCRIPT_TOOL = {
  name: "run_script",
  description: "Execute a script in sandboxed Deno",
  inputSchema: RunRequestSchema.toJSONSchema(),
  annotations: { destructiveHint: true },
};

const REPLAY_RUN_TOOL = {
  name: "replay_run",
  description: "Replay a previous run by ID",
  inputSchema: ReplayRunInputSchema.toJSONSchema(),
  annotations: { readOnlyHint: true },
};

const LIST_RUNS_TOOL = {
  name: "list_runs",
  description: "List recent run records",
  inputSchema: { type: "object" as const, properties: {} },
  annotations: { readOnlyHint: true },
};

const RUN_SKILL_TOOL = {
  name: "run_skill",
  description: "Execute a skill by its directory path",
  inputSchema: RunSkillInputSchema.toJSONSchema(),
  annotations: { destructiveHint: true },
};

const SUGGEST_SKILLS_TOOL = {
  name: "suggest_skills",
  description: "Find run clusters that look like skill candidates",
  inputSchema: SuggestSkillsInputSchema.toJSONSchema(),
  annotations: { readOnlyHint: true },
};

const PROMOTE_TO_SKILL_TOOL = {
  name: "promote_to_skill",
  description: "Promote a run to a skill, writing to disk",
  inputSchema: PromoteToSkillInputSchema.toJSONSchema(),
  annotations: { destructiveHint: true },
};

const LIST_SKILLS_TOOL = {
  name: "list_skills",
  description: "List all discovered skills in configured roots",
  inputSchema: { type: "object" as const, properties: {} },
  annotations: { readOnlyHint: true },
};

// ============================================================
// Request handlers — all input validated with Zod .safeParse()
// ============================================================

async function handleRunScript(args: Record<string, unknown>) {
  const result = RunRequestSchema.safeParse(args);
  if (!result.success) {
    throw new McpError(
      ErrorCode.InvalidParams,
      result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }

  const record = await executeRun(result.data);
  await saveRun(record);
  return { content: [{ type: "text", text: JSON.stringify(record, null, 2) }] };
}

async function handleReplayRun(args: Record<string, unknown>) {
  const parsed = ReplayRunInputSchema.safeParse(args);
  if (!parsed.success) {
    throw new McpError(
      ErrorCode.InvalidParams,
      parsed.error.issues.map((i) => i.message).join("; "),
    );
  }

  const record = await loadRun(parsed.data.run_id);
  if (!record) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Run not found: ${parsed.data.run_id}`,
    );
  }

  return { content: [{ type: "text", text: JSON.stringify(record, null, 2) }] };
}

async function handleListRuns() {
  const records = await listRuns();
  return {
    content: [{ type: "text", text: JSON.stringify(records, null, 2) }],
  };
}

async function handleRunSkill(args: Record<string, unknown>) {
  const parsed = RunSkillInputSchema.safeParse(args);
  if (!parsed.success) {
    throw new McpError(
      ErrorCode.InvalidParams,
      parsed.error.issues.map((i) => i.message).join("; "),
    );
  }

  const { skill_path, input, permissions } = parsed.data;
  const result = await executeSkillRun(skill_path, input ?? {}, {
    permissionsOverride: permissions,
  });

  if (!result.record) {
    throw new McpError(
      ErrorCode.InternalError,
      "Skill execution failed: no record returned",
    );
  }

  await saveRun(result.record);
  return {
    content: [{ type: "text", text: JSON.stringify(result.record, null, 2) }],
  };
}

async function handleSuggestSkills(args: Record<string, unknown>) {
  const parsed = SuggestSkillsInputSchema.safeParse(args);
  if (!parsed.success) {
    throw new McpError(
      ErrorCode.InvalidParams,
      parsed.error.issues.map((i) => i.message).join("; "),
    );
  }

  const clusters = await findClusteredRuns();
  const minRuns = parsed.data.min_runs;
  const filtered = clusters.filter((c) => c.count >= minRuns);

  const suggestions = filtered.map((c) => ({
    schema_hash: c.schema_hash,
    run_count: c.count,
    first_run: c.runs[c.runs.length - 1]?.started_at,
    last_run: c.runs[0]?.started_at,
    sample_input: c.runs[0]?.raw_input,
    sample_output: c.runs[0]?.output,
  }));

  return {
    content: [{
      type: "text",
      text: JSON.stringify({ suggestions, total_clusters: filtered.length }),
    }],
  };
}

async function handlePromoteToSkill(args: Record<string, unknown>) {
  const parsed = PromoteToSkillInputSchema.safeParse(args);
  if (!parsed.success) {
    throw new McpError(
      ErrorCode.InvalidParams,
      parsed.error.issues.map((i) => i.message).join("; "),
    );
  }

  const { run_id, name, description } = parsed.data;
  const run = await loadRun(run_id);
  if (!run) {
    throw new McpError(ErrorCode.InvalidParams, `Run not found: ${run_id}`);
  }

  const result = await promoteRunToSkill(run, name, description);
  if (!result.ok) {
    throw new McpError(ErrorCode.InvalidParams, result.error);
  }

  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

async function handleListSkills() {
  const skills = await listSkills();
  return {
    content: [{ type: "text", text: JSON.stringify({ skills }, null, 2) }],
  };
}

// ============================================================
// Server startup
// ============================================================

/**
 * Start an HTTP MCP server (long-running daemon).
 * Registers endpoint info for discovery by stdio adapter.
 */
export async function startHttpServer(
  port: number,
  host: string = "127.0.0.1",
): Promise<{ port: number }> {
  const mcpServer = new Server(
    { name: "aves-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: crypto.randomUUID.bind(crypto),
  });

  mcpServer.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      RUN_SCRIPT_TOOL,
      REPLAY_RUN_TOOL,
      LIST_RUNS_TOOL,
      RUN_SKILL_TOOL,
      SUGGEST_SKILLS_TOOL,
      PROMOTE_TO_SKILL_TOOL,
      LIST_SKILLS_TOOL,
    ],
  }));

  mcpServer.setRequestHandler(
    CallToolRequestSchema,
    async (request: CallToolRequest) => {
      const { name, arguments: args } = request.params;
      switch (name) {
        case "run_script":
          return await handleRunScript(args ?? {});
        case "replay_run":
          return await handleReplayRun(args ?? {});
        case "list_runs":
          return await handleListRuns();
        case "run_skill":
          return await handleRunSkill(args ?? {});
        case "suggest_skills":
          return await handleSuggestSkills(args ?? {});
        case "promote_to_skill":
          return await handlePromoteToSkill(args ?? {});
        case "list_skills":
          return await handleListSkills();
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    },
  );

  await mcpServer.connect(transport);

  const controller = new AbortController();
  Deno.serve({
    port,
    hostname: host,
    signal: controller.signal,
    onListen: ({ port: actualPort }) => {
      console.error(`Aves MCP HTTP server listening on ${host}:${actualPort}`);
    },
  }, async (req: Request) => {
    return transport.handleRequest(req);
  });

  // Return the port (may differ if 0 was passed)
  return { port };
}

export async function startServer() {
  const server = new Server(
    {
      name: "aves-mcp",
      version: "0.1.0",
    },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      RUN_SCRIPT_TOOL,
      REPLAY_RUN_TOOL,
      LIST_RUNS_TOOL,
      RUN_SKILL_TOOL,
      SUGGEST_SKILLS_TOOL,
      PROMOTE_TO_SKILL_TOOL,
      LIST_SKILLS_TOOL,
    ],
  }));

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request: CallToolRequest) => {
      const { name, arguments: args } = request.params;

      switch (name) {
        case "run_script":
          return await handleRunScript(args ?? {});
        case "replay_run":
          return await handleReplayRun(args ?? {});
        case "list_runs":
          return await handleListRuns();
        case "run_skill":
          return await handleRunSkill(args ?? {});
        case "suggest_skills":
          return await handleSuggestSkills(args ?? {});
        case "promote_to_skill":
          return await handlePromoteToSkill(args ?? {});
        case "list_skills":
          return await handleListSkills();
        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${name}`,
          );
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Aves MCP server started on stdio");
}
