export type ScriptMode = "eval" | "module" | "skill";

export interface Permissions {
  read?: string[];
  write?: string[];
  net?: string[];
  env?: string[];
}

export interface RunRequest {
  mode: ScriptMode;
  code?: string;
  modulePath?: string;
  input?: Record<string, unknown>;
  permissions?: Permissions;
}

export interface RunRecord {
  run_id: string;
  mode: ScriptMode;
  code_hash?: string;
  schema_hash?: string;
  raw_input?: Record<string, unknown>;
  parsed_input?: Record<string, unknown>;
  permissions: Permissions;
  granted_permissions: Permissions;
  denied_permissions?: string[];
  stdout: string;
  stderr: string;
  exit_code: number | null;
  output: unknown;
  error?: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
}

export interface SkillManifest {
  name: string;
  description: string;
  permissions: Permissions;
  input_schema?: Record<string, unknown>;
}

export interface RunContext {
  runDir: string;
  inputFile: string;
  outputFile: string;
  bootFile: string;
  moduleFile: string;
}
