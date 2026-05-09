import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  type CallToolRequest,
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { executeRun, executeSkillRun } from "../runner.ts";
import {
  findClusteredRuns,
  findRepeatedRuns,
  listRuns,
  listRunsFiltered,
  loadRun,
  saveRun,
} from "../run-store.ts";
import { RunRequestSchema } from "../schemas.ts";
import {
  approveSkill,
  checkSkillApproval,
  listSkills,
  promoteRunToSkill,
} from "../skill.ts";
import {
  ListRunsInputSchema,
  PromoteToSkillInputSchema,
  QuerySqliteInputSchema,
  ReplayRunInputSchema,
  RunScriptInputSchema,
  RunSkillInputSchema,
  SuggestSkillsInputSchema,
} from "./tool-schemas.ts";

// ============================================================
// Tool definitions — inputSchema generated from Zod (single source of truth)
// ============================================================

const RUN_SCRIPT_TOOL = {
  name: "run_script",
  description:
    'Execute a TypeScript module in a sandboxed Deno subprocess. Script format: export default async function main(input: unknown) { ... } — the default export receives the `input` object and is awaited. Optionally export `inputSchema` (Zod@4 schema) for runtime input validation. Supports `import { z } from "zod"`, Deno built-ins, and node:compat libraries (node:fs, node:path, node:os). ES module format only. Use mode: "eval" with inline code, or mode: "module" with a modulePath. Runs with --no-prompt; permissions from the request parameter.',
  inputSchema: RunScriptInputSchema.toJSONSchema(),
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
  inputSchema: ListRunsInputSchema.toJSONSchema(),
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

const QUERY_SQLITE_TOOL = {
  name: "query_sqlite",
  description:
    "Run a read-only SQL query against the Aves SQLite database. Only SELECT and PRAGMA statements are allowed.",
  inputSchema: QuerySqliteInputSchema.toJSONSchema(),
  annotations: { readOnlyHint: true },
};

// ============================================================
// Module-level server reference — set by startup functions
// ============================================================

let _mcpServer: Server | null = null;

const ElicitationResponseSchema = z.object({
  action: z.string(),
});

function isElicitationApproved(
  result: unknown,
): boolean {
  const r = result as Record<string, unknown>;
  return r?.action === "accept";
}

// ============================================================
// Request handlers — all input validated with Zod .safeParse()
// ============================================================

function permsDesc(permissions: Record<string, string[] | undefined>): string {
  const parts: string[] = [];
  for (const key of ["read", "write", "net", "env"] as const) {
    const vals = permissions[key];
    if (vals && vals.length > 0) {
      parts.push(`  ${key}: ${vals.join(", ")}`);
    }
  }
  return parts.length > 0 ? parts.join("\n") : "(none)";
}

async function elicitScriptApproval(
  mode: string,
  permissions: Record<string, string[] | undefined>,
): Promise<boolean> {
  const server = _mcpServer;
  if (!server) return false;

  const modeLabel = mode === "eval" ? "Eval" : "Module";
  const hasPerms = Object.values(permissions).some((v) => v && v.length > 0);
  const msg = hasPerms
    ? `Approve ${modeLabel} script execution?\n\nRequested permissions:\n${
      permsDesc(permissions)
    }`
    : `Approve ${modeLabel} script execution?\n\nNo special permissions requested.`;

  const result = await server.request(
    {
      method: "elicitation/create",
      params: {
        mode: "form",
        message: msg,
        requestedSchema: {
          type: "object",
          properties: {
            approved: {
              type: "boolean",
              title: "Approve",
              description: "Approve execution with the listed permissions",
            },
          },
        },
      },
    },
    ElicitationResponseSchema,
  );
  return isElicitationApproved(result);
}

async function handleRunScript(args: Record<string, unknown>) {
  const result = RunRequestSchema.safeParse(args);
  if (!result.success) {
    throw new McpError(
      ErrorCode.InvalidParams,
      result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }

  if (
    !await elicitScriptApproval(result.data.mode, result.data.permissions ?? {})
  ) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: false,
          error: "Script execution rejected by user",
        }),
      }],
    };
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

async function handleListRuns(args?: Record<string, unknown>) {
  const parsed = args ? ListRunsInputSchema.safeParse(args) : null;
  const records = parsed?.success
    ? await listRunsFiltered(parsed.data)
    : await listRuns();
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

  // Check skill approval status
  const approvalStatus = await checkSkillApproval(skill_path);

  if (approvalStatus.status === "not_found") {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Skill not found or invalid: ${approvalStatus.error}`,
    );
  }

  // Content changed — notify and ask user to confirm
  if (approvalStatus.status === "content_changed") {
    const server = _mcpServer;
    if (!server) {
      throw new McpError(
        ErrorCode.InternalError,
        "MCP server not initialized",
      );
    }

    const elicitResult = await server.request(
      {
        method: "elicitation/create",
        params: {
          mode: "form",
          message: [
            `Skill content has changed since last approval. Continue with same permissions?`,
            `Path: ${skill_path}`,
            ...(permissions
              ? [``, `Permissions override:`, permsDesc(permissions)]
              : [``, `Permissions override: none`]),
          ].join("\n"),
          requestedSchema: {
            type: "object",
            properties: {},
          },
        },
      },
      ElicitationResponseSchema,
    );

    if (!isElicitationApproved(elicitResult)) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: false,
            error: "Skill execution cancelled due to content change",
          }),
        }],
      };
    }

    const approveResult = await approveSkill(skill_path);
    if (!approveResult.ok) {
      throw new McpError(ErrorCode.InternalError, approveResult.error);
    }
  }

  // Need approval — send Elicitation to the client
  if (approvalStatus.status === "need_approval") {
    const server = _mcpServer;
    if (!server) {
      throw new McpError(
        ErrorCode.InternalError,
        "MCP server not initialized",
      );
    }

    // Use server.request() to send an elicitation/create request
    // asking the client to present an approval prompt to the user
    const elicitResult = await server.request(
      {
        method: "elicitation/create",
        params: {
          mode: "form",
          message: [
            `Approve skill execution?`,
            `Path: ${skill_path}`,
            ``,
            ...(permissions
              ? [`Permissions override:`, permsDesc(permissions)]
              : [`Permissions override: none`]),
          ].join("\n"),
          requestedSchema: {
            type: "object",
            properties: {},
          },
        },
      },
      ElicitationResponseSchema,
    );

    if (!isElicitationApproved(elicitResult)) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: false,
            error: "Skill execution rejected by user",
          }),
        }],
      };
    }

    // Record approval
    const approveResult = await approveSkill(skill_path);
    if (!approveResult.ok) {
      throw new McpError(ErrorCode.InternalError, approveResult.error);
    }
  }

  // If skill has override permissions, ask for confirmation
  if (
    permissions &&
    (permissions.read?.length ?? 0) + (permissions.write?.length ?? 0) +
          (permissions.net?.length ?? 0) + (permissions.env?.length ?? 0) > 0
  ) {
    const server = _mcpServer;
    if (!server) {
      throw new McpError(ErrorCode.InternalError, "MCP server not initialized");
    }
    const result = await server.request(
      {
        method: "elicitation/create",
        params: {
          mode: "form",
          message: [
            `Skill is approved, but agent requests a permissions override:`,
            permsDesc(permissions),
            ``,
            `Continue with restricted permissions?`,
          ].join("\n"),
          requestedSchema: {
            type: "object",
            properties: {},
          },
        },
      },
      ElicitationResponseSchema,
    );
    if (!isElicitationApproved(result)) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: false,
            error: "Permissions override rejected by user",
          }),
        }],
      };
    }
  }

  // Approved — execute
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

  const { min_runs, cluster_by } = parsed.data;
  const suggestions: Record<string, unknown>[] = [];
  let totalClusters = 0;

  if (cluster_by === "schema" || cluster_by === "both") {
    const clusters = await findClusteredRuns();
    const filtered = clusters.filter((c) => c.count >= min_runs);
    totalClusters += filtered.length;

    for (const c of filtered) {
      const suggestedName = c.runs[c.runs.length - 1]?.raw_input
        ? Object.keys(c.runs[c.runs.length - 1]!.raw_input!).slice(0, 4).join(
          "_",
        ).toLowerCase()
          .replace(/[^a-z0-9_]/g, "_").replace(/_+/, "_").replace(/^_|_$/g, "")
        : undefined;

      suggestions.push({
        dimension: "schema",
        schema_hash: c.schema_hash,
        run_count: c.count,
        first_run: c.runs[c.runs.length - 1]?.started_at,
        last_run: c.runs[0]?.started_at,
        sample_input: c.runs[0]?.raw_input,
        sample_output: c.runs[0]?.output,
        suggested_name: suggestedName,
      });
    }
  }

  if (cluster_by === "code" || cluster_by === "both") {
    const clusters = await findRepeatedRuns();
    const filtered = clusters.filter((c) => c.count >= min_runs);
    totalClusters += filtered.length;

    for (const c of filtered) {
      const suggestedName = c.runs[c.runs.length - 1]?.raw_input
        ? Object.keys(c.runs[c.runs.length - 1]!.raw_input!).slice(0, 4).join(
          "_",
        ).toLowerCase()
          .replace(/[^a-z0-9_]/g, "_").replace(/_+/, "_").replace(/^_|_$/g, "")
        : undefined;

      suggestions.push({
        dimension: "code",
        code_hash: c.code_hash,
        run_count: c.count,
        first_run: c.runs[c.runs.length - 1]?.started_at,
        last_run: c.runs[0]?.started_at,
        sample_input: c.runs[0]?.raw_input,
        sample_output: c.runs[0]?.output,
        suggested_name: suggestedName,
      });
    }
  }

  return {
    content: [{
      type: "text",
      text: JSON.stringify({ suggestions, total_clusters: totalClusters }),
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

async function handleQuerySqlite(args?: Record<string, unknown>) {
  const parsed = args ? QuerySqliteInputSchema.safeParse(args) : null;
  if (!parsed?.success) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "query_sqlite requires valid params",
    );
  }

  // Enforce SELECT/PRAGMA only (defense-in-depth beyond readOnly: true)
  const sql = parsed.data.sql.trim();
  const isSelect = /^SELECT\b/i.test(sql);
  const isPragma = /^PRAGMA\b/i.test(sql);
  if (!isSelect && !isPragma) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "query_sqlite only allows SELECT and PRAGMA statements",
    );
  }

  // Execute via pooled Worker
  const { querySqlite } = await import("./query-pool.ts");
  const result = await querySqlite(
    parsed.data.sql,
    parsed.data.params,
    parsed.data.timeout_ms,
  );

  if (!result.ok) {
    throw new McpError(ErrorCode.InternalError, result.error ?? "Query failed");
  }

  return {
    content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }],
  };
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
  host: string = "127.0.0.1",
): Promise<{ port: number }> {
  const mcpServer = new Server(
    { name: "aves-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // Make the server instance available to handlers
  _mcpServer = mcpServer;

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
      QUERY_SQLITE_TOOL,
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
        case "query_sqlite":
          return await handleQuerySqlite(args ?? {});
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    },
  );

  await mcpServer.connect(transport);

  const controller = new AbortController();
  const { promise: portPromise, resolve: resolvePort } = Promise.withResolvers<
    number
  >();
  Deno.serve({
    port: 0,
    hostname: host,
    signal: controller.signal,
    onListen: ({ port: actualPort }) => {
      console.error(`Aves MCP HTTP server listening on ${host}:${actualPort}`);
      resolvePort(actualPort);
    },
  }, (req: Request) => {
    return transport.handleRequest(req);
  });

  return { port: await portPromise };
}

export async function startServer() {
  const server = new Server(
    {
      name: "aves-mcp",
      version: "0.1.0",
    },
    { capabilities: { tools: {} } },
  );

  // Make the server instance available to handlers
  _mcpServer = server;

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      RUN_SCRIPT_TOOL,
      REPLAY_RUN_TOOL,
      LIST_RUNS_TOOL,
      RUN_SKILL_TOOL,
      SUGGEST_SKILLS_TOOL,
      PROMOTE_TO_SKILL_TOOL,
      LIST_SKILLS_TOOL,
      QUERY_SQLITE_TOOL,
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
          return await handleListRuns(args ?? {});
        case "run_skill":
          return await handleRunSkill(args ?? {});
        case "suggest_skills":
          return await handleSuggestSkills(args ?? {});
        case "promote_to_skill":
          return await handlePromoteToSkill(args ?? {});
        case "list_skills":
          return await handleListSkills();
        case "query_sqlite":
          return await handleQuerySqlite(args ?? {});
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
