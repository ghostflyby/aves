import type { RunRecord } from "./types.ts";

/**
 * Aves state directory.
 * Uses XDG-compatible path within the temp directory for sandbox compatibility.
 */
export const AVES_STATE_DIR = "/tmp/aves/state";
export const RUNS_DIR = `${AVES_STATE_DIR}/runs`;

export async function saveRun(record: RunRecord): Promise<void> {
  await Deno.mkdir(RUNS_DIR, { recursive: true });
  const path = `${RUNS_DIR}/${record.run_id}.json`;
  await Deno.writeTextFile(path, JSON.stringify(record, null, 2));
}

export async function loadRun(runId: string): Promise<RunRecord | null> {
  try {
    const path = `${RUNS_DIR}/${runId}.json`;
    const text = await Deno.readTextFile(path);
    return JSON.parse(text) as RunRecord;
  } catch {
    return null;
  }
}

export async function listRuns(): Promise<RunRecord[]> {
  try {
    const records: RunRecord[] = [];
    for await (const entry of Deno.readDir(RUNS_DIR)) {
      if (entry.isFile && entry.name.endsWith(".json")) {
        const text = await Deno.readTextFile(`${RUNS_DIR}/${entry.name}`);
        records.push(JSON.parse(text) as RunRecord);
      }
    }
    return records.sort((a, b) =>
      new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
    );
  } catch {
    return [];
  }
}
