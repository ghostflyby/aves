import type { ServerPolicy } from "./policy.ts";
import { resolvePermissions } from "./policy.ts";
import type { Permissions, RunRecord, RunRequest } from "./types.ts";
import type { BrokerPolicy } from "./broker.ts";
import { startBroker } from "./broker.ts";
import type { SandboxState } from "./sandbox-state.ts";
import {
  extractCodexNetworkTargets,
  extractCodexReadablePaths,
  extractCodexWritablePaths,
} from "./sandbox-state.ts";
import { loadScriptApproval } from "./run-store.ts";
import { loadPermissionModule } from "./permission-loader.ts";

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
  runDir: string,
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
    cwd: runDir,
    stdout: "piped",
    stderr: "piped",
    env: {
      ...Deno.env.toObject(),
      DENO_PERMISSION_BROKER_PATH: sockPath,
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
  req: { permission: string; value: string },
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
// Ceiling check
// ============================================================

/** Match a path against an allow-list prefix, handling macOS /var -> /private/var symlink. */
function pathMatches(allowed: string, requested: string): boolean {
  if (requested.startsWith(allowed)) return true;
  // macOS /var is symlinked to /private/var
  const normReq = requested.replace(/^\/private/, "");
  const normAllowed = allowed.replace(/^\/private/, "");
  return normReq.startsWith(normAllowed) || allowed.startsWith(normReq);
}

function checkCeiling(
  req: { permission: string; value: string },
  ceiling: SandboxState,
): "allow" | "deny" | "unknown" {
  switch (req.permission) {
    case "read": {
      const readable = extractCodexReadablePaths(ceiling);
      if (readable.includes("*")) return "allow";
      return readable.some((p) => pathMatches(p, req.value)) ? "allow" : "deny";
    }
    case "write": {
      const writable = extractCodexWritablePaths(ceiling);
      if (writable.includes("*")) return "allow";
      return writable.some((p) => pathMatches(p, req.value)) ? "allow" : "deny";
    }
    case "net": {
      const netTargets = extractCodexNetworkTargets(ceiling);
      return netTargets.includes("*") ? "allow" : "deny";
    }
    default:
      return "deny";
  }
}

// ============================================================
// createRunBrokerPolicy
// ============================================================

function createRunBrokerPolicy(
  codexCeiling: SandboxState | null,
  codeHash: string | null,
  extraDirs: string[],
  skillDir?: string,
): BrokerPolicy {
  // Load permission module at policy creation time (if skillDir provided)
  const permModule = skillDir ? loadPermissionModule(skillDir) : null;

  return {
    async decide(req) {
      // Resolve relative paths against the run directory
      const resolvedValue = req.value.startsWith("/") || !extraDirs[0]
        ? req.value
        : `${extraDirs[0]}/${req.value.replace(/^\.\//, "")}`;
      const resolvedReq = { ...req, value: resolvedValue };
      // Always allow safe defaults (no ceiling or trust needed)
      if (isDefaultAllowed(resolvedReq)) return "allow";
      if (
        (resolvedReq.permission === "read" ||
          resolvedReq.permission === "write") &&
        extraDirs.some((d) => resolvedValue.startsWith(d + "/"))
      ) return "allow";

      // Check permission module for fine-grained rules (before ceiling)
      if (permModule) {
        const permResult = await permModule.decide(
          resolvedReq.permission,
          resolvedValue,
        );
        if (permResult === "deny") {
          return { deny: "denied by skill permission module" };
        }
        if (permResult === "allow") return "allow";
        // null → fall through to ceiling / hash trust / deny
      }

      // Check Codex ceiling
      if (codexCeiling) {
        console.error(
          extractCodexWritablePaths(codexCeiling).slice(0, 5),
        );
        const ceilingResult = checkCeiling(resolvedReq, codexCeiling);
        if (ceilingResult === "deny") {
          return { deny: "outside Codex sandbox" };
        }
        if (ceilingResult === "allow") {
          // Unrestricted ceiling — no need to check further
          if (codexCeiling) {
            console.error(
              extractCodexWritablePaths(codexCeiling).slice(0, 5),
            );
            const readable = extractCodexReadablePaths(codexCeiling);
            const writable = extractCodexWritablePaths(codexCeiling);
            const netTargets = extractCodexNetworkTargets(codexCeiling);
            if (
              readable.includes("*") && writable.includes("*") &&
              netTargets.includes("*")
            ) {
              return "allow";
            }
          }
          // Within ceiling — check hash trust for auto-approval
          if (codeHash) {
            try {
              const prev = await loadScriptApproval(codeHash);
              if (prev) {
                return "allow";
              }
            } catch {
              // DB error — deny instead of elicit
            }
          }
          // First run within ceiling — deny (elicit handled by server)
          return { deny: "requires approval" };
        }
      }

      // No ceiling info — check permission module for non-read, otherwise allow reads
      if (permModule) {
        const permResult = await permModule.decide(
          resolvedReq.permission,
          resolvedValue,
        );
        if (permResult === "deny") {
          return { deny: "denied by skill permission module" };
        }
        if (permResult === "allow") return "allow";
        // null → fall through to deny
      }
      if (resolvedReq.permission === "read") return "allow";
      return { deny: "outside Codex sandbox" };
    },

    onElicitResolved(_id, _allowed) {
      // No-op: elicitation handled by server, not broker
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
  codeHash?: string | null,
  codexCeiling?: SandboxState | null,
  skillDir?: string,
): Promise<RunRecord> {
  const runDir = await Deno.makeTempDir({
    prefix: "aves_",
    suffix: `_run_${runId}`,
  });
  const startedAt = new Date();
  const startedAtStr = startedAt.toISOString();

  await Deno.writeTextFile(
    `${runDir}/input.json`,
    JSON.stringify(input),
  );

  const realModulePath = await Deno.realPath(modulePath);
  const realRunDir = await Deno.realPath(runDir);

  // Start the permission broker
  const policy = createRunBrokerPolicy(codexCeiling ?? null, codeHash ?? null, [
    realRunDir,
    realModulePath.substring(0, realModulePath.lastIndexOf("/")),
  ], skillDir);
  let brokerPath = "";

  try {
    const broker = await startBroker(policy);
    brokerPath = broker.sockPath;

    // Store the handle on the policy for cleanup (done promise + cancel)
    (policy as unknown as Record<string, unknown>)._broker = broker;
  } catch (err) {
    console.error(
      `[aves] broker start failed for run ${runId}: ${err}`,
    );
  }

  // Spawn the child Deno process
  const proc = spawnDenoWithBroker(
    realModulePath,
    runDir,
    brokerPath,
  );

  // Wait for the subprocess to finish
  const { code: exitCode, stdout: stdoutBytes, stderr: stderrBytes } =
    await proc.output();

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
    const outputText = await Deno.readTextFile(`${realRunDir}/output.json`);
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
      await Deno.readTextFile(`${realRunDir}/parsed_input.json`),
    );
  } catch { /* no-op */ }
  try {
    await Deno.remove(runDir, { recursive: true });
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
): Promise<RunRecord> {
  const runId = crypto.randomUUID();
  if (request.mode === "eval") {
    if (!request.code) {
      throw new Error("Invalid request: eval mode requires 'code'");
    }
    // Write code to temp file, then delegate to runModuleInSandbox
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
    );

    // Clean up eval dir (runModuleInSandbox cleans its own dir)
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
    undefined,
    codexCeiling ?? null,
  );
}

// ============================================================
// Skill execution
// ============================================================

export interface SkillRunResult {
  record: RunRecord;
}

/**
 * Execute a skill by its directory path.
 * No longer uses skill.json — reads mod.ts, builds permissions from override.
 */
export async function executeSkillRun(
  skillDir: string,
  input: Record<string, unknown>,
  options?: {
    policy?: ServerPolicy;
    permissionsOverride?: Permissions;
    projectPath?: string;
    codexCeiling?: SandboxState | null;
  },
): Promise<SkillRunResult> {
  const runId = crypto.randomUUID();

  // Verify SKILL.md exists
  try {
    await Deno.stat(`${skillDir}/SKILL.md`);
  } catch {
    throw new Error(`Not a skill directory (SKILL.md not found): ${skillDir}`);
  }

  // Read mod.ts for code hash
  let codeHash: string | undefined;
  try {
    const modContent = await Deno.readTextFile(`${skillDir}/mod.ts`);
    codeHash = await sha256Hex(modContent);
  } catch {
    throw new Error(`Skill entrypoint not found: ${skillDir}/mod.ts`);
  }

  const entrypoint = `${skillDir}/mod.ts`;

  // Use permissions override as the base; no manifest to merge with
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
    undefined,
    options?.codexCeiling ?? null,
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
