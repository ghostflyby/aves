import {executeRun} from "./src/runner.ts";
import {loadRun, saveRun} from "./src/run-store.ts";
import type {RunRequest} from "./src/types.ts";

async function cmdRun(args: string[]) {
  const filePath = args[0];
  if (!filePath) {
    console.error("Usage: aves run <script-file>");
    Deno.exit(1);
  }

  const code = await Deno.readTextFile(filePath);
  const request: RunRequest = {
    mode: "eval",
    code,
    permissions: {},
  };

  const record = await executeRun(request);
  await saveRun(record);

  console.log(JSON.stringify(record, null, 2));
}

async function cmdReplay(args: string[]) {
  const runId = args[0];
  if (!runId) {
    console.error("Usage: aves replay <run-id>");
    Deno.exit(1);
  }

  const record = await loadRun(runId);
  if (!record) {
    console.error(`Run not found: ${runId}`);
    Deno.exit(1);
  }

  console.log(JSON.stringify(record, null, 2));
}

if (import.meta.main) {
  const cmd = Deno.args[0] ?? "run";
  const rest = Deno.args.slice(1);

  switch (cmd) {
    case "run":
      await cmdRun(rest);
      break;
    case "replay":
      await cmdReplay(rest);
      break;
    case "serve":
    case "stdio":
      const { startServer } = await import("./src/mcp/server.ts");
      await startServer();
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      console.error("Usage: aves <run|replay> [args...]");
      Deno.exit(1);
  }
}
