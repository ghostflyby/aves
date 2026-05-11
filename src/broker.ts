// ============================================================
// broker.ts — Permission Broker Server
//
// Runs concurrently with a Deno.Command child process. Listens on
// a Unix socket, receives permission requests from the child
// (via DENO_PERMISSION_BROKER_PATH), and responds allow/deny
// based on the supplied BrokerPolicy.
// ============================================================

// ============================================================
// Types
// ============================================================

/**
 * Permission kinds sent through the Deno v1 broker protocol.
 * Matches the `permission` field in permission-broker-request.v1.json.
 */
export type PermissionKind =
  | "read"
  | "write"
  | "net"
  | "sys"
  | "env"
  | "run"
  | "ffi"
  | "import";

/** A permission request sent by the child Deno process. */
export interface PermissionRequest {
  id: number;
  permission: PermissionKind;
  value: string;
}

/** Signature for resolving a pending elicitation. */
export type ElicitResolver = (allowed: boolean) => Promise<void>;

/** Policy that decides how to respond to each permission request. */
export interface BrokerPolicy {
  decide(
    req: PermissionRequest,
  ): Promise<"allow" | { deny: string } | "elicit">;
  /** Called when a previously-elicted request is resolved externally. */
  onElicitResolved(id: number, allowed: boolean): void;
  /** Optional: called when a request needs external elicitation. The callee should present a dialog and call `resolve`. */
  onElicit?: (
    id: number,
    req: PermissionRequest,
    resolve: ElicitResolver,
  ) => void;
}

/** Handle returned by startBroker — the caller uses this to wait for
 * completion or cancel the listener. */
export interface BrokerHandle {
  /** Absolute path to the Unix-domain socket the broker listens on. */
  sockPath: string;
  /** Resolves when the listener loop finishes (all connections closed). */
  done: Promise<void>;
  /** Closes the listener and cleans up the socket + temp directory. */
  cancel(): void;
}

// ============================================================
// Wire protocol (v1) — newline-delimited JSON
// ============================================================

interface BrokerRequest {
  v: number;
  pid: number;
  id: number;
  datetime: string;
  permission: PermissionKind;
  value: string;
}

interface BrokerResponse {
  id: number;
  result: "allow" | "deny";
  reason?: string;
}

// ============================================================
// Pending-request tracker (used for elicit flow)
// ============================================================

interface PendingRequest {
  req: PermissionRequest;
  conn: Deno.UnixConn;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  resolve: (allowed: boolean) => void;
}

// ============================================================
// startBroker
// ============================================================

/**
 * Start a permission broker that listens on a Unix socket and answers
 * permission prompts from a child Deno process.
 *
 * The returned `BrokerHandle.sockPath` should be passed to the child
 * via the `DENO_PERMISSION_BROKER_PATH` environment variable.
 */
export async function startBroker(
  policy: BrokerPolicy,
): Promise<BrokerHandle> {
  const sockDir = await Deno.makeTempDir({ prefix: "aves_broker_" });
  const sockPath = `${sockDir}/broker.sock`;

  const listener = Deno.listen({ path: sockPath, transport: "unix" });

  const pending = new Map<number, PendingRequest>();
  const ac = new AbortController();

  // Hook up elicit resolution so the policy can resume pending requests.
  const originalOnElicitResolved = policy.onElicitResolved.bind(policy);
  policy.onElicitResolved = (id: number, allowed: boolean) => {
    const entry = pending.get(id);
    if (entry) {
      pending.delete(id);
      entry.resolve(allowed);
    }
    originalOnElicitResolved(id, allowed);
  };

  const done = (async () => {
    try {
      for await (const rawConn of listener) {
        if (ac.signal.aborted) break;
        const conn = rawConn as Deno.UnixConn;
        handleConnection(conn, policy, pending, ac.signal).catch(() => {});
      }
    } finally {
      try {
        listener.close();
      } catch { /* already closed */ }
      for (const [id, entry] of pending) {
        try {
          const encoder = new TextEncoder();
          entry.writer.write(
            encoder.encode(
              JSON.stringify({
                id,
                result: "deny",
                reason: "broker cancelled",
              }) + "\n",
            ),
          );
        } catch { /* best effort */ }
        try {
          entry.resolve(false);
        } catch { /* best effort */ }
      }
      pending.clear();
      try {
        await Deno.remove(sockPath);
      } catch { /* already removed */ }
      try {
        await Deno.remove(sockDir, { recursive: true });
      } catch { /* already removed */ }
    }
  })();

  return {
    sockPath,
    done,
    cancel() {
      ac.abort();
      try {
        listener.close();
      } catch { /* already closed */ }
    },
  };
}

// ============================================================
// Connection handler
// ============================================================

async function handleConnection(
  conn: Deno.UnixConn,
  policy: BrokerPolicy,
  pending: Map<number, PendingRequest>,
  signal: AbortSignal,
): Promise<void> {
  const encoder = new TextEncoder();
  const writer = conn.writable.getWriter();

  try {
    const decoder = new TextDecoder();
    let buf = "";
    const bufSize = 4096;
    const readBuf = new Uint8Array(bufSize);

    while (!signal.aborted) {
      let n: number | null;
      try {
        n = await conn.read(readBuf);
      } catch {
        break; // connection closed or error
      }
      if (n === null) break; // EOF

      buf += decoder.decode(readBuf.subarray(0, n), { stream: true });

      // Process complete lines
      let newlineIdx: number;
      while ((newlineIdx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, newlineIdx);
        buf = buf.slice(newlineIdx + 1);

        if (line.length === 0) continue;

        await handleRequest(line, conn, policy, pending, writer, encoder);
      }
    }
  } finally {
    writer.releaseLock();
    try {
      conn.close();
    } catch { /* best-effort */ }
  }
}

// ============================================================
// Single-request handler
// ============================================================

async function handleRequest(
  line: string,
  conn: Deno.UnixConn,
  policy: BrokerPolicy,
  pending: Map<number, PendingRequest>,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder,
): Promise<void> {
  let raw: BrokerRequest;
  try {
    raw = JSON.parse(line);
  } catch {
    // Malformed request — ignore (protocol spec says these are discarded)
    return;
  }

  // Basic validation
  if (typeof raw.v !== "number" || typeof raw.id !== "number") {
    return;
  }

  const req: PermissionRequest = {
    id: raw.id,
    permission: (raw.permission as PermissionKind) ?? "read",
    value: raw.value ?? "",
  };

  const decision = await policy.decide(req);

  if (decision === "allow") {
    await writeResponse(writer, encoder, { id: req.id, result: "allow" });
  } else if (typeof decision === "object" && "deny" in decision) {
    await writeResponse(writer, encoder, {
      id: req.id,
      result: "deny",
      reason: decision.deny,
    });
  } else {
    // "elicit" — hold the connection open; resolved via onElicitResolved
    await new Promise<void>((resolve) => {
      pending.set(req.id, {
        req,
        conn,
        writer,
        resolve: async (allowed: boolean) => {
          await writeResponse(writer, encoder, {
            id: req.id,
            result: allowed ? "allow" : "deny",
            reason: allowed ? undefined : "denied by user",
          });
          resolve();
        },
      });
      // Notify the policy that an elicitation is ready
      policy.onElicit?.(req.id, req, (allowed) => {
        return new Promise((r) => {
          policy.onElicitResolved(req.id, allowed);
          r();
        });
      });
    });
  }
}

// ============================================================
// Helpers
// ============================================================

async function writeResponse(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder,
  resp: BrokerResponse,
): Promise<void> {
  const payload = JSON.stringify(resp) + "\n";
  await writer.write(encoder.encode(payload));
}
