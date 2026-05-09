// Aves SQLite query worker pool.
// Manages a pool of Deno Workers, each with a read-only DatabaseSync connection.
// Uses WAL mode — multiple readers can access the database concurrently.
//
// Pool strategy:
//   - Initial size: 1 (lazy — created on first request)
//   - Scale up: +1 when all workers busy, up to max
//   - Scale down: idle workers terminated after 60s, keeping min 1
//   - Timeout: worker.terminate() on timeout, replaced asynchronously
//   - Queue: FIFO via Promise.withResolvers

import { getAvesDataDir } from "../paths.ts";

interface PoolWorker {
  worker: Worker;
  busy: boolean;
  idleSince: number | null;
  /** The request currently executing on this worker (null when idle or queued). */
  currentReq: QueuedRequest | null;
}

interface QueuedRequest {
  sql: string;
  params?: (string | number | null)[];
  resolve: (result: QueryResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface QueryResult {
  ok: boolean;
  rows?: Record<string, unknown>[];
  error?: string;
}

const MAX_POOL = Math.min(
  // @ts-ignore: navigator.hardwareConcurrency exists in Deno
  (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4,
  4,
);
const IDLE_TIMEOUT_MS = 60_000;
const IDLE_CHECK_INTERVAL = 30_000;

const workers: PoolWorker[] = [];
const queue: QueuedRequest[] = [];
let nextId = 0;

let idleTimer: ReturnType<typeof setInterval> | null = null;

function startIdleTimer(): void {
  if (idleTimer) return;
  idleTimer = setInterval(() => {
    const now = Date.now();
    for (let i = workers.length - 1; i >= 0; i--) {
      const pw = workers[i];
      if (
        !pw.busy && pw.idleSince && now - pw.idleSince > IDLE_TIMEOUT_MS &&
        workers.length > 1
      ) {
        pw.worker.terminate();
        workers.splice(i, 1);
      }
    }
  }, IDLE_CHECK_INTERVAL);
}

function createWorker(): Worker {
  const workerUrl = new URL("./query-worker.ts", import.meta.url).href;
  return new Worker(workerUrl, {
    type: "module",
    deno: {
      permissions: {
        read: [
          // Project root — worker imports paths.ts and other source modules
          new URL("../../", import.meta.url).pathname,
          // Database directory — worker opens aves.db here
          getAvesDataDir(),
        ],
        env: ["AVES_DATA_DIR", "XDG_DATA_HOME", "LocalAppData"],
        sys: ["homedir"],
      },
    },
  });
}

function spawnWorker(): PoolWorker {
  const worker = createWorker();
  const pw: PoolWorker = {
    worker,
    busy: false,
    idleSince: Date.now(),
    currentReq: null,
  };
  workers.push(pw);
  return pw;
}

function acquireWorker(): PoolWorker | null {
  // Find idle worker
  for (const pw of workers) {
    if (!pw.busy) {
      pw.busy = true;
      pw.idleSince = null;
      return pw;
    }
  }

  // Scale up if below max
  if (workers.length < MAX_POOL) {
    const pw = spawnWorker();
    pw.busy = true;
    pw.idleSince = null;
    return pw;
  }

  return null;
}

function releaseWorker(pw: PoolWorker): void {
  pw.busy = false;
  pw.idleSince = Date.now();
  pw.currentReq = null;

  // Process next queued request
  if (queue.length > 0) {
    const req = queue.shift()!;
    clearTimeout(req.timer);
    executeOnWorker(pw, req);
  }
}

function executeOnWorker(pw: PoolWorker, req: QueuedRequest): void {
  const id = nextId++;
  pw.currentReq = req;

  const handler = (e: MessageEvent) => {
    if (e.data.id !== id) return;
    pw.worker.removeEventListener("message", handler);
    pw.worker.removeEventListener("error", errHandler);
    releaseWorker(pw);

    if (e.data.ok) {
      req.resolve({ ok: true, rows: e.data.rows });
    } else {
      req.resolve({ ok: false, error: e.data.error });
    }
  };

  const errHandler = () => {
    pw.worker.removeEventListener("message", handler);
    pw.worker.removeEventListener("error", errHandler);
    // Worker errored — remove from pool, create replacement, drain queue
    const idx = workers.indexOf(pw);
    if (idx >= 0) workers.splice(idx, 1);
    pw.worker.terminate();
    pw.currentReq = null;
    const newPw = spawnWorker();
    releaseWorker(newPw); // drain queued requests onto the fresh worker
    req.reject(new Error("Worker error"));
  };

  pw.worker.addEventListener("message", handler);
  pw.worker.addEventListener("error", errHandler);
  pw.worker.postMessage({ sql: req.sql, params: req.params, id });
}

function enqueue(
  sql: string,
  params: (string | number | null)[] | undefined,
  timeoutMs: number,
): Promise<QueryResult> {
  return new Promise<QueryResult>((resolve, _reject) => {
    const timer = setTimeout(() => {
      // Timeout — check queue first
      const idx = queue.findIndex((q) => q.timer === timer);
      if (idx >= 0) {
        queue.splice(idx, 1);
        resolve({ ok: false, error: `Query timed out after ${timeoutMs}ms` });
        return;
      }
      // Request is executing — find and terminate its worker
      for (const pw of workers) {
        if (pw.currentReq?.timer === timer) {
          pw.worker.terminate();
          pw.currentReq = null;
          const widx = workers.indexOf(pw);
          if (widx >= 0) workers.splice(widx, 1);
          const newPw = spawnWorker();
          releaseWorker(newPw); // drain queued requests
          resolve({ ok: false, error: `Query timed out after ${timeoutMs}ms` });
          return;
        }
      }
      // Already resolved by worker — nothing to do
    }, timeoutMs);

    const req: QueuedRequest = { sql, params, resolve, reject: _reject, timer };

    const pw = acquireWorker();
    if (pw) {
      executeOnWorker(pw, req);
    } else {
      queue.push(req);
    }
  });
}

/**
 * Execute a read-only SQL query against the Aves database.
 * Uses the worker pool internally.
 */
export function queryRuns(
  sql: string,
  params?: (string | number | null)[],
  timeoutMs: number = 10_000,
): Promise<QueryResult> {
  startIdleTimer();
  return enqueue(sql, params, timeoutMs);
}

/**
 * Gracefully shut down the pool — terminate all workers.
 */
export function disposePool(): void {
  if (idleTimer) {
    clearInterval(idleTimer);
    idleTimer = null;
  }
  for (const pw of workers) {
    pw.worker.terminate();
  }
  workers.length = 0;
  queue.length = 0;
}
