import { DatabaseSync } from "node:sqlite";
import type { RunRecord } from "./types.ts";
import { getAvesDbPath } from "./paths.ts";

// ============================================================
// Database initialization — synchronous, WAL mode, no migration
// ============================================================

let _db: DatabaseSync | null = null;

function getDb(): DatabaseSync {
  if (_db) return _db;

  Deno.mkdirSync(getAvesDbPath().replace(/\/[^/]+$/, ""), { recursive: true });

  _db = new DatabaseSync(getAvesDbPath());
  _db.exec("PRAGMA journal_mode=WAL");

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
      input_schema_json TEXT,
      code TEXT
    )
  `);

  // Migrate: add new columns if missing
  for (const col of ["input_schema_json TEXT", "code TEXT"]) {
    try {
      _db.exec(`ALTER TABLE runs ADD COLUMN ${col}`);
    } catch {
      // Column already exists
    }
  }

  _db.exec(`
    CREATE TABLE IF NOT EXISTS skill_approvals (
      skill_path TEXT PRIMARY KEY,
      manifest_hash TEXT NOT NULL,
      content_hash TEXT,
      approved_at TEXT NOT NULL,
      requires_approval BOOLEAN DEFAULT true
    )
  `);

  try {
    _db.exec("ALTER TABLE skill_approvals ADD COLUMN content_hash TEXT");
  } catch {
    // Column already exists
  }

  _db.exec("CREATE INDEX IF NOT EXISTS idx_runs_mode ON runs(mode)");
  _db.exec("CREATE INDEX IF NOT EXISTS idx_runs_code_hash ON runs(code_hash)");
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_runs_schema_hash ON runs(schema_hash)",
  );
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at)",
  );
  _db.exec(
    "CREATE INDEX IF NOT EXISTS idx_runs_project_path ON runs(project_path)",
  );

  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ============================================================
// Serialization helpers
// ============================================================

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
    stdout: (row.stdout as string) ?? "",
    stderr: (row.stderr as string) ?? "",
    exit_code: row.exit_code as number | null,
    output: fromJson(row.output),
    error: row.error as string | undefined,
    started_at: row.started_at as string,
    finished_at: row.finished_at as string,
    duration_ms: row.duration_ms as number,
    project_path: row.project_path as string | undefined,
    promoted_to_skill: row.promoted_to_skill as string | undefined,
    skill_path: row.skill_path as string | undefined,
    input_schema_json: fromJson(row.input_schema_json),
    code: row.code as string | undefined,
  };
}

// ============================================================
// Runs CRUD
// ============================================================

export function saveRun(record: RunRecord): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO runs
      (run_id, mode, code_hash, schema_hash,
       raw_input, parsed_input, permissions, granted_permissions, denied_permissions,
       stdout, stderr, exit_code, output, error,
       started_at, finished_at, duration_ms,
       project_path, promoted_to_skill, skill_path
       , input_schema_json, code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
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
    toJson(record.input_schema_json),
    record.code ?? null,
  );
}

export function loadRun(runId: string): RunRecord | null {
  const row = getDb().prepare(
    "SELECT * FROM runs WHERE run_id = ?",
  ).get(runId) as Record<string, unknown> | undefined;
  return row ? rowToRecord(row) : null;
}

export function listRuns(): RunRecord[] {
  return (getDb().prepare(
    "SELECT * FROM runs ORDER BY started_at DESC",
  ).all() as Record<string, unknown>[]).map(rowToRecord);
}

/**
 * Find runs grouped by schema_hash (same Zod input schema structure).
 * Clusters of 2+ runs are skill candidates for promotion.
 */
export function findClusteredRuns(): {
  schema_hash: string;
  count: number;
  runs: RunRecord[];
}[] {
  const db = getDb();
  const groups = db.prepare(`
    SELECT schema_hash, COUNT(*) as count
    FROM runs WHERE schema_hash IS NOT NULL
    GROUP BY schema_hash HAVING count > 1
    ORDER BY count DESC
  `).all() as { schema_hash: string; count: number }[];

  return groups.map((g) => ({
    schema_hash: g.schema_hash,
    count: g.count,
    runs: (db.prepare(
      "SELECT * FROM runs WHERE schema_hash = ? ORDER BY started_at DESC",
    ).all(g.schema_hash) as Record<string, unknown>[]).map(rowToRecord),
  }));
}

/**
 * Find runs grouped by code_hash (same source code).
 */
export function findRepeatedRuns(): {
  code_hash: string;
  count: number;
  runs: RunRecord[];
}[] {
  const db = getDb();
  const groups = db.prepare(`
    SELECT code_hash, COUNT(*) as count
    FROM runs WHERE code_hash IS NOT NULL
    GROUP BY code_hash HAVING count > 1
    ORDER BY count DESC
  `).all() as { code_hash: string; count: number }[];

  return groups.map((g) => ({
    code_hash: g.code_hash,
    count: g.count,
    runs: (db.prepare(
      "SELECT * FROM runs WHERE code_hash = ? ORDER BY started_at DESC",
    ).all(g.code_hash) as Record<string, unknown>[]).map(rowToRecord),
  }));
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

export function saveSkillApproval(approval: SkillApproval): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO skill_approvals
      (skill_path, manifest_hash, content_hash, approved_at, requires_approval)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    approval.skillPath,
    approval.manifestHash,
    approval.contentHash ?? null,
    approval.approvedAt,
    approval.requiresApproval ? 1 : 0,
  );
}

export function loadSkillApproval(
  skillPath: string,
): SkillApproval | null {
  const row = getDb().prepare(
    "SELECT * FROM skill_approvals WHERE skill_path = ?",
  ).get(skillPath) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    skillPath: row.skill_path as string,
    manifestHash: row.manifest_hash as string,
    contentHash: row.content_hash as string | undefined,
    approvedAt: row.approved_at as string,
    requiresApproval: (row.requires_approval as number) === 1,
  };
}

export function removeSkillApproval(skillPath: string): void {
  getDb().prepare(
    "DELETE FROM skill_approvals WHERE skill_path = ?",
  ).run(skillPath);
}
