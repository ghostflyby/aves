import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  type CallToolRequest,
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { executeRun } from "../runner.ts";
import { listRuns, loadRun, saveRun } from "../run-store.ts";
import { RunRequestBaseSchema, RunRequestSchema } from "../schemas.ts";
import type { RunRequest } from "../types.ts";

// Tool input schemas generated from Zod — single source of truth
const RUN_SCRIPT_TOOL = {
  name: "run_script",
  description: "Execute a script in sandboxed Deno",
  inputSchema: RunRequestBaseSchema.toJSONSchema(),
};

const REPLAY_RUN_TOOL = {
  name: "replay_run",
  description: "Replay a previous run by ID",
  inputSchema: {
    type: "object" as const,
    properties: {
      run_id: { type: "string" as const, description: "Run ID to replay" },
    },
    required: ["run_id"],
  },
};

const LIST_RUNS_TOOL = {
  name: "list_runs",
  description: "List recent run records",
  inputSchema: {
    type: "object" as const,
    properties: {},
  },
};

async function handleRunScript(args: Record<string, unknown>) {
  // Validate with the refined Zod schema
  const result = RunRequestSchema.safeParse(args);
  if (!result.success) {
    throw new McpError(
      ErrorCode.InvalidParams,
      result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }

  const request: RunRequest = result.data;
  const record = await executeRun(request);
  await saveRun(record);
  return {
    content: [{ type: "text", text: JSON.stringify(record, null, 2) }],
  };
}

async function handleReplayRun(args: Record<string, unknown>) {
  const runId = args.run_id as string | undefined;
  if (!runId) {
    throw new McpError(ErrorCode.InvalidParams, "run_id is required");
  }

  const record = await loadRun(runId);
  if (!record) {
    throw new McpError(ErrorCode.InvalidParams, `Run not found: ${runId}`);
  }

  return {
    content: [{ type: "text", text: JSON.stringify(record, null, 2) }],
  };
}

async function handleListRuns() {
  const records = await listRuns();
  return {
    content: [{ type: "text", text: JSON.stringify(records, null, 2) }],
  };
}

export async function startServer() {
  const server = new Server(
    {
      name: "aves-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [RUN_SCRIPT_TOOL, REPLAY_RUN_TOOL, LIST_RUNS_TOOL],
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
