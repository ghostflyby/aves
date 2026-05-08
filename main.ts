import { startServer, startHttpServer } from "./src/mcp/server.ts";
import { ensureSkillRoots, parseConfig } from "./src/config.ts";
import {
  findRunningServer,
  registerEndpoint,
  acquireLock,
  releaseLock,
  cleanupAll,
  findAvailablePort,
} from "./src/server-registry.ts";
import { closeDb } from "./src/run-store.ts";

// ============================================================
// Cleanup — runs on SIGINT, SIGTERM, and process exit
// ============================================================

let cleanupRegistered = false;

function registerCleanup() {
  if (cleanupRegistered) return;
  cleanupRegistered = true;

  const cleanup = () => {
    cleanupAll().catch(() => {});
    closeDb();
  };

  // Graceful shutdown on signals
  Deno.addSignalListener("SIGINT", () => {
    console.error("\nAves shutting down (SIGINT)...");
    cleanup();
    Deno.exit(0);
  });
  Deno.addSignalListener("SIGTERM", () => {
    console.error("Aves shutting down (SIGTERM)...");
    cleanup();
    Deno.exit(0);
  });

  // unload handler for abrupt exits
  globalThis.addEventListener("unload", () => {
    cleanup();
  });
}

// ============================================================
// Server daemon (HTTP)
// ============================================================

async function cmdServer() {
  await parseConfig();
  await ensureSkillRoots();
  registerCleanup();

  const lock = await acquireLock();
  if (!lock.ok) {
    console.error(`Cannot start server: ${lock.reason}`);
    Deno.exit(1);
  }

  const port = await findAvailablePort(38440);
  const host = "127.0.0.1";

  try {
    const { port: actualPort } = await startHttpServer(port, host);

    await registerEndpoint({
      pid: Deno.pid,
      transport: "http",
      host,
      port: actualPort,
      started_at: new Date().toISOString(),
    });

    console.error(`Aves daemon ready (pid ${Deno.pid}, port ${actualPort})`);

    // Block — Deno.serve already runs
    await new Promise(() => {});
  } finally {
    await releaseLock();
    closeDb();
  }
}

// ============================================================
// Stdio — connect-or-spawn
// ============================================================

async function cmdStdio() {
  await parseConfig();
  await ensureSkillRoots();

  const existing = await findRunningServer();
  if (existing) {
    console.error(`Connected to aves daemon at ${existing.host}:${existing.port}`);
    await proxyToServer(existing.host, existing.port);
    return;
  }

  // No server — start a transient stdio-mode server
  console.error("Starting stdio server (no daemon found)");
  registerCleanup();
  await startServer();
  closeDb();
}

/**
 * Proxy stdin/stdout to an existing HTTP MCP server.
 * Reads JSON-RPC lines from stdin, POSTs to /mcp, writes response to stdout.
 */
async function proxyToServer(host: string, port: number) {
  const baseUrl = `http://${host}:${port}/mcp`;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const buf = new Uint8Array(8192);
  let partial = "";

  while (true) {
    const n = await Deno.stdin.read(buf);
    if (n === null) break;

    partial += decoder.decode(buf.subarray(0, n), { stream: true });

    const lines = partial.split("\n");
    partial = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const response = await fetch(baseUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: trimmed,
        });

        const responseText = await response.text();
        if (responseText) {
          await Deno.stdout.write(encoder.encode(responseText + "\n"));
        }
      } catch (err) {
        const errMsg = JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: String(err) },
        });
        await Deno.stdout.write(encoder.encode(errMsg + "\n"));
      }
    }
  }
}

// ============================================================
// Entry point
// ============================================================

if (import.meta.main) {
  const cmd = Deno.args[0] ?? "stdio";

  switch (cmd) {
    case "server":
      await cmdServer();
      break;
    case "serve":
    case "stdio":
      await cmdStdio();
      break;
    default:
      console.error(`Usage: aves <server|stdio>`);
      Deno.exit(1);
  }
}
