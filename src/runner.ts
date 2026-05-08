import type { ServerPolicy } from "./policy.ts";
import { resolvePermissions } from "./policy.ts";
import type { Permissions, RunRecord, RunRequest } from "./types.ts";
import {
  approveSkill,
  hashManifest,
  loadSkillManifest,
  resolveSkillEntrypoint,
} from "./skill.ts";

const BOOT_PATH = new URL("./boot.ts", import.meta.url).pathname;

function buildPermissionFlags(permissions: Permissions): string[] {
  const flags: string[] = [];
  if (permissions.read && permissions.read.length > 0) {
    flags.push(`--allow-read=${permissions.read.join(",")}`);
  }
  if (permissions.write && permissions.write.length > 0) {
    flags.push(`--allow-write=${permissions.write.join(",")}`);
  }
  if (permissions.net && permissions.net.length > 0) {
    flags.push(`--allow-net=${permissions.net.join(",")}`);
  }
  if (permissions.env && permissions.env.length > 0) {
    flags.push(`--allow-env=${permissions.env.join(",")}`);
  }
  return flags;
}

function mergePermissions(base: Permissions, extra: Permissions): Permissions {
  const result: Permissions = {};
  const allKeys = new Set([
    ...Object.keys(base),
    ...Object.keys(extra),
  ]) as Set<"read" | "write" | "net" | "env">;
  for (const key of allKeys) {
    const basePaths = base[key] ?? [];
    const extraPaths = extra[key] ?? [];
    const merged = [...new Set([...basePaths, ...extraPaths])];
    if (merged.length > 0) result[key] = merged;
  }
  return result;
}

// Shared execution body used by both executeRun and executeSkillRun
async function runModuleInSandbox(
  runId: string,
  modulePath: string,
  input: Record<string, unknown>,
  granted: Permissions,
  userPerms: Permissions,
  denied: string[],
  mode: RunRecord["mode"],
  policy?: ServerPolicy,
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

  const realRunDir = await Deno.realPath(runDir);
  const realModulePath = await Deno.realPath(modulePath);

  const runDirPerms: Permissions = {
    read: [realRunDir, BOOT_PATH, realModulePath],
    write: [realRunDir],
  };

  const mergedPerms = mergePermissions(granted, runDirPerms);
  const safePerms: Permissions = {};
  for (const [key, paths] of Object.entries(mergedPerms)) {
    if (key !== "run" && key !== "ffi" && paths) {
      safePerms[key as keyof Permissions] = paths;
    }
  }

  const permFlags = buildPermissionFlags(safePerms);
  const args = ["run", "--no-prompt", ...permFlags, BOOT_PATH, realModulePath];

  const cmd = new Deno.Command("deno", {
    args,
    cwd: runDir,
    stdout: "piped",
    stderr: "piped",
  });

  const proc = cmd.outputSync();
  const finishedAt = new Date();
  const finishedAtStr = finishedAt.toISOString();
  const durationMs = finishedAt.getTime() - startedAt.getTime();

  const stdout = new TextDecoder().decode(proc.stdout);
  const stderr = new TextDecoder().decode(proc.stderr);
  const exitCode = proc.code;

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
  let schemaHash: string | undefined;
  try {
    parsedInput = JSON.parse(
      await Deno.readTextFile(`${realRunDir}/parsed_input.json`),
    );
  } catch { /* no-op */ }
  try {
    schemaHash = (await Deno.readTextFile(`${realRunDir}/schema_hash.txt`))
      .trim();
  } catch { /* no-op */ }

  try {
    await Deno.remove(runDir, { recursive: true });
  } catch { /* best-effort */ }

  return {
    run_id: runId,
    mode,
    code_hash: undefined,
    schema_hash: schemaHash,
    raw_input: input,
    parsed_input: parsedInput,
    permissions: userPerms,
    granted_permissions: granted,
    denied_permissions: denied.length > 0 ? denied : undefined,
    stdout,
    stderr,
    exit_code: exitCode,
    output,
    error,
    started_at: startedAtStr,
    finished_at: finishedAtStr,
    duration_ms: durationMs,
  };
}

export async function executeRun(
  request: RunRequest,
  options?: { policy?: ServerPolicy },
): Promise<RunRecord> {
  const runId = crypto.randomUUID();
  const isEval = request.mode === "eval" && !!request.code;
  const startedAt = new Date();
  const startedAtStr = startedAt.toISOString();

  if (isEval) {
    const runDir = await Deno.makeTempDir({
      prefix: "aves_",
      suffix: `_run_${runId}`,
    });
    const realRunDir = await Deno.realPath(runDir);
    const modulePath = `${realRunDir}/user_module.ts`;
    await Deno.writeTextFile(modulePath, request.code!);
    await Deno.writeTextFile(
      `${runDir}/input.json`,
      JSON.stringify(request.input ?? {}),
    );

    const userPerms = request.permissions ?? {};
    const { granted, denied } = resolvePermissions(userPerms, options?.policy);

    const runDirPerms: Permissions = {
      read: [realRunDir, BOOT_PATH],
      write: [realRunDir],
    };

    const mergedPerms = mergePermissions(granted, runDirPerms);
    const safePerms: Permissions = {};
    for (const [key, paths] of Object.entries(mergedPerms)) {
      if (key !== "run" && key !== "ffi" && paths) {
        safePerms[key as keyof Permissions] = paths;
      }
    }

    const permFlags = buildPermissionFlags(safePerms);
    const args = ["run", "--no-prompt", ...permFlags, BOOT_PATH, modulePath];
    const codeHash = await sha256Hex(request.code!);

    const cmd = new Deno.Command("deno", {
      args,
      cwd: runDir,
      stdout: "piped",
      stderr: "piped",
    });

    const proc = await cmd.output();
    const finishedAt = new Date();
    const finishedAtStr = finishedAt.toISOString();
    const durationMs = finishedAt.getTime() - startedAt.getTime();

    const stdout = new TextDecoder().decode(proc.stdout);
    const stderr = new TextDecoder().decode(proc.stderr);
    const exitCode = proc.code;

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
    let schemaHash: string | undefined;
    try {
      parsedInput = JSON.parse(
        await Deno.readTextFile(`${realRunDir}/parsed_input.json`),
      );
    } catch { /* no-op */ }
    try {
      schemaHash = (await Deno.readTextFile(`${realRunDir}/schema_hash.txt`))
        .trim();
    } catch { /* no-op */ }

    try {
      await Deno.remove(runDir, { recursive: true });
    } catch { /* best-effort */ }

    return {
      run_id: runId,
      mode: request.mode,
      code_hash: codeHash,
      schema_hash: schemaHash,
      raw_input: request.input,
      parsed_input: parsedInput,
      permissions: userPerms,
      granted_permissions: granted,
      denied_permissions: denied.length > 0 ? denied : undefined,
      stdout,
      stderr,
      exit_code: exitCode,
      output,
      error,
      started_at: startedAtStr,
      finished_at: finishedAtStr,
      duration_ms: durationMs,
    };
  }

  if (!request.modulePath && request.mode !== "skill") {
    throw new Error(
      `Invalid request: mode=${request.mode}, code or modulePath missing`,
    );
  }

  const modulePath = request.modulePath
    ? await Deno.realPath(request.modulePath)
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
    options?.policy,
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
 * Relies on MCP Elicitation (destructiveHint) for client-side approval.
 * Service side: loads manifest, merges permissions, executes, auto-approves.
 */
export async function executeSkillRun(
  skillDir: string,
  input: Record<string, unknown>,
  options?: {
    policy?: ServerPolicy;
    permissionsOverride?: Permissions;
    projectPath?: string;
  },
): Promise<SkillRunResult> {
  const runId = crypto.randomUUID();

  const manifestResult = await loadSkillManifest(skillDir);
  if (!manifestResult.ok) {
    throw new Error(`Invalid skill at ${skillDir}: ${manifestResult.error}`);
  }
  const manifest = manifestResult.manifest;

  // Merge permissions: manifest as base, request only shrinks
  const override = options?.permissionsOverride ?? {};
  const effectivePerms: Permissions = {};
  for (const key of ["read", "write", "net", "env"] as const) {
    const base = manifest.permissions[key] ?? [];
    const over = override[key] ?? [];
    if (over.length > 0) {
      effectivePerms[key] = base.filter((p) => over.includes(p));
      if (effectivePerms[key]!.length === 0 && over.length > 0) {
        effectivePerms[key] = over;
      }
    } else if (base.length > 0) {
      effectivePerms[key] = base;
    }
  }

  const { granted, denied } = resolvePermissions(
    effectivePerms,
    options?.policy,
  );
  const entrypoint = resolveSkillEntrypoint(skillDir, manifest);

  const record = await runModuleInSandbox(
    runId,
    entrypoint,
    input,
    granted,
    effectivePerms,
    denied,
    "skill",
    options?.policy,
  );

  record.skill_path = skillDir;
  record.project_path = options?.projectPath;
  record.schema_hash = await hashManifest(manifest);

  // Auto-approve after successful execution (client-side Elicitation already handled)
  if (record.exit_code === 0) {
    await approveSkill(skillDir).catch(() => {});
  }

  return { record };
}

async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return Array.from(new Uint8Array(hash)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}
