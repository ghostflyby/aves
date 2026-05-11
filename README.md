# Aves

MCP server for sandboxed Deno script execution with a **permission broker**.
Every filesystem, network, environment, and system permission request is
intercepted at runtime and routed to the user for approval — or handled silently
via cryptographic hash trust.

## How it works

```
Codex ──(MCP)──► Aves Server ──► Deno child process (DENO_PERMISSION_BROKER_PATH)
                      │                        │
                      │              ┌─────────▼──────────┐
                      │              │  Unix socket broker │
                      │              │  (newline-delimited │
                      │              │   JSON, v1 protocol)│
                      │              └─────────┬──────────┘
                      │                       │
                      │    ┌──────────────────▼──────────────────┐
                      │    │  elicit ──► MCP elicitation/create  │
                      └────┤  allow   ◄── user approves / denies │
                           └─────────────────────────────────────┘
```

Aves spawns each script in a child Deno process with
`DENO_PERMISSION_BROKER_PATH` pointing to a Unix socket. The broker receives
every permission check and applies the decision chain:

1. **Default-allowed** — temp dirs, safe sys calls, import domains → allow
2. **Run/module dirs** — the script's own working directory → allow
3. **Permission module** (skills only) — `mod.permission.ts` → allow/deny/null
4. **Hash trust** (skills only) — previously approved code hash → allow
5. **Elicit** — send MCP `elicitation/create` to the user → approve/deny

Codex sandbox state is received via `_meta["codex/sandbox-state-meta"]` and
shown as informational context, but **never enforces a hard boundary** — the
user always has the final say.

## Tools

| Tool               | Description                                                               |
| ------------------ | ------------------------------------------------------------------------- |
| `run_script`       | Execute inline TypeScript or a module path in a sandboxed Deno subprocess |
| `run_skill`        | Execute a skill by its directory path                                     |
| `replay_run`       | Replay a previous run by ID                                               |
| `list_runs`        | List recent run records with filtering                                    |
| `query_runs`       | Read-only SQL queries against the run database                            |
| `list_skills`      | List all discovered skills in configured roots                            |
| `suggest_skills`   | Find run clusters that look like skill candidates                         |
| `promote_to_skill` | Promote a run record to a persistent skill                                |

## Skills

A skill is a directory containing:

```
my-skill/
├── SKILL.md           # required: `aves: true` in frontmatter
├── mod.ts             # required: `export default async function main(input)`
└── mod.permission.ts  # optional: fine-grained permission rules
```

### `mod.permission.ts`

A module exporting permission-kind functions. Each function receives a value
(path, domain, sys kind, env name) and returns `"allow"`, `"deny"`, or nothing
(fall through to elicitation).

```ts
export default {
  read(value: string) {
    if (value.startsWith("/Users/me/data/")) return "allow";
    // return "deny" to block, or nothing to elicit
  },
  write(value: string) {
    return "deny"; // skill never writes
  },
  net(value: string) {
    if (value.startsWith("api.example.com")) return "allow";
  },
};
```

**The permission module is the sole source of silent approval.** Permissions
covered by the module are allowed without prompts. If the module changes (hash
mismatch), the user must re-approve it. Manual approvals of uncovered
permissions during execution are always one-shot and never create trust.

## Codex configuration

Aves uses MCP elicitation for permission prompts. Add to `~/.codex/config.toml`:

```toml
[approval_policy]
granular = { mcp_elicitations = true }
```

Without this, elicitation requests are auto-rejected and scripts will fail.

Aves advertises `codex/sandbox-state-meta` in its experimental capabilities to
receive sandbox context automatically.

## Development

```bash
# Run tests
deno task test

# Start the MCP server (stdio)
deno run main.ts
```

### Project structure

```
src/
├── broker.ts              # Unix socket broker, v1 protocol, elicit support
├── runner.ts              # Deno subprocess spawn, broker policy, executeRun
├── boot.ts                # Child process entry point (wraps user module)
├── sandbox-state.ts       # Codex sandbox-state extraction + Zod schemas
├── permission-loader.ts   # Worker factory for mod.permission.ts
├── permission-worker.ts   # Worker that loads and runs mod.permission.ts
├── policy.ts              # Permission resolution helpers
├── run-store.ts           # SQLite read/write for runs, approvals
├── db-schema.ts           # DDL for runs, script_approvals, permission_approvals
├── db-worker.ts           # SQLite query worker
├── config.ts              # config.toml parsing
├── schemas.ts             # Zod schemas (RunRequest, Permissions, SkillManifest)
├── skill.ts               # Skill discovery (SKILL.md), promote
├── types.ts               # Shared types (RunRecord, Permissions, RunRequest)
├── paths.ts               # Skill/config root path resolution
├── server-registry.ts     # Multi-server registration helpers
└── mcp/
    ├── server.ts           # MCP server, tool handlers, elicitation
    ├── tool-schemas.ts     # Input schema Zod definitions for each tool
    ├── resources.ts        # MCP resource/ResourceTemplate handlers
    ├── query-pool.ts       # Pooled SQLite query execution
    └── query-worker.ts     # SQL query worker
```

## Database

Three SQLite tables:

| Table                  | Purpose                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `runs`                 | Execution records (14 columns: id, mode, hash, input, output, exit_code, timestamps…) |
| `script_approvals`     | Hash trust for previously approved skill code hashes                                  |
| `permission_approvals` | Hash trust for `mod.permission.ts` per skill directory                                |

## License

MIT
