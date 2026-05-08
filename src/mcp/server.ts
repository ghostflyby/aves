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
import type { RunRequest, ScriptMode } from "../types.ts";

const RUN_SCRIPT_TOOL = {
  name: "run_script",
  description: "Execute a script in sandboxed Deno",
  inputSchema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["eval", "module", "skill"],
        description: "Execution mode",
      },
      code: {
        type: "string",
        description: "Script code to execute (for eval mode)",
      },
      modulePath: {
        type: "string",
        description: "Path to module file (for module mode)",
      },
      input: {
        type: "object",
        description: "Input data passed to the script",
      },
      permissions: {
        type: "object",
        properties: {
          read: { type: "array", items: { type: "string" } },
          write: { type: "array", items: { type: "string" } },
          net: { type: "array", items: { type: "string" } },
          env: { type: "array", items: { type: "string" } },
        },
        description: "Permission overrides",
      },
    },
    required: ["mode"],
  },
};

const REPLAY_RUN_TOOL = {
  name: "replay_run",
  description: "Replay a previous run by ID",
  inputSchema: {
    type: "object",
    properties: {
      run_id: {
        type: "string",
        description: "Run ID to replay",
      },
    },
    required: ["run_id"],
  },
};

const LIST_RUNS_TOOL = {
  name: "list_runs",
  description: "List recent run records",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

async function handleRunScript(args: Record<string, unknown>) {
  const mode = args.mode as ScriptMode | undefined;
  if (!mode || !["eval", "module", "skill"].includes(mode)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid or missing mode: ${mode}. Must be one of: eval, module, skill`,
    );
  }

  const request: RunRequest = {
    mode,
    code: args.code as string | undefined,
    modulePath: args.modulePath as string | undefined,
    input: args.input as Record<string, unknown> | undefined,
    permissions: args.permissions as RunRequest["permissions"],
  };

  if (mode === "eval" && !request.code) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "code is required for eval mode",
    );
  }
  if (mode === "module" && !request.modulePath) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "modulePath is required for module mode",
    );
  }

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

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [RUN_SCRIPT_TOOL, REPLAY_RUN_TOOL, LIST_RUNS_TOOL],
  }));

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request: CallToolRequest) => {
      const { name, arguments: args } = request.params;

      switch (name) {
        case "run_script": {
          return await handleRunScript(args ?? {});
        }
        case "replay_run": {
          return await handleReplayRun(args ?? {});
        }
        case "list_runs": {
          return await handleListRuns();
        }
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
