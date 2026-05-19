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
import { loadPermissionModule } from "./permission-loader.ts";
/**
 * Global abort signal — aborted on server shutdown.
 * Each script run creates a child controller linked to this one,
 * so all spawned Deno subprocesses are killed when Aves exits.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
export const globalAbort = new AbortController();

// Resolve boot.ts relative to the runner source, falling back to PWD/src.
const _runnerDir = fileURLToPath(new URL(".", import.meta.url));
const BOOT_PATH = fileURLToPath(new URL("./boot.ts", import.meta.url));

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
  "AVES_IO_DIR",
]);

function resolveTempDirs(): string[] {
  const dirs: string[] = ["/tmp"];
  const tmpdir = Deno.env.get("TMPDIR");
  if (tmpdir && tmpdir !== "/tmp") {
    dirs.push(tmpdir.replace(/\/+\$/, ""));
  }
  return dirs;
}

export function isDefaultAllowed(
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
    case "import": {
      const reqHost = req.value.split(":")[0];
      return DEFAULT_IMPORT_DOMAINS.some((d) => {
        const allowedHost = d.split(":")[0];
        return reqHost === allowedHost;
      });
    }
    default:
      return false;
  }
}

// ============================================================
// Path matching (handles macOS /var -> /private/var symlink)
// ============================================================

export function pathMatches(allowed: string, requested: string): boolean {
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
//   import not in built-in list → hard deny (no permModule override)
//   permission module (skill mod.permission.ts) → allow/deny/null
//   extra dirs (run dir, module dir, cwd) → allow
//   read-only without ceiling → allow
//   everything else → elicit
// ============================================================

/** Context passed through to the elicitation handler. */
export interface RunElicitContext {
  codeHash: string | null;
  codexCeiling: SandboxState | null;
  extraDirs: string[];
  /** Run requests whose normalized value exactly matches an entry in this list are auto-allowed without elicitation. */
  preApprovedRunPaths?: string[];
}

export function createRunBrokerPolicy(
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

      // 1b. Pre-approved run paths (e.g. esbuild native binary) — auto-allow without elicitation.
      // Normalise so symlinks or trailing slashes don't defeat the exact match.
      if (
        resolvedReq.permission === "run" &&
        ctx.preApprovedRunPaths?.some((p) =>
          path.normalize(p) === path.normalize(resolvedValue)
        )
      ) {
        return "allow";
      }

      // 1a. Import not in built-in list → hard deny (no permModule override)
      if (resolvedReq.permission === "import") {
        return {
          deny: "import from this domain is not in the built-in allowlist",
        };
      }

      // 2. Permission module (skill mod.permission.ts) — user's rules override everything below
      if (permModule) {
        const permResult = await permModule.decide(
          resolvedReq.permission,
          resolvedValue,
        );
        if (permResult === "deny") {
          return { deny: "denied by skill permission module" };
        }
        if (permResult === "allow") return "allow";
        // null/undefined → fall through
      }

      // 3. Extra dirs (run dir, module dir, cwd) — auto-allow if permModule didn't decide
      if (
        (resolvedReq.permission === "read" ||
          resolvedReq.permission === "write") &&
        ctx.extraDirs.some((d) => pathMatches(d + "/", resolvedValue))
      ) return "allow";

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
  input: unknown,
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
    JSON.stringify(input ?? null),
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
  // Create a child AbortController linked to the global one.
  // When Aves shuts down, all running subprocesses are aborted.
  const runAc = new AbortController();
  const onGlobalAbort = () => runAc.abort(new Error("server shutting down"));
  globalAbort.signal.addEventListener("abort", onGlobalAbort);

  const proc = spawnDenoWithBroker(
    realModulePath,
    realCwd,
    ioDir,
    brokerPath,
  );

  // Kill the child process when aborted (timeout or shutdown)
  runAc.signal.addEventListener("abort", () => {
    try {
      proc.kill("SIGKILL");
    } catch { /* already dead */ }
  });

  // Optional user-specified timeout
  if (timeoutMs && timeoutMs > 0) {
    setTimeout(() => runAc.abort(new Error("Script timed out")), timeoutMs);
  }

  let exitCode = 0;
  let stdoutBytes = new Uint8Array();
  let stderrBytes = new Uint8Array();
  try {
    const result = await proc.output();
    exitCode = result.code;
    stdoutBytes = result.stdout;
    stderrBytes = result.stderr;
  } catch (err) {
    if (!runAc.signal.aborted) {
      runAc.abort(err);
    }
    try {
      await proc.output();
    } catch { /* ignore */ }
    throw err;
  } finally {
    globalAbort.signal.removeEventListener("abort", onGlobalAbort);
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
  try {
    await Deno.remove(ioDir, { recursive: true });
  } catch { /* best-effort */ }

  return {
    run_id: runId,
    mode,
    code_hash: undefined,
    exit_code: exitCode,
    stdout,
    stderr,
    output,
    error,
    started_at: startedAtStr,
    finished_at: finishedAtStr,
    duration_ms: durationMs,
    code: undefined,
  } as RunRecord;
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
  input: unknown,
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
