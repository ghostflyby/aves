import type { RunRecord } from "./types.ts";
import { getAvesDataDir } from "./paths.ts";

// ============================================================
// Database Worker communication
// ============================================================

let _worker: Worker | null = null;
let _nextId = 0;

function getProjectRoot(): string {
  return new URL("../../", import.meta.url).pathname;
}

function getWorkerUrl(): string {
  return new URL("./db-worker.ts", import.meta.url).href;
}

function callWorker<T>(op: string, ...args: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!_worker) {
      _worker = new Worker(getWorkerUrl(), {
        type: "module",
        deno: {
          permissions: {
            read: [getProjectRoot(), getAvesDataDir()],
            write: [getAvesDataDir()],
            env: ["AVES_DATA_DIR", "XDG_DATA_HOME", "LocalAppData"],
            sys: ["homedir"],
          },
        },
      });
    }

    const id = _nextId++;
    const handler = (e: MessageEvent) => {
      if (e.data.id !== id) return;
      _worker!.removeEventListener("message", handler);
      if (e.data.ok) resolve(e.data.result as T);
      else reject(new Error(e.data.error));
    };
    _worker.addEventListener("message", handler);
    _worker.postMessage({ id, op, args });
  });
}

export function closeDb(): void {
  if (_worker) {
    _worker.terminate();
    _worker = null;
  }
}

// ============================================================
// Run records
// ============================================================

export async function saveRun(record: RunRecord): Promise<void> {
  await callWorker("saveRun", record);
}

export async function loadRun(runId: string): Promise<RunRecord | null> {
  return await callWorker<RunRecord | null>("loadRun", runId);
}

export async function listRuns(): Promise<RunRecord[]> {
  return await callWorker<RunRecord[]>("listRuns");
}

export interface RunFilters {
  mode?: string;
  exit_code?: number;
  started_after?: string;
  started_before?: string;
  limit: number;
  offset: number;
  order_by: string;
  order_dir: string;
}

export async function listRunsFiltered(
  filters: RunFilters,
): Promise<RunRecord[]> {
  return await callWorker<RunRecord[]>("listRunsFiltered", filters);
}

// ============================================================
// Script approvals (hash-based trust for eval/module runs)
// ============================================================

export interface ScriptApproval {
  codeHash: string;
  approvedAt: string;
  permissions: Record<string, string[]>;
}

export async function saveScriptApproval(
  approval: ScriptApproval,
): Promise<void> {
  await callWorker("saveScriptApproval", approval);
}

export async function loadScriptApproval(
  codeHash: string,
): Promise<ScriptApproval | null> {
  return await callWorker<ScriptApproval | null>(
    "loadScriptApproval",
    codeHash,
  );
}

// ============================================================
// Permission approvals (skill permission module trust)
// ============================================================

export interface PermissionApproval {
  skillDir: string;
  permissionHash: string;
  approvedAt: string;
}

export async function savePermissionApproval(
  approval: PermissionApproval,
): Promise<void> {
  await callWorker("savePermissionApproval", approval);
}

export async function loadPermissionApproval(
  skillDir: string,
): Promise<PermissionApproval | null> {
  return await callWorker<PermissionApproval | null>(
    "loadPermissionApproval",
    skillDir,
  );
}

export async function removeScriptApproval(codeHash: string): Promise<void> {
  await callWorker("removeScriptApproval", codeHash);
}
