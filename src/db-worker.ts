// Aves database worker — runs inside a Deno Worker.
// Provides all database operations (read + write) for run-store.ts.
// Keeps a single DatabaseSync connection alive for reuse.
// WAL mode allows concurrent readers from query-pool.ts.

import { DatabaseSync } from "node:sqlite";
import { getAvesDbPath } from "./paths.ts";
import { RUNS_TABLE_DDL, SCRIPT_APPROVALS_TABLE_DDL } from "./db-schema.ts";

// ============================================================
// Database initialization
// ============================================================

const db = new DatabaseSync(getAvesDbPath());
db.exec("PRAGMA journal_mode=WAL");

db.exec(RUNS_TABLE_DDL);
try {
  db.exec(SCRIPT_APPROVALS_TABLE_DDL);
} catch {
  // DB may be read-only (e.g., test environment)
}

// Migrate: add new columns if missing
for (const col of ["input_schema_json TEXT", "code TEXT"]) {
  try {
    db.exec(`ALTER TABLE runs
            ADD COLUMN ${col}`);
  } catch {
    // Column already exists
  }
}

db.exec(`
    CREATE TABLE IF NOT EXISTS skill_approvals
    (
        skill_path        TEXT PRIMARY KEY,
        manifest_hash     TEXT NOT NULL,
        content_hash      TEXT,
        approved_at       TEXT NOT NULL,
        requires_approval BOOLEAN DEFAULT true
    )
`);

db.exec("CREATE INDEX IF NOT EXISTS idx_runs_mode ON runs(mode)");
db.exec("CREATE INDEX IF NOT EXISTS idx_runs_code_hash ON runs(code_hash)");
db.exec("CREATE INDEX IF NOT EXISTS idx_runs_schema_hash ON runs(schema_hash)");
db.exec("CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at)");
db.exec(
  "CREATE INDEX IF NOT EXISTS idx_runs_project_path ON runs(project_path)",
);

// ============================================================
// Row serialization helpers
// ============================================================

function toJson(val: unknown): string | null {
  if (val === undefined || val === null) return null;
  return typeof val === "string" ? val : JSON.stringify(val);
}

function fromJson(val: unknown): unknown {
  if (val === null || val === undefined) return undefined;
  if (typeof val === "string") {
    try {
      return JSON.parse(val);
    } catch {
      return val;
    }
  }
  return val;
}

function rowToRecord(row: Record<string, unknown>): Record<string, unknown> {
  return {
    run_id: row.run_id as string,
    mode: row.mode as string,
    code_hash: row.code_hash as string | undefined,
    schema_hash: row.schema_hash as string | undefined,
    raw_input: fromJson(row.raw_input) as Record<string, unknown> | undefined,
    parsed_input: fromJson(row.parsed_input) as
      | Record<string, unknown>
      | undefined,
    permissions: fromJson(row.permissions) as Record<string, string[]>,
    granted_permissions: fromJson(row.granted_permissions) as Record<
      string,
      string[]
    >,
    denied_permissions: fromJson(row.denied_permissions) as
      | string[]
      | undefined,
    stdout: row.stdout as string,
    stderr: row.stderr as string,
    exit_code: row.exit_code as number | null,
    output: fromJson(row.output),
    error: row.error as string | undefined,
    started_at: row.started_at as string,
    finished_at: row.finished_at as string,
    duration_ms: row.duration_ms as number,
    project_path: row.project_path as string | undefined,
    promoted_to_skill: row.promoted_to_skill as string | undefined,
    skill_path: row.skill_path as string | undefined,
    input_schema_json: fromJson(row.input_schema_json) as
      | Record<string, unknown>
      | undefined,
    code: row.code as string | undefined,
  };
}

// ============================================================
// Operation handlers
// ============================================================

const handlers: Record<string, (...args: unknown[]) => unknown> = {
  saveRun(...recordArr: unknown[]) {
    const r = recordArr[0] as Record<string, unknown>;
    db.prepare(`INSERT OR
REPLACE INTO runs
(run_id, mode, code_hash, schema_hash,
 raw_input, parsed_input, permissions, granted_permissions, denied_permissions,
 stdout, stderr, exit_code, output, error,
 started_at, finished_at, duration_ms,
 project_path, promoted_to_skill, skill_path,
 input_schema_json, code)
VALUES (?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?)
    `).run(
      r.run_id,
      r.mode,
      r.code_hash ?? null,
      r.schema_hash ?? null,
      toJson(r.raw_input),
      toJson(r.parsed_input),
      toJson(r.permissions),
      toJson(r.granted_permissions),
      toJson(r.denied_permissions),
      r.stdout ?? "",
      r.stderr ?? "",
      r.exit_code,
      toJson(r.output),
      r.error ?? null,
      r.started_at,
      r.finished_at,
      r.duration_ms,
      r.project_path ?? null,
      r.promoted_to_skill ?? null,
      r.skill_path ?? null,
      toJson(r.input_schema_json),
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
    if (f.schema_hash !== undefined) {
      where.push("schema_hash = ?");
      values.push(f.schema_hash as string);
    }
    if (f.has_schema !== undefined) {
      where.push(
        f.has_schema ? "schema_hash IS NOT NULL" : "schema_hash IS NULL",
      );
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
  saveSkillApproval(...approvalArr: unknown[]) {
    // deno-lint-ignore no-explicit-any
    const a = approvalArr[0] as any;
    db.prepare(`
            INSERT OR
            REPLACE
            INTO skill_approvals
            (skill_path, manifest_hash, content_hash, approved_at, requires_approval)
            VALUES (?, ?, ?, ?, ?)
        `).run(
      a.skillPath,
      a.manifestHash,
      a.contentHash ?? null,
      a.approvedAt,
      a.requiresApproval ? 1 : 0,
    );
    return null;
  },

  loadSkillApproval(...skillPathArr: unknown[]) {
    const skillPath = skillPathArr[0] as string;
    const row = db.prepare("SELECT * FROM skill_approvals WHERE skill_path = ?")
      .get(skillPath) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      skillPath: row.skill_path as string,
      manifestHash: row.manifest_hash as string,
      contentHash: row.content_hash as string | undefined,
      approvedAt: row.approved_at as string,
      requiresApproval: (row.requires_approval as number) === 1,
    };
  },

  removeSkillApproval(...skillPathArr: unknown[]) {
    const skillPath = skillPathArr[0] as string;
    db.prepare("DELETE FROM skill_approvals WHERE skill_path = ?").run(
      skillPath,
    );
    return null;
  },

  saveScriptApproval(...approvalArr: unknown[]) {
    const approval = approvalArr[0] as {
      codeHash: string;
      approvedAt: string;
      permissions: Record<string, string[]>;
    };
    db.prepare(
      `INSERT OR REPLACE INTO script_approvals (code_hash, approved_at, permissions_json) VALUES (?, ?, ?)`,
    ).run(
      approval.codeHash,
      approval.approvedAt,
      JSON.stringify(approval.permissions),
    );
    return null;
  },

  loadScriptApproval(...codeHashArr: unknown[]) {
    const codeHash = codeHashArr[0] as string;
    const row = db.prepare(
      "SELECT code_hash, approved_at, permissions_json FROM script_approvals WHERE code_hash = ?",
    ).get(codeHash) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      codeHash: row.code_hash as string,
      approvedAt: row.approved_at as string,
      permissions: JSON.parse(row.permissions_json as string) as Record<
        string,
        string[]
      >,
    };
  },

  removeScriptApproval(...codeHashArr: unknown[]) {
    const codeHash = codeHashArr[0] as string;
    db.prepare("DELETE FROM script_approvals WHERE code_hash = ?").run(
      codeHash,
    );
    return null;
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
