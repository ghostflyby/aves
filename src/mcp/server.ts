import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  type CallToolRequest,
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { executeRun, executeSkillRun } from "../runner.ts";
import { listRuns, loadRun, saveRun, findClusteredRuns } from "../run-store.ts";
import { RunRequestSchema } from "../schemas.ts";
import type {
  Permissions,
  RunRequest,
} from "../types.ts";
import {
  promoteRunToSkill,
  listSkills,
  approveSkill,
  checkSkillApproval,
} from "../skill.ts";

// ============================================================
// Tool definitions with annotations
// ============================================================

const RUN_SCRIPT_TOOL = {
  name: "run_script",
  description: "Execute a script in sandboxed Deno",
  inputSchema: RunRequestSchema.toJSONSchema(),
  annotations: {
    destructiveHint: true,
  },
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
  annotations: {
    readOnlyHint: true,
  },
};

const LIST_RUNS_TOOL = {
  name: "list_runs",
  description: "List recent run records",
  inputSchema: {
    type: "object" as const,
    properties: {},
  },
  annotations: {
    readOnlyHint: true,
  },
};

const RUN_SKILL_TOOL = {
  name: "run_skill",
  description: "Execute a skill by its directory path",
  inputSchema: {
    type: "object" as const,
    properties: {
      skill_path: {
        type: "string" as const,
        description: "Path to the skill directory",
      },
      input: {
        type: "object" as const,
        description: "Input arguments for the skill",
        additionalProperties: {},
      },
      permissions: {
        type: "object" as const,
        description: "Permission overrides (can only shrink)",
        properties: {
          read: { type: "array" as const, items: { type: "string" as const } },
          write: { type: "array" as const, items: { type: "string" as const } },
          net: { type: "array" as const, items: { type: "string" as const } },
          env: { type: "array" as const, items: { type: "string" as const } },
        },
      },
    },
    required: ["skill_path"],
  },
  annotations: {
    destructiveHint: true,
  },
};

const SUGGEST_SKILLS_TOOL = {
  name: "suggest_skills",
  description: "Find run clusters that look like skill candidates",
  inputSchema: {
    type: "object" as const,
    properties: {
      min_runs: {
        type: "number" as const,
        description: "Minimum runs to consider a cluster (default: 2)",
      },
    },
  },
  annotations: {
    readOnlyHint: true,
  },
};

const PROMOTE_TO_SKILL_TOOL = {
  name: "promote_to_skill",
  description: "Promote a run to a skill, writing to disk",
  inputSchema: {
    type: "object" as const,
    properties: {
      run_id: {
        type: "string" as const,
        description: "Run ID to promote",
      },
      name: {
        type: "string" as const,
        description:
          "Skill name (used as directory name, must match [a-z][a-z0-9_-])",
      },
      description: {
        type: "string" as const,
        description: "Human-readable skill description",
      },
    },
    required: ["run_id", "name", "description"],
  },
  annotations: {
    destructiveHint: true,
  },
};
const LIST_SKILLS_TOOL = {
  name: "list_skills",
  description: "List all discovered skills in configured roots",
  inputSchema: {
    type: "object" as const,
    properties: {},
  },
  annotations: {
    readOnlyHint: true,
  },
};

// ============================================================
// Request handlers
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

  const request: RunRequest = result.data;
  const record = await executeRun(request);
  await saveRun(record);
  return {
    content: [{ type: "text", text: JSON.stringify(record, null, 2) }],
  };
}

async function handleRunSkill(args: Record<string, unknown>) {
  const skillPath = args.skill_path as string | undefined;
  if (!skillPath) {
    throw new McpError(ErrorCode.InvalidParams, "skill_path is required");
  }

  const input = (args.input ?? {}) as Record<string, unknown>;
  const permOverride = args.permissions as Permissions | undefined;

  const result = await executeSkillRun(skillPath, input, {
    permissionsOverride: permOverride,
  });

  if (result.status === "need_approval") {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          status: "need_approval",
          message:
            "This skill requires approval. Call approve_skill to approve it, then retry.",
          skill_path: result.approvalInfo?.skillPath,
          manifest_hash: result.approvalInfo?.manifestHash,
        }, null, 2),
      }],
    };
  }

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

async function handleApproveSkill(args: Record<string, unknown>) {
  const skillPath = args.skill_path as string | undefined;
  if (!skillPath) {
    throw new McpError(ErrorCode.InvalidParams, "skill_path is required");
  }

  const result = await approveSkill(skillPath);
  if (!result.ok) {
    throw new McpError(ErrorCode.InvalidParams, result.error);
  }

  return {
    content: [{
      type: "text",
      text: JSON.stringify({ status: "approved", skill_path: skillPath }, null, 2),
    }],
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

async function handleSuggestSkills(args: Record<string, unknown>) {
  const clusters = await findClusteredRuns();
  const minRuns = (args.min_runs as number) ?? 2;
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
  const runId = args.run_id as string;
  const name = args.name as string;
  const description = args.description as string;

  const run = await loadRun(runId);
  if (!run) {
    throw new McpError(ErrorCode.InvalidParams, `Run not found: ${runId}`);
  }

  const result = await promoteRunToSkill(run, name, description);
  if (!result.ok) {
    throw new McpError(ErrorCode.InvalidParams, result.error);
  }

  return {
    content: [{
      type: "text",
      text: JSON.stringify(result, null, 2),
    }],
  };
}

async function handleListSkills() {
  const skills = await listSkills();
  return {
    content: [{
      type: "text",
      text: JSON.stringify({ skills }, null, 2),
    }],
  };
}

// ============================================================
// Server startup
// ============================================================

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
        case "approve_skill":
          return await handleApproveSkill(args ?? {});
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
