import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  type CallToolRequest,
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { executeRun, executeSkillRun } from "../runner.ts";
import { listRuns, listRunsFiltered, loadRun, saveRun } from "../run-store.ts";
import { RunRequestSchema } from "../schemas.ts";
import {
  handleListResources,
  handleListResourceTemplates,
  handleReadResource,
} from "./resources.ts";
import {
  AVES_PROMPT_DESCRIPTION,
  AVES_PROMPT_NAME,
  buildAvesPrompt,
} from "./prompt-handlers.ts";
import { RUNS_TABLE_DDL } from "../db-schema.ts";
import { listSkills, promoteRunToSkill } from "../skill.ts";
import {
  ListRunsInputSchema,
  PromoteToSkillInputSchema,
  QueryRunsInputSchema,
  RunScriptInputSchema,
  RunSkillInputSchema,
  SuggestSkillsInputSchema,
} from "./tool-schemas.ts";

import { extractSandboxState } from "../sandbox-state.ts";
import {
  loadPermissionApproval,
  savePermissionApproval,
} from "../run-store.ts";
import type { ElicitResolver, PermissionRequest } from "../broker.ts";
import type { SandboxState } from "../sandbox-state.ts";

// ============================================================
// Tool definitions — inputSchema generated from Zod (single source of truth)
// ============================================================

const RUN_SCRIPT_TOOL = {
  name: "run_script",
  description:
    'Execute a TypeScript module in a sandboxed Deno subprocess. Script format: export default async function main(input: unknown) { ... } — the default export receives the `input` object and is awaited. Optionally export `inputSchema` (Zod@4 schema) for runtime input validation. Supports `import { z } from "zod"`, Deno built-ins, and node:compat libraries (node:fs, node:path, node:os). ES module format only. Use mode: "eval" with inline code, or mode: "module" with a modulePath. Runs with --no-',
  inputSchema: RunScriptInputSchema.toJSONSchema(),
  annotations: { destructiveHint: true },
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

const QUERY_RUNS_TOOL = {
  name: "query_runs",
  description:
    `Query Aves run records and skill approvals using read-only SQL (SELECT/PRAGMA only).\n\nTable schema:\n${RUNS_TABLE_DDL}`,
  inputSchema: QueryRunsInputSchema.toJSONSchema(),
  annotations: { readOnlyHint: true },
};

// ============================================================
// Module-level server reference — set by startup functions
// ============================================================

let _mcpServer: Server | null = null;

// ============================================================
// Elicitation helpers
// ============================================================

let _elicitLock: Promise<void> = Promise.resolve();

async function withElicitLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = _elicitLock;
  let resolve: () => void;
  _elicitLock = new Promise((r) => {
    resolve = r;
  });
  await prev;
  try {
    return await fn();
  } finally {
    resolve!();
  }
}

/** Send an elicitation/create request and return the raw result. */
async function elicitRequest(msg: string): Promise<unknown> {
  const server = _mcpServer;
  if (!server) return { action: "reject" };
  return await withElicitLock(() =>
    server.request(
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
      z.object({ action: z.string() }),
    )
  );
}

/** Format a broker PermissionRequest into a user-readable elicitation message. */
function formatElicitMessage(
  req: PermissionRequest,
  _ceiling: SandboxState | null,
): string {
  const permLabel = req.permission.toUpperCase();
  return `${permLabel} permission requested:\n\n  ${req.value}\n\nApprove?`;
}

async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder();
  const data = enc.encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
function isElicitationApproved(result: unknown): boolean {
  const r = result as Record<string, unknown>;
  return r?.action === "accept";
}

async function handleRunScript(args: Record<string, unknown>, meta: unknown) {
  const result = RunRequestSchema.safeParse(args);
  if (!result.success) {
    throw new McpError(
      ErrorCode.InvalidParams,
      result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    );
  }

  // Extract Codex sandbox state (informational only — not a hard boundary)
  const sandboxState = extractSandboxState(meta);

  // Build inline elicitation handler — called by broker when a permission needs approval
  const onElicit = async (req: PermissionRequest, resolve: ElicitResolver) => {
    const msg = formatElicitMessage(req, sandboxState);
    const response = await elicitRequest(msg);
    await resolve(isElicitationApproved(response));
  };

  // Execute — broker handles permissions via the elicitation handler above
  const record = await executeRun(
    result.data,
    undefined,
    sandboxState,
    onElicit,
  );
  await saveRun(record);
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

async function handleRunSkill(args: Record<string, unknown>, meta: unknown) {
  const parsed = RunSkillInputSchema.safeParse(args);
  if (!parsed.success) {
    throw new McpError(
      ErrorCode.InvalidParams,
      parsed.error.issues.map((i) => i.message).join("; "),
    );
  }

  const { skill_path, input, permissions } = parsed.data;

  // Verify SKILL.md exists
  try {
    await Deno.stat(`${skill_path}/SKILL.md`);
  } catch {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Not a skill directory (SKILL.md not found): ${skill_path}`,
    );
  }

  // Verify mod.ts exists
  try {
    await Deno.stat(`${skill_path}/mod.ts`);
  } catch {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Skill entrypoint not found: ${skill_path}/mod.ts`,
    );
  }

  // Check permission module existence and approval
  let permApproved = false;
  try {
    await Deno.stat(`${skill_path}/mod.permission.ts`);
    const permContent = await Deno.readTextFile(
      `${skill_path}/mod.permission.ts`,
    );
    const permHash = await sha256Hex(permContent);
    const prev = await loadPermissionApproval(skill_path);
    if (prev && prev.permissionHash === permHash) {
      permApproved = true;
    } else if (prev && prev.permissionHash !== permHash) {
      const msg =
        `Permission module for skill "${skill_path}" has changed. Review:\n\n` +
        "```ts\n" +
        permContent +
        "\n```" +
        "\n\nApprove and save?";
      const result = await elicitRequest(msg);
      if (isElicitationApproved(result)) {
        await savePermissionApproval({
          skillDir: skill_path,
          permissionHash: permHash,
          approvedAt: new Date().toISOString(),
        });
        permApproved = true;
      }
    } else {
      const msg =
        `Permission module found for skill "${skill_path}". Review:\n\n` +
        "```ts\n" +
        permContent +
        "\n```" +
        "\n\nApprove and save?";
      const result = await elicitRequest(msg);
      if (isElicitationApproved(result)) {
        await savePermissionApproval({
          skillDir: skill_path,
          permissionHash: permHash,
          approvedAt: new Date().toISOString(),
        });
        permApproved = true;
      }
    }
  } catch {
    // No permission module — no additional approval needed
  }

  if (!permApproved) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: false,
            error: "Permission module not approved",
          }),
        },
      ],
    };
  }

  // Extract Codex sandbox state (informational only)
  const sandboxState = extractSandboxState(meta);

  // Build inline elicitation handler — manual approvals never create hash trust
  const onElicit = async (req: PermissionRequest, resolve: ElicitResolver) => {
    const msg = formatElicitMessage(req, sandboxState);
    const response = await elicitRequest(msg);
    await resolve(isElicitationApproved(response));
  };

  const result = await executeSkillRun(skill_path, input ?? {}, {
    permissionsOverride: permissions,
    codexCeiling: sandboxState,
    onElicit,
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

  const { min_runs } = parsed.data;
  const { queryRuns } = await import("./query-pool.ts");
  const result = await queryRuns(
    `SELECT code_hash, COUNT(*) as count
     FROM runs
     WHERE code_hash IS NOT NULL
     GROUP BY code_hash
     HAVING count >= ?
     ORDER BY count DESC`,
    [min_runs],
    10000,
  );

  if (!result.ok || !result.rows) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ suggestions: [], total_clusters: 0 }),
        },
      ],
    };
  }

  const suggestions: Record<string, unknown>[] = [];
  for (const row of result.rows) {
    suggestions.push({
      dimension: "code",
      code_hash: row.code_hash,
      run_count: row.count,
    });
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          suggestions,
          total_clusters: suggestions.length,
        }),
      },
    ],
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

  const lines = [
    `Skill \`${name}\` created.`,
    `Path: ${result.skillDir}`,
    `Files: SKILL.md, mod.ts`,
    ``,
  ];

  if (result.warnings.length > 0) {
    lines.push("Warnings:");
    for (const w of result.warnings) {
      lines.push(`- ${w}`);
    }
    lines.push("");
  }

  lines.push("Next steps:");
  lines.push("- Review and edit SKILL.md");
  lines.push("- Edit mod.ts if the entrypoint needs changes");
  lines.push("- Add examples.json for sample input/output testing");

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

async function handleQueryRuns(args?: Record<string, unknown>) {
  const parsed = args ? QueryRunsInputSchema.safeParse(args) : null;
  if (!parsed?.success) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "query_runs requires valid params",
    );
  }

  // Enforce SELECT/PRAGMA only (defense-in-depth beyond readOnly: true)
  const sql = parsed.data.sql.trim();
  const isSelect = /^SELECT\b/i.test(sql);
  const isPragma = /^PRAGMA\b/i.test(sql);
  if (!isSelect && !isPragma) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "query_runs only allows SELECT and PRAGMA statements",
    );
  }

  // Execute via pooled Worker
  const { queryRuns } = await import("./query-pool.ts");
  const result = await queryRuns(
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
    {
      capabilities: {
        tools: {},
        resources: {},
        experimental: { "codex/sandbox-state-meta": {} },
      },
    },
  );

  // Make the server instance available to handlers
  _mcpServer = mcpServer;

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: crypto.randomUUID.bind(crypto),
  });

  mcpServer.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      RUN_SCRIPT_TOOL,
      LIST_RUNS_TOOL,
      RUN_SKILL_TOOL,
      SUGGEST_SKILLS_TOOL,
      PROMOTE_TO_SKILL_TOOL,
      LIST_SKILLS_TOOL,
      QUERY_RUNS_TOOL,
    ],
  }));

  mcpServer.setRequestHandler(
    CallToolRequestSchema,
    async (request: CallToolRequest) => {
      const { name, arguments: args } = request.params;
      switch (name) {
        case "run_script": {
          const meta = (request.params as Record<string, unknown>)?._meta;
          return await handleRunScript(args ?? {}, meta);
        }
        case "list_runs":
          return await handleListRuns();
        case "run_skill": {
          const meta = (request.params as Record<string, unknown>)?._meta;
          return await handleRunSkill(args ?? {}, meta);
        }
        case "suggest_skills":
          return await handleSuggestSkills(args ?? {});
        case "promote_to_skill":
          return await handlePromoteToSkill(args ?? {});
        case "list_skills":
          return await handleListSkills();
        case "query_runs":
          return await handleQueryRuns(args ?? {});
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    },
  );

  mcpServer.setRequestHandler(ListPromptsRequestSchema, () => ({
    prompts: [
      {
        name: AVES_PROMPT_NAME,
        description: AVES_PROMPT_DESCRIPTION,
        arguments: [],
      },
    ],
  }));

  mcpServer.setRequestHandler(
    GetPromptRequestSchema,
    async (req: { params: { name: string } }) => {
      if (req.params.name === AVES_PROMPT_NAME) {
        return {
          messages: [
            {
              role: "user",
              content: { type: "text", text: await buildAvesPrompt() },
            },
          ],
        };
      }
      throw new McpError(
        ErrorCode.InvalidParams,
        `Unknown prompt: ${req.params.name}`,
      );
    },
  );

  mcpServer.setRequestHandler(ListResourcesRequestSchema, handleListResources);
  mcpServer.setRequestHandler(
    ListResourceTemplatesRequestSchema,
    handleListResourceTemplates,
  );
  mcpServer.setRequestHandler(
    ReadResourceRequestSchema,
    (req: { params: { uri: string } }) => handleReadResource(req.params.uri),
  );

  await mcpServer.connect(transport);

  const controller = new AbortController();
  const { promise: portPromise, resolve: resolvePort } = Promise.withResolvers<
    number
  >();
  Deno.serve(
    {
      port: 0,
      hostname: host,
      signal: controller.signal,
      onListen: ({ port: actualPort }) => {
        console.error(
          `Aves MCP HTTP server listening on ${host}:${actualPort}`,
        );
        resolvePort(actualPort);
      },
    },
    (req: Request) => {
      return transport.handleRequest(req);
    },
  );

  return { port: await portPromise };
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
        resources: {},
        experimental: { "codex/sandbox-state-meta": {} },
      },
    },
  );

  // Make the server instance available to handlers
  _mcpServer = server;

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      RUN_SCRIPT_TOOL,
      LIST_RUNS_TOOL,
      RUN_SKILL_TOOL,
      SUGGEST_SKILLS_TOOL,
      PROMOTE_TO_SKILL_TOOL,
      LIST_SKILLS_TOOL,
      QUERY_RUNS_TOOL,
    ],
  }));

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request: CallToolRequest) => {
      const { name, arguments: args } = request.params;

      switch (name) {
        case "run_script": {
          const meta = (request.params as Record<string, unknown>)?._meta;
          return await handleRunScript(args ?? {}, meta);
        }
        case "list_runs":
          return await handleListRuns();
        case "run_skill": {
          const meta = (request.params as Record<string, unknown>)?._meta;
          return await handleRunSkill(args ?? {}, meta);
        }
        case "suggest_skills":
          return await handleSuggestSkills(args ?? {});
        case "promote_to_skill":
          return await handlePromoteToSkill(args ?? {});
        case "list_skills":
          return await handleListSkills();
        case "query_runs":
          return await handleQueryRuns(args ?? {});
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    },
  );

  const transport = new StdioServerTransport();
  server.setRequestHandler(ListPromptsRequestSchema, () => ({
    prompts: [
      {
        name: AVES_PROMPT_NAME,
        description: AVES_PROMPT_DESCRIPTION,
        arguments: [],
      },
    ],
  }));

  server.setRequestHandler(
    GetPromptRequestSchema,
    async (req: { params: { name: string } }) => {
      if (req.params.name === AVES_PROMPT_NAME) {
        return {
          messages: [
            {
              role: "user",
              content: { type: "text", text: await buildAvesPrompt() },
            },
          ],
        };
      }
      throw new McpError(
        ErrorCode.InvalidParams,
        `Unknown prompt: ${req.params.name}`,
      );
    },
  );

  server.setRequestHandler(ListResourcesRequestSchema, handleListResources);
  server.setRequestHandler(
    ListResourceTemplatesRequestSchema,
    handleListResourceTemplates,
  );
  server.setRequestHandler(
    ReadResourceRequestSchema,
    (req: { params: { uri: string } }) => handleReadResource(req.params.uri),
  );

  await server.connect(transport);
  console.error("Aves MCP server started on stdio");
}
