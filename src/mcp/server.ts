import { RUNS_TABLE_DDL } from "../db-schema.ts";
import {
  listRuns,
  listRunsFiltered,
  loadPermissionApproval,
  loadRun,
  savePermissionApproval,
  saveRun,
} from "../run-store.ts";
import { executeRun, executeSkillRun } from "../runner.ts";
import { RunRequestSchema } from "../schemas.ts";
import { listSkills, promoteRunToSkill } from "../skill.ts";
import {
  AVES_PROMPT_DESCRIPTION,
  AVES_PROMPT_NAME,
  buildAvesPrompt,
} from "./prompt-handlers.ts";
import {
  handleListResources,
  handleListResourceTemplates,
  handleReadResource,
} from "./resources.ts";
import {
  ListRunsInputSchema,
  PromoteToSkillInputSchema,
  QueryRunsInputSchema,
  ReplCloseInputSchema,
  ReplCreateInputSchema,
  ReplEvalInputSchema,
  RunScriptInputSchema,
  RunSkillInputSchema,
  SuggestSkillsInputSchema,
} from "./tool-schemas.ts";

import {
  type CallToolResult,
  type ElicitResult,
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  type ServerContext,
  StdioServerTransport,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { replManager } from "../host/manager.ts";

import type { ElicitResolver, PermissionRequest } from "../broker.ts";
import type { SandboxState } from "../sandbox-state.ts";
import { extractSandboxState } from "../sandbox-state.ts";

// ============================================================
// Module-level server reference — set by startup functions
// ============================================================

let _mcpServer: McpServer | null = null;

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

/** Send an elicitation request and return the raw result. */
async function elicitRequest(msg: string): Promise<ElicitResult> {
  const mcpServer = _mcpServer;
  if (!mcpServer) return { action: "decline" };
  return await withElicitLock(() =>
    mcpServer.server.elicitInput({
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
    })
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

async function handleRunScript(
  args: unknown,
  ctx: ServerContext,
): Promise<CallToolResult> {
  const result = RunRequestSchema.safeParse(args);
  if (!result.success) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    );
  }

  // Extract Codex sandbox state (informational only — not a hard boundary)
  const sandboxState = extractSandboxState(ctx.mcpReq._meta);

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
  return {
    content: [{ type: "text" as const, text: JSON.stringify(record, null, 2) }],
  };
}

async function handleListRuns(
  args?: Record<string, unknown>,
): Promise<CallToolResult> {
  const parsed = args ? ListRunsInputSchema.safeParse(args) : null;
  const records = parsed?.success
    ? await listRunsFiltered(parsed.data)
    : await listRuns();
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify(records, null, 2),
    }],
  };
}

async function handleRunSkill(
  args: unknown,
  ctx: ServerContext,
): Promise<CallToolResult> {
  const parsed = RunSkillInputSchema.safeParse(args);
  if (!parsed.success) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      parsed.error.issues.map((i) => i.message).join("; "),
    );
  }

  const { skill_path, input, permissions } = parsed.data;

  // Verify SKILL.md exists
  try {
    await Deno.stat(`${skill_path}/SKILL.md`);
  } catch {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `Not a skill directory (SKILL.md not found): ${skill_path}`,
    );
  }

  // Verify mod.ts exists
  try {
    await Deno.stat(`${skill_path}/mod.ts`);
  } catch {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
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
          type: "text" as const,
          text: JSON.stringify({
            ok: false,
            error: "Permission module not approved",
          }),
        },
      ],
    };
  }

  // Extract Codex sandbox state (informational only)
  const sandboxState = extractSandboxState(ctx.mcpReq._meta);

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
    throw new ProtocolError(
      ProtocolErrorCode.InternalError,
      "Skill execution failed: no record returned",
    );
  }

  await saveRun(result.record);
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify(result.record, null, 2),
    }],
  };
}

async function handleSuggestSkills(
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const parsed = SuggestSkillsInputSchema.safeParse(args);
  if (!parsed.success) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
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
          type: "text" as const,
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
        type: "text" as const,
        text: JSON.stringify({
          suggestions,
          total_clusters: suggestions.length,
        }),
      },
    ],
  };
}

async function handlePromoteToSkill(
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const parsed = PromoteToSkillInputSchema.safeParse(args);
  if (!parsed.success) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      parsed.error.issues.map((i) => i.message).join("; "),
    );
  }

  const { run_id, name, description } = parsed.data;
  const run = await loadRun(run_id);
  if (!run) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `Run not found: ${run_id}`,
    );
  }

  const result = await promoteRunToSkill(run, name, description);
  if (!result.ok) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, result.error);
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

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

async function handleQueryRuns(
  args?: Record<string, unknown>,
): Promise<CallToolResult> {
  const parsed = args ? QueryRunsInputSchema.safeParse(args) : null;
  if (!parsed?.success) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      "query_runs requires valid params",
    );
  }

  // Enforce SELECT/PRAGMA only (defense-in-depth beyond readOnly: true)
  const sql = parsed.data.sql.trim();
  const isSelect = /^SELECT\b/i.test(sql);
  const isPragma = /^PRAGMA\b/i.test(sql);
  if (!isSelect && !isPragma) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
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
    throw new ProtocolError(
      ProtocolErrorCode.InternalError,
      result.error ?? "Query failed",
    );
  }

  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify(result.rows, null, 2),
    }],
  };
}

async function handleListSkills(): Promise<CallToolResult> {
  const skills = await listSkills();
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({ skills }, null, 2),
    }],
  };
}

/** Register all tools on a McpServer instance. */

async function handleReplCreate(
  args: unknown,
  ctx: ServerContext,
): Promise<CallToolResult> {
  const parsed = ReplCreateInputSchema.safeParse(args);
  if (!parsed.success) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      "repl_create: invalid params",
    );
  }
  const sandboxState = extractSandboxState(ctx.mcpReq._meta);

  // Build inline elicitation handler for permission requests
  const onElicit = async (req: PermissionRequest, resolve: ElicitResolver) => {
    const msg = formatElicitMessage(req, sandboxState);
    const response = await elicitRequest(msg);
    await resolve(isElicitationApproved(response));
  };

  const { cwd, permissions, timeout_ms, description } = parsed.data;
  const info = await replManager.create({
    cwd,
    permissions,
    description,
    codexCeiling: sandboxState,
    timeoutMs: timeout_ms,
    onElicit,
  });
  return {
    content: [{ type: "text" as const, text: JSON.stringify(info, null, 2) }],
  };
}

async function handleReplEval(
  args?: Record<string, unknown>,
): Promise<CallToolResult> {
  const parsed = args ? ReplEvalInputSchema.safeParse(args) : null;
  if (!parsed?.success) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      "repl_eval requires valid params",
    );
  }
  const result = await replManager.eval(
    parsed.data.session_id,
    parsed.data.code,
    parsed.data.timeout_ms,
  );
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}

async function handleReplClose(
  args?: Record<string, unknown>,
): Promise<CallToolResult> {
  const parsed = args ? ReplCloseInputSchema.safeParse(args) : null;
  if (!parsed?.success) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      "repl_close requires valid params",
    );
  }
  const closed = await replManager.close(parsed.data.session_id);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ closed }) }],
  };
}

function registerTools(mcpServer: McpServer): void {
  mcpServer.registerTool(
    "repl_create",
    {
      description:
        "Create a persistent REPL session for interactive TypeScript evaluation. Returns a session_id for use with repl_eval and repl_close. Sessions maintain variable state across evaluations. Supports optional permissions and sandbox ceiling.",
      inputSchema: ReplCreateInputSchema,
      annotations: { destructiveHint: true },
    },
    (args, ctx) => handleReplCreate(args, ctx),
  );

  mcpServer.registerTool(
    "repl_eval",
    {
      description:
        "Evaluate TypeScript code in a persistent REPL session. Supports top-level await, ES module imports (including npm: specifiers), const re-binding, and retains state across calls. Use repl_create to get a session ID first.",
      inputSchema: ReplEvalInputSchema,
      annotations: { destructiveHint: true },
    },
    (args, _ctx) => handleReplEval(args),
  );

  mcpServer.registerTool(
    "repl_close",
    {
      description:
        "Close a REPL session and free its resources. Any pending evaluations will be aborted.",
      inputSchema: ReplCloseInputSchema,
      annotations: { destructiveHint: true },
    },
    (args, _ctx) => handleReplClose(args),
  );

  mcpServer.registerTool(
    "run_script",
    {
      description:
        'Execute a TypeScript module in a sandboxed Deno subprocess. Script format: export default async function main(input: unknown) { ... } — the default export receives the `input` object and is awaited. Optionally export `inputSchema` (Zod@4 schema) for runtime input validation. Supports `import { z } from "zod"`, `jsr:@scope/pkg@version`, `npm:pkg`, Deno built-ins, and node:compat (node:fs, node:path, node:os). ES module format only. Use mode: "eval" with inline code, or mode: "module" with a modulePath. Runs with --no-',
      inputSchema: RunScriptInputSchema,
      annotations: { destructiveHint: true },
    },
    (args, ctx) => handleRunScript(args, ctx),
  );

  mcpServer.registerTool(
    "list_runs",
    {
      description: "List recent run records",
      inputSchema: ListRunsInputSchema,
      annotations: { readOnlyHint: true },
    },
    (args, _ctx) => handleListRuns(args),
  );

  mcpServer.registerTool(
    "run_skill",
    {
      description: "Execute a skill by its directory path",
      inputSchema: RunSkillInputSchema,
      annotations: { destructiveHint: true },
    },
    (args, ctx) => handleRunSkill(args, ctx),
  );

  mcpServer.registerTool(
    "suggest_skills",
    {
      description: "Find run clusters that look like skill candidates",
      inputSchema: SuggestSkillsInputSchema,
      annotations: { readOnlyHint: true },
    },
    (args, _ctx) => handleSuggestSkills(args ?? {}),
  );

  mcpServer.registerTool(
    "promote_to_skill",
    {
      description: "Promote a run to a skill, writing to disk",
      inputSchema: PromoteToSkillInputSchema,
      annotations: { destructiveHint: true },
    },
    (args, _ctx) => handlePromoteToSkill(args ?? {}),
  );

  mcpServer.registerTool(
    "list_skills",
    {
      description: "List all discovered skills in configured roots",
      annotations: { readOnlyHint: true },
    },
    (_ctx: ServerContext) => handleListSkills(),
  );

  mcpServer.registerTool(
    "query_runs",
    {
      description:
        `Query Aves run records and skill approvals using read-only SQL (SELECT/PRAGMA only).\n\nTable schema:\n${RUNS_TABLE_DDL}`,
      inputSchema: QueryRunsInputSchema,
      annotations: { readOnlyHint: true },
    },
    (args, _ctx) => handleQueryRuns(args),
  );
}

/** Register the prompt on a McpServer instance. */
function registerPrompts(mcpServer: McpServer): void {
  mcpServer.registerPrompt(
    AVES_PROMPT_NAME,
    { description: AVES_PROMPT_DESCRIPTION },
    async () => ({
      messages: [
        {
          role: "user",
          content: { type: "text" as const, text: await buildAvesPrompt() },
        },
      ],
    }),
  );
}

/** Register resource handlers on a McpServer instance (via low-level Server). */
function registerResources(mcpServer: McpServer): void {
  mcpServer.server.setRequestHandler("resources/list", handleListResources);
  mcpServer.server.setRequestHandler(
    "resources/templates/list",
    handleListResourceTemplates,
  );
  mcpServer.server.setRequestHandler(
    "resources/read",
    (req: { params: { uri: string } }) => handleReadResource(req.params.uri),
  );
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
  const mcpServer = new McpServer(
    { name: "aves-mcp", version: "0.1.0" },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
        experimental: { "codex/sandbox-state-meta": {} },
      },
    },
  );

  // Make the server instance available to handlers
  _mcpServer = mcpServer;

  registerTools(mcpServer);
  registerPrompts(mcpServer);
  registerResources(mcpServer);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: crypto.randomUUID.bind(crypto),
  });

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
  const mcpServer = new McpServer(
    {
      name: "aves-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
        experimental: { "codex/sandbox-state-meta": {} },
      },
    },
  );

  // Make the server instance available to handlers
  _mcpServer = mcpServer;

  registerTools(mcpServer);
  registerPrompts(mcpServer);
  registerResources(mcpServer);

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  console.error("Aves MCP server started on stdio");
}
