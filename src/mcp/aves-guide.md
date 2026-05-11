# Aves — Agent Guide

You have access to Aves, an MCP server for sandboxed TypeScript execution. Every
script runs in a Deno subprocess with a permission broker that intercepts
filesystem, network, env, and sys calls. You do **not** need to pre-declare
permissions — the broker asks the user at runtime.

## Writing scripts

Use `run_script` with `mode: "eval"` and inline `code`. The script must be a
valid ES module:

```ts
export default async function main(input: unknown) {
  // your code here
  return { result: "ok" };
}
```

Optionally export `inputSchema` (Zod@4) for runtime input validation:

```ts
import { z } from "zod";
export const inputSchema = z.object({ name: z.string() });
export default async function main(input: z.infer<typeof inputSchema>) {
  throw new Error(input);
}
```

## Permission model

The broker decides permissions at runtime. The decision chain:

1. **Auto-allowed** (no prompt): temp dirs (`/tmp`, `$TMPDIR`), safe syscalls
   (hostname, osRelease, memoryInfo…), safe env vars (HOME, USER, PATH…), Deno
   import domains (deno.land, jsr.io, esm.sh…), and the script's own run
   directory.

2. **Permission module** (skills only): if a skill has `mod.permission.ts`,
   rules defined there run before elicitation. Covered paths are silent.

3. **Hash trust** (skills only): a skill with a previously approved code hash
   runs silently. Changing `mod.ts` invalidates the hash and requires
   re-approval. Direct `run_script` never gets hash trust.

4. **Elicited** (user prompt): everything else. The user sees the permission
   type and value and chooses approve or deny.

**Important:** direct `run_script` always prompts for non-default permissions.
Only skills with an approved `mod.permission.ts` get silent re-runs.

## Writing to files

Scripts can write to their run directory silently. Writing elsewhere triggers a
prompt. To write output that the agent can read back, write to the run directory
and return the path, or write to a temp dir (auto-allowed) and return the path.

```ts
export default async function main() {
  const path = Deno.makeTempFileSync();
  await Deno.writeTextFile(path, "data");
  return { path };
}
```

## Network access

`fetch()` to any domain triggers a prompt except Deno import domains. The Codex
sandbox state informs whether network is enabled.

## Skills

Skills are persistent scripts with description and optional auto permissions.
Use `run_skill` with a `skill_path` to execute one.

To create a skill:

1. Use `promote_to_skill` on a successful run
2. Optionally create `mod.permission.ts` next to the generated `mod.ts`
3. First run: review and approve the permission module
4. Subsequent runs: silent for covered permissions

Permission module format:

```ts
export default {
  read(value: string) {
    if (value.startsWith("/specific/path/")) return "allow";
  },
  write(value: string) {
    return "deny"; // never allow writes
  },
  net(value: string) {
    if (value === "api.example.com:443") return "allow";
  },
};
```

Return `"allow"` to permit silently, `"deny"` to block, or `undefined|void` to
fall through to user elicitation.

## Database

Use `query_runs` for read-only SQL on past runs. The `runs` table schema is at
`aves://schema/runs`. Examples:

```sql
SELECT exit_code, COUNT(*) FROM runs GROUP BY exit_code;
SELECT * FROM runs WHERE code_hash = 'abc123' ORDER BY started_at DESC;
```

## Limitations

- No `--allow-ffi`, `--allow-run` support (blocked by broker)
- Import domains are pre-declared (deno.land, jsr.io, esm.sh, etc.)
- Max script runtime: unbounded (Deno.Command has no timeout)
- Env access is restricted to the whitelist: HOME, USER, PATH, TMPDIR, SHELL,
  LANG, TERM
- Syscalls are restricted to: hostname, osRelease, osUptime, loadavg,
  memoryInfo, gid, uid, networkInterfaces
