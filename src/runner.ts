import type { ServerPolicy } from "./policy.ts";
import { resolvePermissions } from "./policy.ts";
import type { Permissions, RunRecord, RunRequest } from "./types.ts";
import type {
  BrokerPolicy,
  ElicitResolver,
  PermissionKind,
  PermissionRequest,
} from "./broker.ts";
import { startBroker } from "./broker.ts";
import type { SandboxState } from "./sandbox-state.ts";
import { loadScriptApproval } from "./run-store.ts";
import { loadPermissionModule } from "./permission-loader.ts";
import { trackProcess, untrackProcess } from "./proc-tracker.ts";

const BOOT_PATH = new URL("./boot.ts", import.meta.url).pathname;

// ============================================================
// Default-allowed import domains (cannot go through broker —
// imports are resolved at parse/load time before the broker
// socket is connected).
// ============================================================

const DEFAULT_IMPORT_DOMAINS = [
  "deno.land:443",
  "jsr.io:443",
  "esm.sh:443",
  "raw.esm.sh:443",
  "cdn.jsdelivr.net:443",
  "raw.githubusercontent.com:443",
  "gist.githubusercontent.com:443",
];

const BROKER_NET_ALLOW = [
  "deno.land",
  "jsr.io",
  "esm.sh",
  "raw.esm.sh",
  "cdn.jsdelivr.net",
  "raw.githubusercontent.com",
  "gist.githubusercontent.com",
];

// ============================================================
// spawnDenoWithBroker
// ============================================================

function spawnDenoWithBroker(
  modulePath: string,
  scriptCwd: string,
  ioDir: string,
  sockPath: string,
): Deno.ChildProcess {
  const args = [
    "run",
    "--no-prompt",
    "--allow-import=" + DEFAULT_IMPORT_DOMAINS.join(","),
    BOOT_PATH,
    modulePath,
  ];
  const cmd = new Deno.Command("deno", {
    args,
    cwd: scriptCwd,
    stdout: "piped",
    stderr: "piped",
    env: {
      ...Deno.env.toObject(),
      DENO_PERMISSION_BROKER_PATH: sockPath,
      AVES_IO_DIR: ioDir,
    },
  });
  return cmd.spawn();
}

// ============================================================
// Default-allowed permissions (always allow, no ceiling/trust)
// ============================================================

const DEFAULT_ALLOWED_SYS = new Set([
  "hostname",
  "osRelease",
  "osUptime",
  "loadavg",
  "systemMemoryInfo",
  "gid",
  "uid",
  "networkInterfaces",
]);

const DEFAULT_ALLOWED_ENV = new Set([
  "HOME",
  "USER",
  "PATH",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TERM",
]);

function resolveTempDirs(): string[] {
  const dirs: string[] = ["/tmp"];
  const tmpdir = Deno.env.get("TMPDIR");
  if (tmpdir && tmpdir !== "/tmp") {
    dirs.push(tmpdir.replace(/\/+\$/, ""));
  }
  return dirs;
}

function isDefaultAllowed(
  req: { permission: PermissionKind; value: string },
): boolean {
  switch (req.permission) {
    case "sys":
      return DEFAULT_ALLOWED_SYS.has(req.value);
    case "env":
      return DEFAULT_ALLOWED_ENV.has(req.value);
    case "read":
    case "write":
      return resolveTempDirs().some((d) => pathMatches(d + "/", req.value));
    case "net": {
      const reqHost = req.value.split(":")[0];
      return BROKER_NET_ALLOW.some((d) => reqHost === d);
    }
    default:
      return false;
  }
}

// ============================================================
// Path matching (handles macOS /var -> /private/var symlink)
// ============================================================

function pathMatches(allowed: string, requested: string): boolean {
  if (requested.startsWith(allowed)) return true;
  const normReq = requested.replace(/^\/private/, "");
  const normAllowed = allowed.replace(/^\/private/, "");
  return normReq.startsWith(normAllowed) || allowed.startsWith(normReq);
}

// ============================================================
// createRunBrokerPolicy
//
// Decision chain (no hard denies — everything beyond defaults
// is elicited so the user has final say):
//
//   default allowed (tmp, safe sys/env, import domains) → allow
//   extra dirs (run dir, module dir) → allow
//   permission module (skill mod.permission.ts) → allow/deny/null
//   hash trust (previously approved same-hash script) → allow
//   everything else → elicit
// ============================================================

/** Context passed through to the elicitation handler. */
export interface RunElicitContext {
  codeHash: string | null;
  codexCeiling: SandboxState | null;
  extraDirs: string[];
}

function createRunBrokerPolicy(
  ctx: RunElicitContext,
  skillDir?: string,
): BrokerPolicy {
  const permModule = skillDir ? loadPermissionModule(skillDir) : null;

  return {
    async decide(req) {
      // Resolve relative paths against the run directory (read/write only)
      const isPathPerm = req.permission === "read" ||
        req.permission === "write";
      const resolvedValue =
        isPathPerm && !req.value.startsWith("/") && ctx.extraDirs[0]
          ? `${ctx.extraDirs[0]}/${req.value.replace(/^\.\//, "")}`
          : req.value;
      const resolvedReq = { ...req, value: resolvedValue };

      // 1. Default allowed (safe sys, env, tmp, import domains)
      if (isDefaultAllowed(resolvedReq)) return "allow";

      // 2. Extra dirs (run dir, module dir)
      if (
        (resolvedReq.permission === "read" ||
          resolvedReq.permission === "write") &&
        ctx.extraDirs.some((d) => pathMatches(d + "/", resolvedValue))
      ) return "allow";

      // 3. Permission module (skill mod.permission.ts)
      if (permModule) {
        const permResult = await permModule.decide(
          resolvedReq.permission,
          resolvedValue,
        );
        if (permResult === "deny") {
          return { deny: "denied by skill permission module" };
        }
        if (permResult === "allow") return "allow";
      }

      // 4. Hash trust — only for skills (gated by mod.permission.ts approval)
      if (skillDir && ctx.codeHash) {
        try {
          const prev = await loadScriptApproval(ctx.codeHash);
          if (prev) return "allow";
        } catch { /* DB error, fall through to elicit */ }
      }

      // 5. Read-only with no ceiling → allow silently
      if (!ctx.codexCeiling && resolvedReq.permission === "read") {
        return "allow";
      }

      // 6. Everything else → elicit (user has final say)
      return "elicit";
    },

    onElicitResolved(_id, _allowed) {
      // No-op: elicitation handled by the server via onElicit
    },
  };
}

// ============================================================
// runModuleInSandbox — core execution with broker
// ============================================================

async function runModuleInSandbox(
  runId: string,
  modulePath: string,
  input: Record<string, unknown>,
  _granted: Permissions,
  _userPerms: Permissions,
  _denied: string[],
  mode: RunRecord["mode"],
  codeHash: string | null,
  codexCeiling: SandboxState | null,
  onElicit:
    | ((req: PermissionRequest, resolve: ElicitResolver) => Promise<void>)
    | null,
  scriptCwd?: string,
  timeoutMs?: number,
  skillDir?: string,
): Promise<RunRecord> {
  const ioDir = await Deno.makeTempDir({
    prefix: "aves_io_",
    suffix: `_${runId}`,
  });
  const startedAt = new Date();
  const startedAtStr = startedAt.toISOString();

  await Deno.writeTextFile(
    `${ioDir}/input.json`,
    JSON.stringify(input),
  );

  const realCwd = scriptCwd ? await Deno.realPath(scriptCwd) : ioDir;
  const realModulePath = await Deno.realPath(modulePath);
  const realIoDir = await Deno.realPath(ioDir);

  // Build elicit context — extraDirs includes cwd, module dir, io dir
  const extraDirs = [realIoDir];
  if (realCwd !== realIoDir) extraDirs.push(realCwd);
  extraDirs.push(realModulePath.substring(0, realModulePath.lastIndexOf("/")));

  const ctx: RunElicitContext = {
    codeHash,
    codexCeiling,
    extraDirs,
  };

  // Start the permission broker
  const policy = createRunBrokerPolicy(ctx, skillDir);
  if (onElicit) {
    policy.onElicit = (_id, req, resolve) => {
      onElicit(req, resolve).catch(() => resolve(false));
    };
  }

  let brokerPath = "";
  try {
    const broker = await startBroker(policy);
    brokerPath = broker.sockPath;
    (policy as unknown as Record<string, unknown>)._broker = broker;
  } catch (err) {
    console.error(
      `[aves] broker start failed for run ${runId}: ${err}`,
    );
  }

  // Spawn the child Deno process
  const proc = spawnDenoWithBroker(
    realModulePath,
    realCwd,
    ioDir,
    brokerPath,
  );
  trackProcess(proc);

  // Wait with optional timeout
  let exitCode = 0;
  let stdoutBytes = new Uint8Array();
  let stderrBytes = new Uint8Array();
  try {
    if (timeoutMs && timeoutMs > 0) {
      const result = await Promise.race([
        proc.output(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Script timed out")), timeoutMs)
        ),
      ]);
      exitCode = result.code;
      stdoutBytes = result.stdout;
      stderrBytes = result.stderr;
    } else {
      const result = await proc.output();
      exitCode = result.code;
      stdoutBytes = result.stdout;
      stderrBytes = result.stderr;
    }
  } catch (err) {
    try {
      proc.kill("SIGKILL");
    } catch { /* already dead */ }
    try {
      await proc.output();
    } catch { /* ignore */ }
    throw err;
  } finally {
    untrackProcess(proc);
  }

  const finishedAt = new Date();
  const finishedAtStr = finishedAt.toISOString();
  const durationMs = finishedAt.getTime() - startedAt.getTime();
  // Cancel the broker
  const broker = (policy as unknown as Record<string, unknown>)?._broker as {
    cancel(): void;
    done: Promise<void>;
  } | undefined;
  if (broker) {
    broker.cancel();
    try {
      await broker.done;
    } catch { /* broker cleanup is best-effort */ }
  }

  const stdout = new TextDecoder().decode(stdoutBytes);
  const stderr = new TextDecoder().decode(stderrBytes);

  let output: unknown = null;
  let error: string | undefined;
  try {
    const outputText = await Deno.readTextFile(`${realIoDir}/output.json`);
    const parsed = JSON.parse(outputText);
    if (parsed.ok) output = parsed.data;
    else error = parsed.error;
  } catch {
    if (exitCode !== 0 && !error) {
      error = stderr || "Process exited with non-zero code";
    }
  }

  let parsedInput: Record<string, unknown> | undefined;
  try {
    parsedInput = JSON.parse(
      await Deno.readTextFile(`${realIoDir}/parsed_input.json`),
    );
  } catch { /* no-op */ }
  try {
    await Deno.remove(ioDir, { recursive: true });
  } catch { /* best-effort */ }

  return {
    run_id: runId,
    mode,
    code_hash: undefined,
    raw_input: input,
    parsed_input: parsedInput,
    stdout,
    stderr,
    exit_code: exitCode,
    output,
    error,
    started_at: startedAtStr,
    finished_at: finishedAtStr,
    duration_ms: durationMs,
    code: undefined,
  };
}

// ============================================================
// executeRun
// ============================================================

export async function executeRun(
  request: RunRequest,
  options?: { policy?: ServerPolicy },
  codexCeiling?: SandboxState | null,
  onElicit?:
    | ((req: PermissionRequest, resolve: ElicitResolver) => Promise<void>)
    | null,
): Promise<RunRecord> {
  const runId = crypto.randomUUID();
  const cwd = (request as Record<string, unknown>).cwd as string | undefined;
  const timeoutMs = (request as Record<string, unknown>).timeout_ms as
    | number
    | undefined;

  if (request.mode === "eval") {
    if (!request.code) {
      throw new Error("Invalid request: eval mode requires 'code'");
    }
    const evalDir = await Deno.makeTempDir({
      prefix: "aves_",
      suffix: `_eval_${runId}`,
    });
    const modulePath = `${await Deno.realPath(evalDir)}/user_module.ts`;
    await Deno.writeTextFile(modulePath, request.code!);
    const codeHash = await sha256Hex(request.code!);

    const userPerms = request.permissions ?? {};
    const { granted, denied } = resolvePermissions(userPerms, options?.policy);

    const record = await runModuleInSandbox(
      runId,
      modulePath,
      request.input ?? {},
      granted,
      userPerms,
      denied,
      "eval",
      codeHash,
      codexCeiling ?? null,
      onElicit ?? null,
      cwd,
      timeoutMs,
    );

    try {
      await Deno.remove(evalDir, { recursive: true });
    } catch { /* skip */ }

    record.code_hash = codeHash;
    record.code = request.code!;
    return record;
  }

  if (request.mode !== "module") {
    throw new Error("Unreachable: expected module mode");
  }
  const moduleReq = request as Extract<RunRequest, { mode: "module" }>;
  const modulePath = moduleReq.modulePath
    ? await Deno.realPath(moduleReq.modulePath)
    : null;

  const userPerms = request.permissions ?? {};
  const { granted, denied } = resolvePermissions(userPerms, options?.policy);

  return await runModuleInSandbox(
    runId,
    modulePath!,
    request.input ?? {},
    granted,
    userPerms,
    denied,
    request.mode,
    null,
    codexCeiling ?? null,
    onElicit ?? null,
    cwd,
    timeoutMs,
  );
}

// ============================================================
// Skill execution
// ============================================================

export interface SkillRunResult {
  record: RunRecord;
}

export async function executeSkillRun(
  skillDir: string,
  input: Record<string, unknown>,
  options?: {
    policy?: ServerPolicy;
    permissionsOverride?: Permissions;
    projectPath?: string;
    codexCeiling?: SandboxState | null;
    onElicit?:
      | ((req: PermissionRequest, resolve: ElicitResolver) => Promise<void>)
      | null;
    cwd?: string;
    timeoutMs?: number;
  },
): Promise<SkillRunResult> {
  const runId = crypto.randomUUID();

  try {
    await Deno.stat(`${skillDir}/SKILL.md`);
  } catch {
    throw new Error(`Not a skill directory (SKILL.md not found): ${skillDir}`);
  }

  let codeHash: string | undefined;
  try {
    const modContent = await Deno.readTextFile(`${skillDir}/mod.ts`);
    codeHash = await sha256Hex(modContent);
  } catch {
    throw new Error(`Skill entrypoint not found: ${skillDir}/mod.ts`);
  }

  const entrypoint = `${skillDir}/mod.ts`;
  const effectivePerms = options?.permissionsOverride ?? {};
  const { granted, denied } = resolvePermissions(
    effectivePerms,
    options?.policy,
  );

  const record = await runModuleInSandbox(
    runId,
    entrypoint,
    input,
    granted,
    effectivePerms,
    denied,
    "skill",
    codeHash ?? null,
    options?.codexCeiling ?? null,
    options?.onElicit ?? null,
    options?.cwd,
    options?.timeoutMs,
    skillDir,
  );

  record.code_hash = codeHash;
  return { record };
}

// ============================================================
// Helpers
// ============================================================

async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return Array.from(new Uint8Array(hash)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}
