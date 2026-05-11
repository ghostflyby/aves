// Aves database worker — runs inside a Deno Worker.
// Provides all database operations (read + write) for run-store.ts.
// Keeps a single DatabaseSync connection alive for reuse.
// WAL mode allows concurrent readers from query-pool.ts.

import { DatabaseSync } from "node:sqlite";
import { getAvesDbPath } from "./paths.ts";
import { PERMISSION_APPROVALS_TABLE_DDL, RUNS_TABLE_DDL } from "./db-schema.ts";

// ============================================================
// Database initialization
// ============================================================

const db = new DatabaseSync(getAvesDbPath());

db.exec("PRAGMA journal_mode=WAL");

db.exec(RUNS_TABLE_DDL);
try {
  db.exec(PERMISSION_APPROVALS_TABLE_DDL);
} catch {
  // DB may be read-only
}

db.exec("CREATE INDEX IF NOT EXISTS idx_runs_mode ON runs(mode)");
db.exec("CREATE INDEX IF NOT EXISTS idx_runs_code_hash ON runs(code_hash)");
db.exec("CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at)");

// ============================================================
// Row serialization helpers
// ============================================================

function rowToRecord(row: Record<string, unknown>): Record<string, unknown> {
  return {
    run_id: row.run_id as string,
    mode: row.mode as string,
    code_hash: row.code_hash as string | undefined,
    started_at: row.started_at as string,
    exit_code: row.exit_code as number | null,
    finished_at: row.finished_at as string,
    duration_ms: row.duration_ms as number,
    code: row.code as string | undefined,
  };
}

// ============================================================
// Operation handlers
// ============================================================

const handlers: Record<string, (...args: unknown[]) => unknown> = {
  saveRun(...recordArr: unknown[]) {
    const r = recordArr[0] as Record<string, unknown>;
    db.prepare(`INSERT OR REPLACE INTO runs
      (run_id, mode, code_hash, exit_code,
       started_at, finished_at, duration_ms, code)
      VALUES (?,?,?,?, ?,?,?,?)`).run(
      r.run_id,
      r.mode,
      r.code_hash ?? null,
      r.exit_code,
      r.started_at,
      r.finished_at,
      r.duration_ms,
      r.code ?? null,
    );
    return null;
  },

  loadRun(...runIdArr: unknown[]) {
    const runId = runIdArr[0] as string;
    const row = db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToRecord(row) : null;
  },

  listRuns() {
    return (db.prepare("SELECT * FROM runs ORDER BY started_at DESC")
      .all() as Record<string, unknown>[]).map(rowToRecord);
  },

  listRunsFiltered(...filtersArr: unknown[]) {
    // deno-lint-ignore no-explicit-any
    const f = filtersArr[0] as any;
    const where: string[] = [];
    // deno-lint-ignore no-explicit-any
    const values: any[] = [];

    if (f.mode !== undefined) {
      where.push("mode = ?");
      values.push(f.mode as string);
    }
    if (f.exit_code !== undefined) {
      where.push("exit_code = ?");
      values.push(f.exit_code as number);
    }
    if (f.started_after !== undefined) {
      where.push("started_at >= ?");
      values.push(f.started_after as string);
    }
    if (f.started_before !== undefined) {
      where.push("started_at < ?");
      values.push(f.started_before as string);
    }

    const orderCol = (f.order_by as string) || "started_at";
    const orderDir = f.order_dir === "asc" ? "ASC" : "DESC";
    const baseSql = "SELECT * FROM runs";
    const orderSql = `ORDER BY ${orderCol} ${orderDir}`;
    const limitSql = "LIMIT ? OFFSET ?";
    const sql = where.length > 0
      ? `${baseSql} WHERE ${where.join(" AND ")} ${orderSql} ${limitSql}`
      : `${baseSql} ${orderSql} ${limitSql}`;

    return (db.prepare(sql).all(
      ...values,
      f.limit ?? 100,
      f.offset ?? 0,
    )).map(rowToRecord);
  },

  savePermissionApproval(...approvalArr: unknown[]) {
    const a = approvalArr[0] as Record<string, string>;
    db.prepare(
      "INSERT OR REPLACE INTO permission_approvals (skill_dir, permission_hash, approved_at) VALUES (?, ?, ?)",
    ).run(a.skillDir, a.permissionHash, a.approvedAt);
    return null;
  },

  loadPermissionApproval(...skillDirArr: unknown[]) {
    const skillDir = skillDirArr[0] as string;
    const row = db.prepare(
      "SELECT permission_hash, approved_at FROM permission_approvals WHERE skill_dir = ?",
    ).get(skillDir) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      skillDir,
      permissionHash: row.permission_hash as string,
      approvedAt: row.approved_at as string,
    };
  },
};

// ============================================================
// Message dispatch
// ============================================================

// deno-lint-ignore no-explicit-any
const ctx = self as any;
// deno-lint-ignore no-explicit-any
ctx.onmessage = (e: any) => {
  const { id, op, args } = e.data;
  try {
    const handler = handlers[op];
    if (!handler) {
      ctx.postMessage({ id, ok: false, error: `Unknown op: ${op}` });
      return;
    }
    const result = handler(...(args ?? []));
    ctx.postMessage({ id, ok: true, result });
  } catch (err) {
    ctx.postMessage({
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
