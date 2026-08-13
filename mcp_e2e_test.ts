import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "@std/assert";
import { Client, StdioClientTransport } from "@modelcontextprotocol/client";

type CallToolResult = Awaited<ReturnType<Client["callTool"]>>;

interface E2eContext {
  root: string;
  dataDir: string;
  configDir: string;
  stateDir: string;
  homeDir: string;
  replWorkspace: string;
  skillDir: string;
  realReplWorkspace: string;
  client: Client;
  transport: StdioClientTransport;
  serverPid: number | null;
  stderr: string[];
  stage: string;
  cleanup: boolean;
}

function textContent(result: CallToolResult): string {
  const item = result.content.find((content) => content.type === "text");
  assertExists(item, "tool result should include text content");
  return item.text;
}

function parseToolJson<T>(result: CallToolResult): T {
  return JSON.parse(textContent(result)) as T;
}

function stderrTail(ctx: E2eContext, lineCount = 80): string {
  return ctx.stderr.slice(-lineCount).join("").trimEnd();
}

function withContextMessage(ctx: E2eContext, message: string): Error {
  const tail = stderrTail(ctx);
  return new Error(
    [
      message,
      `stage: ${ctx.stage}`,
      `temp dir: ${ctx.root}`,
      tail ? `server stderr tail:\n${tail}` : "server stderr tail: <empty>",
    ].join("\n\n"),
  );
}

function setStage(ctx: E2eContext, stage: string): void {
  ctx.stage = stage;
}

async function createE2eContext(): Promise<E2eContext> {
  const root = await Deno.makeTempDir({ prefix: "aves-mcp-e2e-" });
  const dataDir = `${root}/data`;
  const configDir = `${root}/config`;
  const stateDir = `${root}/state`;
  const homeDir = `${root}/home`;
  const replWorkspace = `${root}/repl-workspace`;
  const skillRoot = `${root}/skills`;
  const skillDir = `${skillRoot}/e2e-skill`;

  await Deno.mkdir(configDir, { recursive: true });
  await Deno.mkdir(homeDir, { recursive: true });
  await Deno.mkdir(replWorkspace, { recursive: true });
  await Deno.mkdir(skillDir, { recursive: true });
  const realReplWorkspace = await Deno.realPath(replWorkspace);
  await Deno.writeTextFile(
    `${configDir}/config.toml`,
    [
      `skill_roots = ["${skillRoot}"]`,
      "",
      "[execution]",
      "auto_approve_readonly = false",
      "",
    ].join("\n"),
  );

  const stderr: string[] = [];
  const transport = new StdioClientTransport({
    command: Deno.execPath(),
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-run",
      "--allow-sys",
      // The server child starts the permission broker, whose unix-socket
      // listener requires net permission (Deno classifies Deno.listen with
      // transport:"unix" under --allow-net).
      "--allow-net",
      "--unstable-worker-options",
      "--unstable-raw-imports",
      "main.ts",
      "stdio",
    ],
    cwd: Deno.cwd(),
    env: {
      AVES_DATA_DIR: dataDir,
      AVES_CONFIG_DIR: configDir,
      AVES_STATE_DIR: stateDir,
      HOME: homeDir,
      NO_COLOR: "1",
    },
    stderr: "pipe",
  });

  transport.stderr?.on("data", (chunk: Uint8Array | string) => {
    stderr.push(
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
    );
  });

  const client = new Client(
    { name: "aves-e2e-test", version: "0.0.0" },
    { capabilities: { elicitation: {} } },
  );
  client.setRequestHandler("elicitation/create", () => ({
    action: "accept",
    content: { approved: true },
  }));

  const ctx: E2eContext = {
    root,
    dataDir,
    configDir,
    stateDir,
    homeDir,
    replWorkspace,
    skillDir,
    realReplWorkspace,
    client,
    transport,
    serverPid: null,
    stderr,
    stage: "setup",
    cleanup: false,
  };

  return ctx;
}

async function connectE2e(ctx: E2eContext): Promise<void> {
  setStage(ctx, "connect");
  await ctx.client.connect(ctx.transport, { timeout: 15000 });
  ctx.serverPid = ctx.transport.pid;
}

async function teardownE2e(ctx: E2eContext): Promise<void> {
  try {
    await ctx.client.close();
    await assertServerExited(ctx);
    await drainStdioCloseTimer();
  } catch (err) {
    ctx.cleanup = false;
    throw err;
  } finally {
    if (ctx.cleanup) {
      await Deno.remove(ctx.root, { recursive: true });
    } else {
      console.error(
        [
          "Aves MCP e2e test preserved temp directory after failure.",
          `stage: ${ctx.stage}`,
          `temp dir: ${ctx.root}`,
          stderrTail(ctx) ? `server stderr tail:\n${stderrTail(ctx)}` : "",
        ].filter(Boolean).join("\n\n"),
      );
    }
  }
}

async function assertServerExited(ctx: E2eContext): Promise<void> {
  if (ctx.serverPid == null) return;
  const exited = await waitForProcessExit(ctx.serverPid, 2000);
  if (!exited) {
    throw withContextMessage(
      ctx,
      `stdio server process did not exit: pid ${ctx.serverPid}`,
    );
  }
}

async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await processExists(pid))) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function processExists(pid: number): Promise<boolean> {
  const result = await new Deno.Command("kill", {
    args: ["-0", String(pid)],
    stdout: "null",
    stderr: "null",
  }).output();
  return result.success;
}

async function drainStdioCloseTimer(): Promise<void> {
  // The MCP SDK's stdio transport leaves an unref'ed loser timer behind its
  // close() Promise.race when the child exits promptly. Let it drain so Deno's
  // test sanitizer still verifies this e2e without a false timer leak.
  await new Promise((resolve) => setTimeout(resolve, 2100));
}

Deno.test(
  "mcp e2e: stdio lifecycle, tools, skills, runs, and repl sessions",
  async () => {
    const ctx = await createE2eContext();
    try {
      await connectE2e(ctx);

      setStage(ctx, "ping");
      await ctx.client.ping({ timeout: 10000 });

      setStage(ctx, "tools/list");
      const { tools } = await ctx.client.listTools(undefined, {
        timeout: 10000,
      });
      const toolNames = new Set(tools.map((tool) => tool.name));
      for (
        const name of [
          "run_script",
          "run_skill",
          "list_runs",
          "query_runs",
          "repl_create",
          "repl_eval",
          "repl_close",
          "list_skills",
        ]
      ) {
        assert(toolNames.has(name), `missing tool: ${name}`);
      }

      setStage(ctx, "resources");
      const resources = await ctx.client.listResources(undefined, {
        timeout: 10000,
      });
      assert(
        resources.resources.some((resource) =>
          resource.uri === "aves://schema/runs"
        ),
        "resources/list should expose aves://schema/runs",
      );
      const schema = await ctx.client.readResource(
        { uri: "aves://schema/runs" },
        { timeout: 10000 },
      );
      const schemaText = schema.contents.find((item) => "text" in item)?.text ??
        "";
      assertStringIncludes(schemaText, "CREATE TABLE IF NOT EXISTS runs");
      const templates = await ctx.client.listResourceTemplates(undefined, {
        timeout: 10000,
      });
      assert(
        templates.resourceTemplates.some((template) =>
          template.uriTemplate === "aves://runs/{run_id}"
        ),
        "resources/templates/list should expose aves://runs/{run_id}",
      );

      setStage(ctx, "run_script success");
      const runScriptOne = parseToolJson<Record<string, unknown>>(
        await ctx.client.callTool(
          {
            name: "run_script",
            arguments: {
              mode: "eval",
              code:
                "export default async function main() { return { ok: true, value: 7 }; }",
              permissions: {},
            },
          },
          { timeout: 30000 },
        ),
      );
      assertEquals(runScriptOne.exit_code, 0);
      assertEquals(runScriptOne.mode, "eval");
      assertEquals(runScriptOne.output, { ok: true, value: 7 });

      setStage(ctx, "run_script input");
      const runScriptTwo = parseToolJson<Record<string, unknown>>(
        await ctx.client.callTool(
          {
            name: "run_script",
            arguments: {
              mode: "eval",
              code: [
                "export default async function main(input: { count: number }) {",
                "  return { doubled: input.count * 2 };",
                "}",
              ].join("\n"),
              input: { count: 21 },
              permissions: {},
            },
          },
          { timeout: 30000 },
        ),
      );
      assertEquals(runScriptTwo.exit_code, 0);
      assertEquals(runScriptTwo.output, { doubled: 42 });

      setStage(ctx, "run_script module");
      const modulePath = `${ctx.root}/module_script.ts`;
      await Deno.writeTextFile(
        modulePath,
        [
          "export default async function main(input: { base: number }) {",
          "  return { mode: 'module', value: input.base + 4 };",
          "}",
          "",
        ].join("\n"),
      );
      const runScriptModule = parseToolJson<Record<string, unknown>>(
        await ctx.client.callTool(
          {
            name: "run_script",
            arguments: {
              mode: "module",
              modulePath,
              input: { base: 38 },
              permissions: {},
            },
          },
          { timeout: 30000 },
        ),
      );
      assertEquals(runScriptModule.exit_code, 0);
      assertEquals(runScriptModule.mode, "module");
      assertEquals(runScriptModule.output, { mode: "module", value: 42 });

      setStage(ctx, "run_script failure");
      const runScriptThree = parseToolJson<Record<string, unknown>>(
        await ctx.client.callTool(
          {
            name: "run_script",
            arguments: {
              mode: "eval",
              code:
                'export default async function main() { throw new Error("script boom"); }',
              permissions: {},
            },
          },
          { timeout: 30000 },
        ),
      );
      assertEquals(runScriptThree.exit_code, 1);
      assertStringIncludes(String(runScriptThree.error), "script boom");

      setStage(ctx, "runs listing");
      const runs = parseToolJson<Array<Record<string, unknown>>>(
        await ctx.client.callTool(
          {
            name: "list_runs",
            arguments: { limit: 20, order_by: "started_at", order_dir: "desc" },
          },
          { timeout: 15000 },
        ),
      );
      assert(
        runs.some((run) => run.run_id === runScriptOne.run_id),
        "list_runs should include first run_script record",
      );
      assert(
        runs.some((run) =>
          run.run_id === runScriptThree.run_id && run.exit_code === 1
        ),
        "list_runs should include failed run_script record",
      );
      const filteredEvalRuns = parseToolJson<Array<Record<string, unknown>>>(
        await ctx.client.callTool(
          {
            name: "list_runs",
            arguments: { mode: "eval", exit_code: 0, limit: 5 },
          },
          { timeout: 15000 },
        ),
      );
      assert(
        filteredEvalRuns.length > 0,
        "list_runs filter should return rows",
      );
      assert(
        filteredEvalRuns.every((run) =>
          run.mode === "eval" && run.exit_code === 0
        ),
        "list_runs filter should constrain mode and exit_code",
      );

      setStage(ctx, "query_runs");
      const groupedRuns = parseToolJson<Array<Record<string, unknown>>>(
        await ctx.client.callTool(
          {
            name: "query_runs",
            arguments: {
              sql:
                "SELECT mode, exit_code, COUNT(*) as count FROM runs GROUP BY mode, exit_code ORDER BY mode, exit_code",
            },
          },
          { timeout: 15000 },
        ),
      );
      assert(
        groupedRuns.some((row) =>
          row.mode === "eval" && row.exit_code === 0 && Number(row.count) >= 2
        ),
        "query_runs should report successful eval records",
      );
      assert(
        groupedRuns.some((row) =>
          row.mode === "eval" && row.exit_code === 1 && Number(row.count) >= 1
        ),
        "query_runs should report failed eval records",
      );
      const parameterizedRuns = parseToolJson<Array<Record<string, unknown>>>(
        await ctx.client.callTool(
          {
            name: "query_runs",
            arguments: {
              sql: "SELECT run_id, mode FROM runs WHERE run_id = ?",
              params: [String(runScriptOne.run_id)],
            },
          },
          { timeout: 15000 },
        ),
      );
      assertEquals(parameterizedRuns, [{
        run_id: runScriptOne.run_id,
        mode: "eval",
      }]);
      const runResource = await ctx.client.readResource(
        { uri: `aves://runs/${runScriptOne.run_id}` },
        { timeout: 10000 },
      );
      const runResourceJson = JSON.parse(
        runResource.contents.find((item) => "text" in item)?.text ?? "{}",
      ) as Record<string, unknown>;
      assertEquals(runResourceJson.run_id, runScriptOne.run_id);
      assertEquals(runResourceJson.mode, "eval");

      setStage(ctx, "repl create");
      const replInfo = parseToolJson<Record<string, unknown>>(
        await ctx.client.callTool(
          {
            name: "repl_create",
            arguments: {
              cwd: ctx.replWorkspace,
              description: "e2e repl session",
              permissions: {},
              timeout_ms: 1000,
            },
          },
          { timeout: 30000 },
        ),
      );
      const sessionId = replInfo.session_id ?? replInfo.id;
      assertEquals(typeof sessionId, "string");
      assertEquals(replInfo.description, "e2e repl session");
      assertEquals(replInfo.cwd, ctx.realReplWorkspace);
      assertEquals(replInfo.evalCount, 0);
      assertEquals(typeof replInfo.pid, "number");
      assertEquals(typeof replInfo.startedAt, "string");

      setStage(ctx, "repl state");
      assertEquals(
        parseToolJson<Record<string, unknown>>(
          await ctx.client.callTool(
            {
              name: "repl_eval",
              arguments: { session_id: sessionId, code: "const x = 41; x" },
            },
            { timeout: 15000 },
          ),
        ),
        { ok: true, data: 41 },
      );
      assertEquals(
        parseToolJson<Record<string, unknown>>(
          await ctx.client.callTool(
            {
              name: "repl_eval",
              arguments: { session_id: sessionId, code: "const y = x + 1; y" },
            },
            { timeout: 15000 },
          ),
        ),
        { ok: true, data: 42 },
      );
      assertEquals(
        parseToolJson<Record<string, unknown>>(
          await ctx.client.callTool(
            {
              name: "repl_eval",
              arguments: {
                session_id: sessionId,
                code: "await Promise.resolve(y + 1)",
              },
            },
            { timeout: 15000 },
          ),
        ),
        { ok: true, data: 43 },
      );

      setStage(ctx, "repl declarations");
      assertEquals(
        parseToolJson<Record<string, unknown>>(
          await ctx.client.callTool(
            {
              name: "repl_eval",
              arguments: {
                session_id: sessionId,
                code: "function add(a, b) { return a + b } add(x, y)",
              },
            },
            { timeout: 15000 },
          ),
        ),
        { ok: true, data: 83 },
      );
      assertEquals(
        parseToolJson<Record<string, unknown>>(
          await ctx.client.callTool(
            {
              name: "repl_eval",
              arguments: {
                session_id: sessionId,
                code: "const { a, b } = { a: 2, b: 3 }; a + b",
              },
            },
            { timeout: 15000 },
          ),
        ),
        { ok: true, data: 5 },
      );
      const duplicateConst = parseToolJson<Record<string, unknown>>(
        await ctx.client.callTool(
          {
            name: "repl_eval",
            arguments: { session_id: sessionId, code: "const x = 99; x" },
          },
          { timeout: 15000 },
        ),
      );
      assertEquals(duplicateConst.ok, true);
      assertEquals(duplicateConst.data, 99);

      setStage(ctx, "repl error recovery");
      const parseError = parseToolJson<Record<string, unknown>>(
        await ctx.client.callTool(
          {
            name: "repl_eval",
            arguments: { session_id: sessionId, code: "const broken =" },
          },
          { timeout: 15000 },
        ),
      );
      assertEquals(parseError.ok, false);
      assertExists(parseError.error);
      assertEquals(
        parseToolJson<Record<string, unknown>>(
          await ctx.client.callTool(
            {
              name: "repl_eval",
              arguments: { session_id: sessionId, code: "x + y" },
            },
            { timeout: 15000 },
          ),
        ),
        { ok: true, data: 141 },
      );
      const runtimeError = parseToolJson<Record<string, unknown>>(
        await ctx.client.callTool(
          {
            name: "repl_eval",
            arguments: {
              session_id: sessionId,
              code: 'throw new Error("repl boom")',
            },
          },
          { timeout: 15000 },
        ),
      );
      assertEquals(runtimeError.ok, false);
      assertStringIncludes(String(runtimeError.error), "repl boom");
      assertEquals(
        parseToolJson<Record<string, unknown>>(
          await ctx.client.callTool(
            {
              name: "repl_eval",
              arguments: { session_id: sessionId, code: "x + y" },
            },
            { timeout: 15000 },
          ),
        ),
        { ok: true, data: 141 },
      );

      setStage(ctx, "repl timeout");
      const timeoutResult = parseToolJson<Record<string, unknown>>(
        await ctx.client.callTool(
          {
            name: "repl_eval",
            arguments: {
              session_id: sessionId,
              code: "while (true) {}",
              timeout_ms: 50,
            },
          },
          { timeout: 5000 },
        ),
      );
      assertEquals(timeoutResult.ok, false);
      assertStringIncludes(String(timeoutResult.error), "REPL eval timed out");
      const evalAfterTimeout = parseToolJson<Record<string, unknown>>(
        await ctx.client.callTool(
          {
            name: "repl_eval",
            arguments: { session_id: sessionId, code: "x + y" },
          },
          { timeout: 15000 },
        ),
      );
      assertEquals(evalAfterTimeout.ok, false);
      assertStringIncludes(String(evalAfterTimeout.error), "session not found");

      const replacementRepl = parseToolJson<Record<string, unknown>>(
        await ctx.client.callTool(
          {
            name: "repl_create",
            arguments: {
              cwd: ctx.replWorkspace,
              description: "e2e replacement repl session",
              permissions: {},
              timeout_ms: 1000,
            },
          },
          { timeout: 30000 },
        ),
      );
      const replacementSessionId = replacementRepl.session_id ??
        replacementRepl.id;
      assertEquals(typeof replacementSessionId, "string");
      assertEquals(
        parseToolJson<Record<string, unknown>>(
          await ctx.client.callTool(
            {
              name: "repl_eval",
              arguments: {
                session_id: replacementSessionId,
                code: "const fresh = 40 + 2; fresh",
              },
            },
            { timeout: 15000 },
          ),
        ),
        { ok: true, data: 42 },
      );

      setStage(ctx, "repl close");
      assertEquals(
        parseToolJson<Record<string, unknown>>(
          await ctx.client.callTool(
            {
              name: "repl_close",
              arguments: { session_id: replacementSessionId },
            },
            { timeout: 15000 },
          ),
        ),
        { closed: true },
      );
      const evalAfterClose = parseToolJson<Record<string, unknown>>(
        await ctx.client.callTool(
          {
            name: "repl_eval",
            arguments: { session_id: replacementSessionId, code: "fresh" },
          },
          { timeout: 15000 },
        ),
      );
      assertEquals(evalAfterClose.ok, false);
      assertStringIncludes(String(evalAfterClose.error), "session not found");
      assertEquals(
        parseToolJson<Record<string, unknown>>(
          await ctx.client.callTool(
            {
              name: "repl_close",
              arguments: { session_id: "missing-session" },
            },
            { timeout: 15000 },
          ),
        ),
        { closed: false },
      );

      setStage(ctx, "list_skills before files");
      const listedBeforeSkill = parseToolJson<
        { skills: Array<Record<string, unknown>> }
      >(
        await ctx.client.callTool(
          { name: "list_skills", arguments: {} },
          { timeout: 15000 },
        ),
      );
      assert(
        !listedBeforeSkill.skills.some((skill) => skill.name === "e2e-skill"),
        "list_skills should not discover the temporary skill before files exist",
      );

      setStage(ctx, "skill files");
      await Deno.writeTextFile(
        `${ctx.skillDir}/SKILL.md`,
        [
          "---",
          "name: e2e-skill",
          "description: A skill used by the MCP e2e test",
          "aves: true",
          "---",
          "",
          "# E2E Skill",
          "",
        ].join("\n"),
      );
      await Deno.writeTextFile(
        `${ctx.skillDir}/mod.ts`,
        [
          "export default async function main(input: { value?: number }) {",
          "  const value = input.value ?? 0;",
          "  return { value, tripled: value * 3 };",
          "}",
          "",
        ].join("\n"),
      );
      await Deno.writeTextFile(
        `${ctx.skillDir}/mod.permission.ts`,
        [
          "export default function permissions() {",
          "  return {};",
          "}",
          "",
        ].join("\n"),
      );

      setStage(ctx, "list_skills");
      const listedSkills = parseToolJson<
        { skills: Array<Record<string, unknown>> }
      >(
        await ctx.client.callTool(
          { name: "list_skills", arguments: {} },
          { timeout: 15000 },
        ),
      );
      assert(
        listedSkills.skills.some((skill) => skill.name === "e2e-skill"),
        "list_skills should discover the temporary skill",
      );

      setStage(ctx, "run_skill");
      const skillRunOne = parseToolJson<Record<string, unknown>>(
        await ctx.client.callTool(
          {
            name: "run_skill",
            arguments: {
              skill_path: ctx.skillDir,
              input: { value: 5 },
              permissions: {},
            },
          },
          { timeout: 30000 },
        ),
      );
      assertEquals(skillRunOne.exit_code, 0);
      assertEquals(skillRunOne.mode, "skill");
      assertEquals(skillRunOne.output, { value: 5, tripled: 15 });

      const skillRunTwo = parseToolJson<Record<string, unknown>>(
        await ctx.client.callTool(
          {
            name: "run_skill",
            arguments: {
              skill_path: ctx.skillDir,
              input: { value: 14 },
              permissions: {},
            },
          },
          { timeout: 30000 },
        ),
      );
      assertEquals(skillRunTwo.exit_code, 0);
      assertEquals(skillRunTwo.output, { value: 14, tripled: 42 });

      setStage(ctx, "post-skill query");
      const modeCounts = parseToolJson<Array<Record<string, unknown>>>(
        await ctx.client.callTool(
          {
            name: "query_runs",
            arguments: {
              sql:
                "SELECT mode, COUNT(*) as count FROM runs GROUP BY mode ORDER BY mode",
            },
          },
          { timeout: 15000 },
        ),
      );
      assert(
        modeCounts.some((row) =>
          row.mode === "skill" && Number(row.count) >= 2
        ),
        "query_runs should report skill records",
      );

      setStage(ctx, "client close");
      ctx.cleanup = true;
    } catch (err) {
      throw withContextMessage(
        ctx,
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      await teardownE2e(ctx);
    }
  },
);
