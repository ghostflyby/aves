import type { ServerPolicy } from "./policy.ts";
import { resolvePermissions } from "./policy.ts";
import type { Permissions, RunRecord, RunRequest } from "./types.ts";

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

export async function executeRun(
  request: RunRequest,
  options?: { policy?: ServerPolicy },
): Promise<RunRecord> {
  const runId = crypto.randomUUID();
  const runDir = `/tmp/aves/runs/${runId}`;
  const startedAt = new Date();
  const startedAtStr = startedAt.toISOString();

  await Deno.mkdir(runDir, { recursive: true });

  // Module resolution
  const isEval = request.mode === "eval" && !!request.code;

  if (isEval) {
    await Deno.writeTextFile(`${runDir}/user_module.ts`, request.code!);
  } else if (!request.modulePath) {
    throw new Error(
      `Invalid request: mode=${request.mode}, code or modulePath missing`,
    );
  }

  await Deno.writeTextFile(`${runDir}/input.json`, JSON.stringify(request.input ?? {}));

  // Resolve absolute paths
  const realRunDir = await Deno.realPath(runDir);
  const moduleArg = isEval
    ? `${realRunDir}/user_module.ts`
    : await Deno.realPath(request.modulePath!);
  const moduleReadPaths = isEval ? [] : [moduleArg];

  // Permissions
  const userPerms = request.permissions ?? {};
  const policy = options?.policy;
  const { granted, denied } = resolvePermissions(userPerms, policy);

  const runDirPerms: Permissions = {
    read: [realRunDir, BOOT_PATH, ...moduleReadPaths],
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

  // Spawn
  const args = ["run", "--no-prompt", ...permFlags, BOOT_PATH, moduleArg];
  const codeHash = request.code ? await sha256Hex(request.code) : undefined;

  const cmd = new Deno.Command("deno", {
    args, cwd: runDir, stdout: "piped", stderr: "piped",
  });

  const proc = cmd.outputSync();
  const finishedAt = new Date();
  const finishedAtStr = finishedAt.toISOString();
  const durationMs = finishedAt.getTime() - startedAt.getTime();

  const stdout = new TextDecoder().decode(proc.stdout);
  const stderr = new TextDecoder().decode(proc.stderr);
  const exitCode = proc.code;

  // Read output
  let output: unknown = null;
  let error: string | undefined;
  try {
    const outputText = await Deno.readTextFile(`${realRunDir}/output.json`);
    const parsed = JSON.parse(outputText);
    if (parsed.ok) output = parsed.data;
    else error = parsed.error;
  } catch {
    if (exitCode !== 0 && !error) error = stderr || "Process exited with non-zero code";
  }

  // Read optional metadata
  let parsedInput: Record<string, unknown> | undefined;
  let schemaHash: string | undefined;
  try {
    parsedInput = JSON.parse(await Deno.readTextFile(`${realRunDir}/parsed_input.json`));
  } catch { /* no-op */ }
  try {
    schemaHash = (await Deno.readTextFile(`${realRunDir}/schema_hash.txt`)).trim();
  } catch { /* no-op */ }

  // Cleanup
  try { await Deno.remove(runDir, { recursive: true }); } catch { /* best-effort */ }

  return {
    run_id: runId, mode: request.mode, code_hash: codeHash, schema_hash: schemaHash,
    raw_input: request.input, parsed_input: parsedInput,
    permissions: userPerms, granted_permissions: granted,
    denied_permissions: denied.length > 0 ? denied : undefined,
    stdout, stderr, exit_code: exitCode, output, error,
    started_at: startedAtStr, finished_at: finishedAtStr, duration_ms: durationMs,
  };
}

async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
