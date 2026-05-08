import {generateBootWrapper} from "./boot.ts";
import type {ServerPolicy} from "./policy.ts";
import {resolvePermissions} from "./policy.ts";
import type {Permissions, RunRecord, RunRequest} from "./types.ts";

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

/**
 * Merge two permission sets, deduplicating path lists per key.
 */
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
    if (merged.length > 0) {
      result[key] = merged;
    }
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

  // 1. Create run directory
  await Deno.mkdir(runDir, { recursive: true });

  // 2. Write boot.ts
  const bootCode = generateBootWrapper();
  await Deno.writeTextFile(`${runDir}/boot.ts`, bootCode);

  // 3. Write user_module.ts
  if (request.mode === "eval" && request.code) {
    await Deno.writeTextFile(`${runDir}/user_module.ts`, request.code);
  } else if (request.mode === "module" && request.modulePath) {
    const resolvedPath = await Deno.realPath(request.modulePath);
    await Deno.writeTextFile(
      `${runDir}/user_module.ts`,
      `export { default } from "${resolvedPath}";\nexport { inputSchema } from "${resolvedPath}";\n`,
    );
  } else {
    throw new Error(
      `Invalid request: mode=${request.mode}, code or modulePath missing`,
    );
  }

  // 4. Write input.json
  const inputData = request.input ?? {};
  await Deno.writeTextFile(`${runDir}/input.json`, JSON.stringify(inputData));

  // 5. Resolve permissions through policy
  const userPerms = request.permissions ?? {};
  const policy = options?.policy;
  const {granted, denied} = resolvePermissions(userPerms, policy);

  // The boot wrapper needs at minimum read/write access to its own run directory.
  // Resolve realpath so /tmp and /private/tmp don't confuse the flags.
  const realRunDir = await Deno.realPath(runDir);
  const runDirPerms: Permissions = {read: [realRunDir], write: [realRunDir]};

  // Merge granted permissions with the run-directory perms.
  const mergedPerms = mergePermissions(granted, runDirPerms);

  // Hard-block run/ffi — strip them even if someone sneaks them in.
  const safePerms: Permissions = {};
  for (const [key, paths] of Object.entries(mergedPerms)) {
    if (key !== "run" && key !== "ffi" && paths) {
      safePerms[key as keyof Permissions] = paths;
    }
  }

  const permFlags = buildPermissionFlags(safePerms);

  const args = [
    "run",
    "--no-prompt",
    ...permFlags,
    "boot.ts",
  ];

  // 6. Compute code hash
  const codeHash = request.code ? await sha256Hex(request.code) : undefined;

  // 7. Spawn deno
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

  // 8. Read output
  let output: unknown = null;
  let error: string | undefined;
  try {
    const outputText = await Deno.readTextFile(`${runDir}/output.json`);
    const parsed = JSON.parse(outputText);
    if (parsed.ok) {
      output = parsed.data;
    } else {
      error = parsed.error;
    }
  } catch {
    if (exitCode !== 0 && !error) {
      error = stderr || "Process exited with non-zero code";
    }
  }

  // 9. Cleanup
  try {
    await Deno.remove(runDir, { recursive: true });
  } catch {
    // best-effort
  }

  return {
    run_id: runId,
    mode: request.mode,
    code_hash: codeHash,
    raw_input: request.input,
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

async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
