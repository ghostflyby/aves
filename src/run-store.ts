import { Database } from "@db/sqlite";
import type { RunRecord } from "./types.ts";
import { getAvesDbPath } from "./paths.ts";

let _db: Database | null = null;

function getDb(): Database {
  if (!_db) {
    Deno.mkdirSync(getAvesDbPath().replace(/\/[^/]+$/, ""), {
      recursive: true,
    });
    _db = new Database(getAvesDbPath());
    _db.exec("PRAGMA journal_mode=WAL");

    // Core runs table
    _db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        code_hash TEXT,
        schema_hash TEXT,
        raw_input TEXT,
        parsed_input TEXT,
        permissions TEXT,
        granted_permissions TEXT,
        denied_permissions TEXT,
        stdout TEXT,
        stderr TEXT,
        exit_code INTEGER,
        output TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        project_path TEXT,
        promoted_to_skill TEXT,
        skill_path TEXT
      )
    `);

    // Migrate existing tables if needed
    migrateColumns(_db, "runs", ["project_path", "promoted_to_skill", "skill_path"]);

    // Skill approvals table
    _db.exec(`
      CREATE TABLE IF NOT EXISTS skill_approvals (
        skill_path TEXT PRIMARY KEY,
        manifest_hash TEXT NOT NULL,
        approved_at TEXT NOT NULL,
        requires_approval BOOLEAN DEFAULT true
      )
    `);

    // Indexes
    _db.exec(
      "CREATE INDEX IF NOT EXISTS idx_runs_mode ON runs(mode)",
    );
    _db.exec(
      "CREATE INDEX IF NOT EXISTS idx_runs_code_hash ON runs(code_hash)",
    );
    _db.exec(
      "CREATE INDEX IF NOT EXISTS idx_runs_schema_hash ON runs(schema_hash)",
    );
    _db.exec(
      "CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at)",
    );
    _db.exec(
      "CREATE INDEX IF NOT EXISTS idx_runs_project_path ON runs(project_path)",
    );
  }
  return _db;
}

/**
 * Migrate columns: add missing columns to an existing table.
 */
function migrateColumns(db: Database, table: string, columns: string[]): void {
  const existing = new Set<string>();
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  for (const row of rows) {
    existing.add(row.name);
  }
  for (const col of columns) {
    if (!existing.has(col)) {
      try {
        // Infer type from column name patterns
        const colType = col.endsWith("_ms") ? "INTEGER" : "TEXT";
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${colType}`);
      } catch {
        // Ignore if already exists or unsupported
      }
    }
  }
}

function toJson(val: unknown): string | null {
  return val !== undefined ? JSON.stringify(val) : null;
}

function fromJson<T>(val: unknown): T | undefined {
  if (val === null || val === undefined) return undefined;
  try {
    return JSON.parse(val as string) as T;
  } catch {
    return undefined;
  }
}

function rowToRecord(row: Record<string, unknown>): RunRecord {
  return {
    run_id: row.run_id as string,
    mode: row.mode as RunRecord["mode"],
    code_hash: row.code_hash as string | undefined,
    schema_hash: row.schema_hash as string | undefined,
    raw_input: fromJson(row.raw_input),
    parsed_input: fromJson(row.parsed_input),
    permissions: fromJson(row.permissions) ?? {},
    granted_permissions: fromJson(row.granted_permissions) ?? {},
    denied_permissions: fromJson(row.denied_permissions),
    stdout: row.stdout as string ?? "",
    stderr: row.stderr as string ?? "",
    exit_code: row.exit_code as number | null,
    output: fromJson(row.output),
    error: row.error as string | undefined,
    started_at: row.started_at as string,
    finished_at: row.finished_at as string,
    duration_ms: row.duration_ms as number,
    project_path: row.project_path as string | undefined,
    promoted_to_skill: row.promoted_to_skill as string | undefined,
    skill_path: row.skill_path as string | undefined,
  };
}

export async function saveRun(record: RunRecord): Promise<void> {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO runs
      (run_id, mode, code_hash, schema_hash,
       raw_input, parsed_input, permissions, granted_permissions, denied_permissions,
       stdout, stderr, exit_code, output, error,
       started_at, finished_at, duration_ms,
       project_path, promoted_to_skill, skill_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run([
    record.run_id,
    record.mode,
    record.code_hash ?? null,
    record.schema_hash ?? null,
    toJson(record.raw_input),
    toJson(record.parsed_input),
    toJson(record.permissions),
    toJson(record.granted_permissions),
    toJson(record.denied_permissions),
    record.stdout,
    record.stderr,
    record.exit_code,
    toJson(record.output),
    record.error ?? null,
    record.started_at,
    record.finished_at,
    record.duration_ms,
    record.project_path ?? null,
    record.promoted_to_skill ?? null,
    record.skill_path ?? null,
  ]);
}

export async function loadRun(runId: string): Promise<RunRecord | null> {
  const db = getDb();
  const row = db.prepare("SELECT * FROM runs WHERE run_id = ?").get([runId]) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return rowToRecord(row);
}

export async function listRuns(): Promise<RunRecord[]> {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM runs ORDER BY started_at DESC",
  ).iter() as Iterable<Record<string, unknown>>;
  return Array.from(rows).map(rowToRecord);
}

/**
 * Find runs that share the same schema hash — potential skill candidates.
 */
export async function findClusteredRuns(): Promise<
  { schema_hash: string; count: number; runs: RunRecord[] }[]
> {
  const db = getDb();
  const groups = db.prepare(
    `SELECT schema_hash, COUNT(*) as count
     FROM runs WHERE schema_hash IS NOT NULL
     GROUP BY schema_hash HAVING count > 1
     ORDER BY count DESC`,
  ).all() as { schema_hash: string; count: number }[];

  const result: { schema_hash: string; count: number; runs: RunRecord[] }[] = [];
  for (const g of groups) {
    const rows = db.prepare(
      "SELECT * FROM runs WHERE schema_hash = ? ORDER BY started_at DESC",
    ).iter([g.schema_hash]) as Iterable<Record<string, unknown>>;
    result.push({
      schema_hash: g.schema_hash,
      count: g.count,
      runs: Array.from(rows).map(rowToRecord),
    });
  }
  return result;
}

/**
 * Find runs that used the same code (same code_hash) — repeated usage clusters.
 */
export async function findRepeatedRuns(): Promise<
  { code_hash: string; count: number; runs: RunRecord[] }[]
> {
  const db = getDb();
  const groups = db.prepare(
    `SELECT code_hash, COUNT(*) as count
     FROM runs WHERE code_hash IS NOT NULL
     GROUP BY code_hash HAVING count > 1
     ORDER BY count DESC`,
  ).all() as { code_hash: string; count: number }[];

  const result: { code_hash: string; count: number; runs: RunRecord[] }[] = [];
  for (const g of groups) {
    const rows = db.prepare(
      "SELECT * FROM runs WHERE code_hash = ? ORDER BY started_at DESC",
    ).iter([g.code_hash]) as Iterable<Record<string, unknown>>;
    result.push({
      code_hash: g.code_hash,
      count: g.count,
      runs: Array.from(rows).map(rowToRecord),
    });
  }
  return result;
}

// ============================================================
// Skill approvals
// ============================================================

export interface SkillApproval {
  skillPath: string;
  manifestHash: string;
  approvedAt: string;
  requiresApproval: boolean;
}

export async function saveSkillApproval(approval: SkillApproval): Promise<void> {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO skill_approvals
      (skill_path, manifest_hash, approved_at, requires_approval)
    VALUES (?, ?, ?, ?)
  `).run([
    approval.skillPath,
    approval.manifestHash,
    approval.approvedAt,
    approval.requiresApproval ? 1 : 0,
  ]);
}

export async function loadSkillApproval(
  skillPath: string,
): Promise<SkillApproval | null> {
  const db = getDb();
  const row = db.prepare(
    "SELECT * FROM skill_approvals WHERE skill_path = ?",
  ).get([skillPath]) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    skillPath: row.skill_path as string,
    manifestHash: row.manifest_hash as string,
    approvedAt: row.approved_at as string,
    requiresApproval: (row.requires_approval as number) === 1,
  };
}

export async function removeSkillApproval(skillPath: string): Promise<void> {
  const db = getDb();
  db.prepare("DELETE FROM skill_approvals WHERE skill_path = ?").run([skillPath]);
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
