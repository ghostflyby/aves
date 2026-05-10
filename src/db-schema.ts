// Shared SQLite schema constants.
// Imported by both the db-worker and the MCP server (for tool descriptions).
// No side effects — safe to import anywhere.

export const RUNS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS runs
(
    run_id              TEXT PRIMARY KEY, -- UUID v4
    mode                TEXT    NOT NULL, -- 'eval' | 'module' | 'skill'
    code_hash           TEXT,             -- SHA-256 hex of code
    schema_hash         TEXT,             -- SHA-256 hex of inputSchema
    raw_input           TEXT,             -- JSON
    parsed_input        TEXT,             -- JSON (after Zod parse)
    permissions         TEXT,             -- JSON {key: string[]}
    granted_permissions TEXT,             -- JSON {key: string[]}
    denied_permissions  TEXT,             -- JSON string[]
    stdout              TEXT,             -- plain text
    stderr              TEXT,             -- plain text
    exit_code           INTEGER,          -- process exit code
    output              TEXT,             -- JSON
    error               TEXT,             -- plain text
    started_at          TEXT    NOT NULL, -- ISO 8601 timestamp
    finished_at         TEXT    NOT NULL, -- ISO 8601 timestamp
    duration_ms         INTEGER NOT NULL, -- milliseconds
    project_path        TEXT,             -- absolute path
    promoted_to_skill   TEXT,             -- 'true' | null
    skill_path          TEXT,             -- absolute path
    input_schema_json   TEXT,             -- JSON (JSON Schema)
    code                TEXT              -- TypeScript source
)`;

export const SCRIPT_APPROVALS_TABLE_DDL =
  `CREATE TABLE IF NOT EXISTS script_approvals
(
    code_hash        TEXT PRIMARY KEY, -- SHA-256 hex of code
    approved_at      TEXT NOT NULL,    -- ISO 8601 timestamp
    permissions_json TEXT NOT NULL     -- JSON {read?: string[], write?: string[], net?: string[], env?: string[]}
)`;

export const PERMISSION_APPROVALS_TABLE_DDL =
  `CREATE TABLE IF NOT EXISTS permission_approvals
(
    skill_dir        TEXT PRIMARY KEY,
    permission_hash  TEXT NOT NULL,
    approved_at      TEXT NOT NULL
  )`;
