import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  type CallToolRequest,
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
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
  handleListResources,
  handleListResourceTemplates,
  handleReadResource,
} from "./resources.ts";
import { RUNS_TABLE_DDL } from "../db-schema.ts";
import {
  approveSkill,
  checkSkillApproval,
  listSkills,
  loadSkillManifest,
  promoteRunToSkill,
} from "../skill.ts";
import {
  ListRunsInputSchema,
  PromoteToSkillInputSchema,
  QueryRunsInputSchema,
  ReplayRunInputSchema,
  RunScriptInputSchema,
  RunSkillInputSchema,
  SuggestSkillsInputSchema,
} from "./tool-schemas.ts";

import { extractSandboxState } from "../sandbox-state.ts";
import {
  applyCodexCeiling,
  isReadOnly,
  isWithinCodexCeiling,
} from "../policy.ts";
import { getConfig } from "../config.ts";
import { loadScriptApproval, saveScriptApproval } from "../run-store.ts";

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

/** Hash a string using SHA-256, return hex. */
async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder();
  const data = enc.encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Check if two permission objects match (same keys, same values). */
function permissionsMatch(
  a: Record<string, string[] | undefined>,
  b: Record<string, string[] | undefined>,
): boolean {
  const allKeys = ["read", "write", "net", "env"] as const;
  for (const k of allKeys) {
    const aa = (a[k] ?? []).slice().sort();
    const bb = (b[k] ?? []).slice().sort();
    if (aa.length !== bb.length) return false;
    if (!aa.every((v, i) => v === bb[i])) return false;
  }
  return true;
}

/** Send an elicitation/create request and return the raw result. */
async function elicitRequest(msg: string): Promise<unknown> {
  const server = _mcpServer;
  if (!server) return { action: "reject" };
  return await server.request(
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
}

async function elicitScriptApproval(
  mode: string,
  granted: Record<string, string[] | undefined>,
  dropped: Record<string, string[] | undefined>,
  codeHash: string | null,
): Promise<boolean> {
  const withinCeiling = isWithinCodexCeiling(dropped);

  // --- C=N: paths exceed Codex ceiling ---
  if (!withinCeiling) {
    const parts: string[] = [];

    if (dropped.read?.length) {
      parts.push(
        `Read paths outside Codex sandbox:\n${
          permsDesc({ read: dropped.read })
        }`,
      );
    }
    if (dropped.net?.length) {
      parts.push(
        `Network targets outside Codex sandbox:\n${
          permsDesc({ net: dropped.net })
        }`,
      );
    }
    if (dropped.write?.length) {
      parts.push(
        `Write paths DENIED (write cannot exceed Codex sandbox):\n${
          permsDesc({ write: dropped.write })
        }`,
      );
    }

    if (parts.length === 0) return false;

    const hasGrantable = (granted.read?.length ?? 0) > 0 ||
      (granted.net?.length ?? 0) > 0;
    const modeLabel = mode === "eval" ? "Eval" : "Module";
    const preamble = hasGrantable
      ? `Some ${modeLabel} script permissions exceed the Codex sandbox:\n\n`
      : `${modeLabel} script cannot run — no permissions within Codex sandbox.`;
    const msg = `${preamble}${parts.join("\n\n")}${
      hasGrantable ? "\n\nApprove with restricted permissions?" : ""
    }`;

    const result = await elicitRequest(msg);
    return isElicitationApproved(result);
  }

  // --- C=Y: all within ceiling ---

  // Read-only + config auto-approve → silent
  if (isReadOnly(granted)) {
    try {
      const config = await getConfig();
      if (config.execution.autoApproveReadonly) {
        return true;
      }
    } catch { /* config unreadable, fall through */ }
  }

  // Has write or net → check hash trust
  const hasWrite = (granted.write?.length ?? 0) > 0;
  const hasNet = (granted.net?.length ?? 0) > 0;

  if (hasWrite || hasNet) {
    if (codeHash) {
      try {
        const prev = await loadScriptApproval(codeHash);
        if (prev) {
          if (permissionsMatch(granted, prev.permissions)) {
            return true; // Hash + permissions match → silent
          }
          // Permissions changed
          const msg = [
            `Script permissions changed since last approval.`,
            ``,
            `Previously approved:`,
            permsDesc(prev.permissions),
            ``,
            `Now requested:`,
            permsDesc(granted),
            ``,
            `Approve?`,
          ].join("\n");
          const result = await elicitRequest(msg);
          return isElicitationApproved(result);
        }
      } catch { /* DB error, fall through to first-run path */ }
    }

    // First run with write/net → elicit
    const modeLabel = mode === "eval" ? "Eval" : "Module";
    const msg =
      `Approve ${modeLabel} script execution?\n\nRequested permissions:\n${
        permsDesc(granted)
      }`;
    const result = await elicitRequest(msg);
    return isElicitationApproved(result);
  }

  // Read-only, config didn't allow silent → normal elicit (compat)
  const modeLabel = mode === "eval" ? "Eval" : "Module";
  const hasPerms = Object.values(granted).some((v) => v && v.length > 0);
  if (!hasPerms) return true;
  const msg =
    `Approve ${modeLabel} script execution?\n\nRequested permissions:\n${
      permsDesc(granted)
    }`;
  const result = await elicitRequest(msg);
  return isElicitationApproved(result);
}

async function handleRunScript(args: Record<string, unknown>, meta: unknown) {
  const result = RunRequestSchema.safeParse(args);
  if (!result.success) {
    throw new McpError(
      ErrorCode.InvalidParams,
      result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }

  // Extract Codex sandbox state from MCP _meta
  const sandboxState = extractSandboxState(meta);

  // Apply Codex ceiling to requested permissions
  const { granted, dropped } = applyCodexCeiling(
    result.data.permissions ?? {},
    sandboxState,
  );

  // Compute code hash for trust tracking
  let codeHash: string | null = null;
  if (result.data.mode === "eval" && result.data.code) {
    codeHash = await sha256Hex(result.data.code);
  }

  // Approval (truth table)
  if (
    !await elicitScriptApproval(result.data.mode, granted, dropped, codeHash)
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

  // Save approval for future silent runs (only if we have a hash)
  if (codeHash) {
    try {
      await saveScriptApproval({
        codeHash,
        approvedAt: new Date().toISOString(),
        permissions: granted,
      });
    } catch { /* best-effort */ }
  }

  // Execute with ceiling-granted permissions
  const modifiedRequest = { ...result.data, permissions: granted };
  const record = await executeRun(modifiedRequest);
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

async function handleRunSkill(args: Record<string, unknown>, meta: unknown) {
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

  // Approved — apply Codex ceiling and execute
  const sandboxState = extractSandboxState(meta);

  // Compute effective permissions (manifest ∩ override, same as executeSkillRun does)
  const effectivePerms: Record<string, string[] | undefined> = {};
  const manifestResult = await loadSkillManifest(skill_path);
  if (manifestResult.ok) {
    const manifest = manifestResult.manifest;
    const override = permissions ?? {};
    for (const key of ["read", "write", "net", "env"] as const) {
      const base = manifest.permissions[key] ?? [];
      const over = override[key] ?? [];
      if (over.length > 0) {
        const shrunk = base.filter((p) => over.includes(p));
        if (shrunk.length > 0) effectivePerms[key] = shrunk;
      } else if (base.length > 0) {
        effectivePerms[key] = base;
      }
    }
  }

  // Apply ceiling on top of effective permissions
  const { granted: ceilingGranted, dropped: ceilingDropped } =
    applyCodexCeiling(
      effectivePerms,
      sandboxState,
    );

  // If ceiling dropped permissions, elicit
  if (!isWithinCodexCeiling(ceilingDropped)) {
    const parts: string[] = [];
    if (ceilingDropped.read?.length) {
      parts.push(
        `Read paths outside Codex sandbox:\n${
          permsDesc({ read: ceilingDropped.read })
        }`,
      );
    }
    if (ceilingDropped.net?.length) {
      parts.push(
        `Network targets outside Codex sandbox:\n${
          permsDesc({ net: ceilingDropped.net })
        }`,
      );
    }
    if (ceilingDropped.write?.length) {
      parts.push(
        `Write paths DENIED (write cannot exceed Codex sandbox):\n${
          permsDesc({ write: ceilingDropped.write })
        }`,
      );
    }

    if (parts.length > 0) {
      const msg = `Skill "${skill_path}" permissions exceed Codex sandbox:\n\n${
        parts.join("\n\n")
      }\n\nApprove with restricted permissions?`;
      const elicitResult = await elicitRequest(msg);
      if (!isElicitationApproved(elicitResult)) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: false,
              error: "Skill execution rejected: Codex ceiling not accepted",
            }),
          }],
        };
      }
    }
  }

  // Merge ceilingGranted as shrink override for executeSkillRun
  const ceilingOverride: Record<string, string[]> = {};
  for (const key of ["read", "write", "net", "env"] as const) {
    const vals = ceilingGranted[key];
    if (vals && vals.length > 0) ceilingOverride[key] = vals;
  }

  const result = await executeSkillRun(skill_path, input ?? {}, {
    permissionsOverride: Object.keys(ceilingOverride).length > 0
      ? ceilingOverride
      : permissions,
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
      REPLAY_RUN_TOOL,
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
        case "replay_run":
          return await handleReplayRun(args ?? {});
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
      REPLAY_RUN_TOOL,
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
        case "replay_run":
          return await handleReplayRun(args ?? {});
        case "list_runs":
          return await handleListRuns(args ?? {});
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
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${name}`,
          );
      }
    },
  );

  const transport = new StdioServerTransport();
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
