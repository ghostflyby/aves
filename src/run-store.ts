import type { RunRecord } from "./types.ts";

// ============================================================
// Database Worker communication
// ============================================================

let _worker: Worker | null = null;
let _nextId = 0;

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
            read: true,
            write: true,
            env: true,
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
  schema_hash?: string;
  has_schema?: boolean;
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

export async function findClusteredRuns(): Promise<{
  schema_hash: string;
  count: number;
  runs: RunRecord[];
}[]> {
  return await callWorker("findClusteredRuns");
}

export async function findRepeatedRuns(): Promise<{
  code_hash: string;
  count: number;
  runs: RunRecord[];
}[]> {
  return await callWorker("findRepeatedRuns");
}

// ============================================================
// Skill approvals
// ============================================================

export interface SkillApproval {
  skillPath: string;
  manifestHash: string;
  contentHash?: string;
  approvedAt: string;
  requiresApproval: boolean;
}

export async function saveSkillApproval(
  approval: SkillApproval,
): Promise<void> {
  await callWorker("saveSkillApproval", approval);
}

export async function loadSkillApproval(
  skillPath: string,
): Promise<SkillApproval | null> {
  return await callWorker<SkillApproval | null>("loadSkillApproval", skillPath);
}

export async function removeSkillApproval(skillPath: string): Promise<void> {
  await callWorker("removeSkillApproval", skillPath);
}
