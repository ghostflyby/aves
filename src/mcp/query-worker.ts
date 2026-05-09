// Aves query worker — runs inside a Deno Worker.
// Receives SQL queries, executes against the Aves database via read-only SQLite.
// One DatabaseSync connection per worker, kept alive for reuse.

import { DatabaseSync } from "node:sqlite";
import { getAvesDbPath } from "../paths.ts";

const db = new DatabaseSync(getAvesDbPath(), { readOnly: true });

// deno-lint-ignore no-explicit-any
const ctx = self as any;
ctx.onmessage = (e: MessageEvent) => {
  const { sql, params, id } = e.data;

  try {
    // Validate SQL — only query statements allowed
    const trimmed = sql.trim().toUpperCase();
    if (!/^(SELECT|PRAGMA|EXPLAIN|WITH)\b/.test(trimmed)) {
      ctx.postMessage({
        id,
        ok: false,
        error: "Only SELECT, PRAGMA, EXPLAIN, and WITH queries are allowed",
      });
      return;
    }

    const stmt = db.prepare(sql);
    const rows = params && params.length > 0 ? stmt.all(...params) : stmt.all();

    ctx.postMessage({ id, ok: true, rows });
  } catch (err) {
    ctx.postMessage({
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
