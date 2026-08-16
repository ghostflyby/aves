# Aves REPL SDK Extraction and esbuild-wasm Migration

Status: Proposed

Date: 2026-08-13

## 1. Context

Aves currently delivers a sandboxed Deno REPL only through its MCP server: the
`repl_create` / `repl_eval` / `repl_close` tools in `src/mcp/server.ts` call
`replManager`, which spawns a child `deno run` process (`src/repl/repl-boot.ts`)
and drives it over a newline-delimited JSON protocol (`src/repl/session.ts`).

A second consumer, the Maieutics Jupyter kernel, needs the same class of
stateful TypeScript evaluation but with a very different host model:

- It owns its own kernel/transport (a Jupyter wire session) and its own session
  lifecycle (per-agent-session REPLs, generations, restart), so it does **not**
  want Aves' MCP server, its stdio session protocol, or its SQLite run history.
- Output and input must be **structured and injectable**: model cells emit
  stdout/stderr, `Deno.jupyter.display` events, and `prompt()` input requests
  that a notebook frontend consumes. The current REPL protocol returns a single
  final result and discards mid-evaluation `console.log` output.
- The Aves permission model (Codex-sandbox ceiling, `mod.permission.ts` hash
  trust, MCP elicitation) does not transfer. Jupyter needs its own decision
  chain (workspace defaults, configuration policy, notebook-user approval or
  silent deny) over the **same Deno permission-broker wire protocol**.
- Local SQLite history / skill persistence is irrelevant or host-owned.

Meanwhile Aves' REPL uses `npm:esbuild`, which spawns a native platform binary
per project. That forces broker pre-approval of the binary path
(`src/repl/session.ts:346-372`), adds a `--allow-run` dependency in the child,
and makes offline/embedded deployment awkward. `esbuild-wasm` is a single
self-contained WASM payload behind the same `transform()` API.

This document proposes extracting the REPL machinery into a host-neutral SDK
layer inside this repository, with injectable I/O, approval, and persistence,
and migrating the transform backend to esbuild-wasm.

## 2. Goals

- Extract a reusable, MCP-independent REPL SDK from `src/repl/` such that Aves'
  MCP server is one consumer and external hosts (notably Maieutics) are others.
- Provide two evaluation entry points:
  1. a **programmatic kernel** (`createReplKernel`) that runs in whatever
     process imports it and exposes `eval`/`interrupt`/`reset`/`dispose` with
     injectable output and input hooks — the entry point an external host embeds
     in its own child bootstrap; and
  2. the existing **stdio child protocol** as a default transport over that
     kernel, keeping Aves' `repl_create/eval/close` behavior byte-identical.
- Decouple the permission broker: keep Deno's `DENO_PERMISSION_BROKER_PATH`
  protocol and `startBroker` (it is transport, not policy), but make the
  decision chain an injected `BrokerPolicy`. Aves' default policy becomes an
  example implementation, not a hard dependency of the SDK.
- Remove persistence from the evaluation path entirely. Aves' `run-store` /
  `query-pool` remain at the MCP/run layer; the SDK has no database concept.
- Migrate the transform backend to esbuild-wasm (`npm:esbuild-wasm`), dropping
  the native-binary pre-approval and `--allow-run` child requirement.
- Add an optional Jupyter-compatible shim (`Deno.jupyter.*` namespace → runtime
  events) as an SDK component, so notebook hosts do not reimplement MIME
  formatting.
- Keep Aves' public MCP tool surface, its stdio protocol, and its existing 34
  REPL tests green throughout the migration.

## 3. Non-goals

- No new MCP server variants, transports, or tools.
- No distributed execution / worker protocol.
- No untrusted-code sandbox guarantees. Permission _brokering_ stays; real OS
  isolation remains the host's responsibility (process/container/VM).
- No persistence formats in the SDK; no run-history or skill promotion logic.
- No rewrite of `transform.ts`'s AST transformation semantics (only the `class`
  declaration gap is fixed, see §9).

## 4. Current coupling map

| File                                                    | Responsibility                                                                                                                                  | Couplings that block reuse                                                                                                                                 |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/repl/transform.ts`                                 | Pure AST transform (acorn+astring): declarations→`this.*` (the injected scope binding), reference rewrite, `import`→`await import`, auto-return | none — already standalone                                                                                                                                  |
| `src/repl/repl-boot.ts`                                 | Child entry: esbuild transform → `transform()` → `AsyncFunction` scope eval; stdio JSON loop                                                    | `npm:esbuild`; hard-coded stdin/stdout JSON protocol                                                                                                       |
| `src/repl/session.ts`                                   | Child-process session: spawn, JSON protocol, resolveMap, timeouts, broker wiring                                                                | imports `createRunBrokerPolicy` / `globalAbort` / `resolveModuleSpecifier` from `../runner.ts` (MCP-run layer); esbuild-wasm package-dir read pre-approval |
| `src/repl/manager.ts`                                   | `ReplManager` registry                                                                                                                          | thin; depends on `session.ts` only                                                                                                                         |
| `src/broker.ts`                                         | `DENO_PERMISSION_BROKER_PATH` server, `BrokerPolicy`, elicit flow                                                                               | none — generic, reusable as-is                                                                                                                             |
| `src/runner.ts`                                         | Module/skill run orchestration + Aves default policy + `globalAbort`                                                                            | contains the only policy + repl wiring; module-run path stays Aves-owned                                                                                   |
| `src/policy.ts`                                         | Permission resolution, Codex ceiling                                                                                                            | Aves-specific (skills, Codex)                                                                                                                              |
| `src/run-store.ts`, `db-worker.ts`, `mcp/query-pool.ts` | SQLite runs/approvals + query                                                                                                                   | Aves-only persistence                                                                                                                                      |
| `src/config.ts`, `paths.ts`, `skill.ts`                 | Aves config dirs, skills                                                                                                                        | Aves-only                                                                                                                                                  |
| `src/mcp/server.ts`                                     | MCP tools + elicitation                                                                                                                         | consumer of `repl/` and `runner/`                                                                                                                          |

Notable facts confirmed by reading:

- The REPL path today does **not** persist anything (`handleReplEval` /
  `handleReplCreate` never call `saveRun`). Persistence is already confined to
  the MCP layer — extraction costs nothing here.
- `src/repl/repl-boot.ts` child currently runs with `--allow-import` for a fixed
  domain list plus (in tests) `--allow-run`/`--allow-ffi` for esbuild's native
  binary. With the in-process esbuild-wasm browser entry those grants are gone;
  the child only needs one read for the wasm payload (pre-approved by the host,
  see §5.7).
- `console.log` from an evaluation currently lands on the child's stdout and is
  silently dropped by the host's JSON-line parser — there is no structured
  output channel today. This is the main missing capability for notebook hosts.

## 5. Proposed architecture

### 5.1 Layer split

```text
src/repl/                         <- the SDK (host-neutral; owns NO child process)
    mod.ts                          public exports
    types.ts                        ReplExecution, ReplKernel, ReplEvalResult,
                                    ReplSnapshot, ReplKernelOptions
    transform.ts                    (unchanged, moved as-is)
    eval-engine.ts                  esbuild-wasm init + cell transform + scope +
                                    AsyncFunction (pure evaluator; no globals)
    kernel.ts                       createReplKernel(options): in-process evaluation
                                    kernel; owns NO child process; produces no
                                    output events (final-expression value only)
    jupyter/                        optional host-owned shim + MIME helpers
                                    (design: host wires Deno.jupyter.* itself)

src/host/                         <- host-side assembly (Aves as one host)
    child-session.ts                (rehomed from session.ts) spawns `deno run boot.ts`
                                    with broker + env + cwd, drives StdioTransport,
                                    owns timeout/SIGKILL/restart supervision
    manager.ts                      ReplManager (registry; unchanged semantics)
    policy.ts                       Aves' default BrokerPolicy decision chain
                                    (moved from runner.ts; host-owned, see §5.5)
    transport.ts                    StdioTransport: newline-JSON protocol codec
                                    bound to a ReplKernel (pure I/O; does NOT
                                    spawn or supervise). Aves' transport —
                                    external hosts write their own
    boot.ts                         Aves' stdio child entry: createReplKernel +
                                    StdioTransport over stdin/stdout (wire
                                    protocol unchanged)

src/broker.ts                     stays (protocol + injectable policy; the broker
                                  server is started by the process that owns the
                                  child — the host, never the SDK)

src/runner.ts                     keeps only module/skill run path; imports
                                  broker + host/policy as a consumer
src/mcp/*, run-store, skill, config, paths   unchanged (Aves-owned)

main.ts                           unchanged
```

The SDK must import only: `node:` built-ins, `acorn`, `astring`, and
`esbuild-wasm`. It must **not** import `src/runner.ts`, `src/policy.ts`,
`src/run-store.ts`, `src/config.ts`, `src/paths.ts`, `src/skill.ts`,
`sandbox-state.ts`, `src/host/policy.ts`, or anything under `src/mcp/` or
`src/host/`.

### 5.2 Core interfaces

```ts
// types.ts

export interface ReplEvalResult {
  ok: boolean;
  /** Final-expression value (host may ignore in notebook mode). */
  data?: unknown;
  error?: string;
  /**
   * True when the in-process state is unusable. The host owns the recovery
   * decision (restart the child, mark the session faulted, ...); the SDK never
   * kills or respawns anything itself.
   */
  fatal?: boolean;
}

export interface ReplExecution {
  /** Monotonic sequence number (Jupyter execution_count counterpart). */
  readonly executionId: number;
  /**
   * This execution's resident AbortController. `signal` is `controller.signal`,
   * so `controller` is both the handle to cancel this execution after the fact
   * and a reliable cancellation event source: every cancellation source — the
   * external `{ signal }` token, a direct `controller.abort()`,
   * `kernel.interrupt()`, or `dispose()` — is observed on `controller.signal`.
   */
  readonly controller: AbortController;
  /** This execution's cancellation signal (`=== controller.signal`). */
  readonly signal: AbortSignal;
  /** Settles when the cell's async IIFE settles. */
  readonly result: Promise<ReplEvalResult>;
}

export interface ReplSnapshot {
  readonly names: string[];
  readonly values: Record<string, unknown>;
}

export interface ReplKernel {
  /**
   * Queue and run one cell. Returns immediately; executions run serially
   * (FIFO) because they share the persistent scope. Top-level await is
   * supported. Cancellation: pass `{ signal }`, `AbortSignal.timeout(ms)`,
   * `execution.controller.abort()`, or use `interrupt()`.
   */
  execute(code: string, options?: { signal?: AbortSignal }): ReplExecution;
  /**
   * The in-flight execution, or `null` when idle. References the execution
   * object that was running when the queue advanced, so it never points at a
   * newly queued execution.
   */
  readonly current: ReplExecution | null;
  /** Abort the in-flight execution (`=== current?.controller.abort()`). */
  interrupt(): void;
  snapshot(): ReplSnapshot;
  /** Clear scope + declared names (restart without process respawn). */
  reset(): void;
  /**
   * Release the kernel: abort in-flight work, reject queued executions, and
   * free the engine. Same as `[Symbol.asyncDispose]()`, so
   * `await using kernel = await createReplKernel()` cleans up automatically
   * when the block exits.
   */
  dispose(): Promise<void>;
  /** Explicit resource management protocol (identical to `dispose()`). */
  [Symbol.asyncDispose](): Promise<void>;
}
```

`ReplKernel` implements `AsyncDisposable`: `dispose()` and
`[Symbol.asyncDispose]` are the same release path, so both explicit
`await kernel.dispose()` and `await using kernel = await createReplKernel()`
work.

The kernel takes **one option** — an injectable cell transformer — and is
otherwise a pure evaluator plus a resident-cancellation handle per execution:

```ts
/** Cell transformer: esbuild-compatible contract (TS/JS code in, ESM out). */
export type CodeTransform = (
  code: string,
  options: { loader: "ts"; format: "esm" },
) => Promise<{ code: string }>;

export interface ReplKernelOptions {
  /**
   * Replace the default esbuild-wasm transform. Hosts can supply a shared
   * instance, a worker-pool-backed transform (one esbuild-wasm isolate per
   * worker, message-forwarded), a pre-bundled wasm payload, or a test stub.
   * Default: the process-global esbuild-wasm singleton (initialized once per
   * process, shared by all kernels).
   */
  transform?: CodeTransform;
}
```

Why `transform` is a kernel option while console/prompt/`Deno.jupyter` are not:
the transform is **executed by the kernel on every cell** (it is the SDK's only
third-party dependency), whereas the globals are host-environment concerns the
kernel never touches. A host that wants to amortize wasm initialization across
REPLs in separate workers keeps the pool on its own side — the SDK only sees a
function:

```ts
// host-side worker-pool transform (sketch): one esbuild-wasm isolate per
// worker, message-forwarded; the pool's lifecycle is host-owned.
function pooledTransform(pool: WorkerPool): CodeTransform {
  return (code, options) => pool.post({ type: "transform", code, options });
}
const kernel = await createReplKernel({
  transform: pooledTransform(myWorkerPool),
});
```

The SDK produces **no output events** — its only result is `ReplEvalResult` (the
final-expression value is the one thing a host cannot capture itself). Every
global install (console._, prompt/confirm, `Deno.jupyter.*`) is host-owned:
hosts attribute their own console capture to the in-flight cell via
`kernel.current` and route through their own channels. The SDK ships **no
global-install helpers** — hosts wire their environment however they like.

### 5.3 Lifecycle ownership: process boundary = host boundary

The central rule of the extraction: **whoever spawns the process supervises the
process.** The SDK is deliberately process-agnostic:

- **Host-owned**: spawning the `deno run` child, environment allowlist, working
  directory, `--allow-*` flags, the permission broker server and its socket
  path, startup/execution/shutdown timeouts, SIGINT→SIGKILL escalation, restart,
  PID registration, and process-tree cleanup on host exit.
- **SDK-owned**: everything inside the child — scope persistence, top-level
  await, import rewriting, the final-expression result, and cooperative
  interrupt. The stdio JSON protocol codec (StdioTransport + boot.ts) is Aves'
  host transport and lives in `src/host/`.

Rationale:

1. The primary external host (Maieutics) already owns a mature process
   supervisor (`LocalJupyterKernelManager`: `ClearInheritedEnvironment` plus an
   allowlist capture, kill-tree, one total shutdown-timeout budget, generation
   restart, and `ProcessId` registration for control-channel identity). A second
   supervision layer in the SDK would duplicate it and force hosts to fit their
   security requirements (env allowlists, permissions) into SDK spawn options —
   leaking host security policy into the SDK API.
2. The host needs to own the PID (register it, replace it on restart); the SDK
   producing processes would make that a passive transfer.
3. The permission broker is also host-owned: the host starts `startBroker`,
   passes `DENO_PERMISSION_BROKER_PATH` to the child, and holds the socket
   lifecycle. The SDK only needs to know that the environment variable exists —
   the Deno runtime connects to the broker on its own.
4. Aves remains a host too: its `src/host/child-session.ts` assembly keeps the
   current spawn/supervision behavior, so `repl_create/eval/close` are
   byte-identical.

Consequence for the public surface: `ReplKernel` carries a `fatal` result
instead of restarting; the host reacts. Busy/idle and execution timeouts are
derived from the `ReplExecution` handle (`execute()` returns immediately,
`result` settles when the cell's async IIFE does; the host passes
`AbortSignal.timeout(ms)` for per-execution timeouts) — no lifecycle callbacks
in the SDK.

### 5.4 Two entry points

**In-process kernel** — runs inside whatever process the host spawned; the host
binds its own transport (control channel, socket, ...) to the kernel:

```ts
// custom-host child entry (e.g. Maieutics' injected bootstrap)
import { createReplKernel } from "@ghostflyby/aves/repl";

const kernel = await createReplKernel(); // no options; installs no globals

// host wiring (its own bootstrap): route console + input to the control channel
let current: ReplExecution | null = null;
const routeConsole = (kind: "stdout" | "stderr") => (...args: unknown[]) => {
  const ex = current ?? kernel.current; // attribute to the in-flight cell
  if (ex) {
    channel.send({
      type: "repl.output",
      msgId: currentMsgId,
      kind,
      text: fmt(args),
    });
  }
};
globalThis.console.log = routeConsole("stdout");
globalThis.console.error = routeConsole("stderr");
// prompt/confirm via the host's own async input channel, e.g.:
//   globalThis.prompt = (m) => channel.inputRequest(String(m ?? ""));

channel.on("execute", ({ code, msgId, timeoutMs }) => {
  const ex = kernel.execute(code, { signal: AbortSignal.timeout(timeoutMs) });
  current = ex;
  channel.send({ type: "repl.busy", msgId });
  const route = async () => {
    const result = await ex.result;
    channel.send({ type: "repl.idle", msgId, result });
    if (result.fatal) restartSession(msgId); // host-owned recovery
  };
  void route().finally(() => {
    current = null;
  });
});
```

**Stdio transport** — the SDK's default codec for child processes whose
stdin/stdout is the channel. Pure I/O: it parses `eval` / `result` / `close` /
`closed` / `timeout_ms` lines and drives `kernel.execute`, but never spawns:

```ts
// src/host/boot.ts — Aves' stdio child entry (wire protocol unchanged)
import { createReplKernel } from "../repl/kernel.ts";
import { StdioTransport } from "./transport.ts";
const kernel = await createReplKernel();
StdioTransport.attach(kernel, Deno.stdin, Deno.stdout);
```

`src/host/child-session.ts` is Aves' assembly that spawns
`deno run
src/host/boot.ts` with broker + env + cwd, attaches `StdioTransport`,
and owns the supervision state machine. Aves' `repl_create/eval/close` MCP tools
keep their exact behavior (the wire protocol is unchanged; `timeout_ms` maps to
an `AbortSignal.timeout`). The transport lives in the host layer because it is
Aves' transport — notebook hosts write their own channel transport over the same
kernel.

### 5.5 Permission decoupling

`src/broker.ts` already exposes the generic seam — `startBroker(policy)` with
`BrokerPolicy.decide()` returning `"allow" | { deny } | "elicit"`. The SDK keeps
this as the **contract only**: a `BrokerPolicy` is meaningless without a Deno
host that runs `startBroker` over the `DENO_PERMISSION_BROKER_PATH` wire
protocol, so the decision chain is host-owned, not SDK-owned.

- The broker protocol + server (`startBroker`) stay in `src/broker.ts`
  (transport, not policy), run by whichever process owns the child — the host,
  never the SDK.
- `src/host/policy.ts`: Aves' default decision chain (`createRunBrokerPolicy`,
  `isDefaultAllowed`, `pathMatches`) moved from `runner.ts` into the host layer.
  It is Aves' own policy, not an SDK example: safe sys/env, temp dirs, import
  allowlist, extraDirs, read-only-no-ceiling, elicit. Re-exported from
  `@ghostflyby/aves/host` along with the other host assemblies.
- The SDK exports no policy at all. External hosts implement their own
  `BrokerPolicy` and pass it to their own `startBroker` call. For a notebook
  host the natural chain is: workspace/io dirs → allow; explicit configuration
  policy → allow/deny; everything else → deny (or a notebook-user approval
  routed through the host's own input channel). The `"elicit"` state already
  supports any asynchronous decision, so approval can flow over any channel.

Aves-specific inputs to the policy (`codexCeiling`, `mod.permission.ts`, skill
dirs) stay inside Aves' host policy and its consumers (`runner.ts`,
`permission-loader.ts`), never in the SDK.

### 5.6 Persistence

The SDK defines no persistence. `ReplSession`/`ReplKernel` take no database;
Aves' `run-store.ts` / `db-worker.ts` / `query-pool.ts` remain at the MCP layer
and keep being called only by `run_script` / `run_skill` handlers. Nothing
changes for existing behavior (the REPL path already does not persist).

### 5.7 esbuild-wasm migration

- Use the **browser entry** of `npm:esbuild-wasm` (`lib/browser.js`, the
  `"browser"` field), **not** `lib/main.js`. The main entry re-implements the
  native spawn (`ensureServiceIsRunning` spawns a `node bin/esbuild` service
  child even in wasm mode, and `initialize({ wasmURL })` throws outside
  browsers). `lib/browser.js` runs the Go WASM service **in-process** via
  `initialize({ wasmModule, worker: false })` — it instantiates the package's
  `esbuild.wasm` on the current thread with a `setTimeout`-driven event loop and
  requires no `location`, no `fetch`, no subprocess. `transform()` output is
  byte-identical to the native backend (verified on deno 2.9.5).
- The wasm payload is resolved from the package directory at first transform:
  `new URL("../esbuild.wasm", import.meta.resolve("esbuild-wasm/lib/browser.js"))`.
  The child needs exactly one broker-visible read for that file; Aves' host-side
  pre-approval adds the package dir to the policy's `extraDirs` (replacing the
  old native-binary pre-approval). Measured broker traffic drops from 5 requests
  (2 elicitable) to 1 silently-allowed read; the child's
  `--allow-run`/`--allow-ffi` grants and the `ESBUILD_BINARY_PATH` /
  `ESBUILD_WORKER_THREADS` env auto-allows are deleted.
- **Native esbuild is removed entirely** (`npm:esbuild` and its platform
  binaries are gone from `deno.json`/`deno.lock`): the `transformBackend` option
  was dropped and the SDK always uses the in-process wasm backend. The SDK's
  dependency graph is `node:` built-ins + `acorn` + `astring` + `esbuild-wasm`
  only, and no code path in the SDK can trigger a run/ffi permission request.
  Restoring the native backend (e.g. for high-throughput hosts) is a
  `deno add npm:esbuild` plus a small branch in `eval-engine.ts`.
- Offline: no `wasmURL` redirect is involved, so no browser-only constraint —
  the package must be present (Deno's npm cache, `deno install`, or a checked-in
  package copy). Whole-package presence is required because the entry and the
  wasm live side by side in the package; this is the same embed pattern
  Maieutics already uses for `maieutics-repl-client`.
- Performance: WASM transform is slower per-call than the native binary but
  removes per-spawn native startup and is irrelevant at cell granularity. The
  in-process path pays the Go shim's event-loop overhead per `transform` call;
  note the tradeoff for hosts that transform many cells per second.

## 6. Notebook-host sketch (validation of the interface)

The following is the shape an external host (Maieutics) would implement over the
SDK. It is illustrative, not part of this repo's deliverable.

```text
Host process (Maieutics executable, .NET)              <- owns the child process
    ReplControlHost (unix socket, existing)              <- transport/approval/persistence
        |  repl.execute / repl.output / repl.input      <- new channel vocabulary
        |  spawn + env allowlist + broker server + timeout/kill/restart
        v
deno run <injected entry> (spawned by the host with restrictive --allow-* + broker)
    sdk boot entry:
        createReplKernel()                       <- no options, no globals
        host wires console/prompt/Deno.jupyter itself (kernel.current for
        cell attribution) + its own input channel
        -> kernel.execute(code, { signal }) on execute messages
        -> await ex.result -> busy/idle (final-expression value)
    DENO_PERMISSION_BROKER_PATH -> host broker policy
        (workspace allow / config policy / deny)
```

Everything the host needs — scope persistence, top-level await, import
rewriting, the final-expression value, and cooperative interrupt — is inside the
SDK kernel. Output routing (console.*, `Deno.jupyter.*`) is host wiring: the
host patches its globals and attributes to `kernel.current`, then routes through
its own channels. The host supplies only the channel, the permission policy, its
own session registry, and (per §5.3) **all process supervision**: the SDK
neither spawns nor kills the child, and recovery from a `fatal` eval result is
entirely a host decision.

## 7. Migration plan

### Phase 1 — esbuild-wasm swap (no API change)

- `deno.json`: add `esbuild-wasm` (pinned, alias to `lib/browser.js`).
- `src/repl/repl-boot.ts`: `initialize({ wasmModule, worker: false })` from the
  browser entry, lazily at first transform; wasm bytes read from the package
  dir.
- `src/repl/session.ts`: replace the native-binary pre-approval block with the
  esbuild-wasm package-dir `extraDirs` pre-approval.
- `src/repl/transform_test.ts`: boot path uses the in-process backend; drop the
  `--allow-run`/`--allow-ffi` grants; grant the wasm package dir read.
- Full test pass; `npm:esbuild` dropped — `transformBackend` option removed, the
  SDK depends only on esbuild-wasm.
- **DONE (verified on deno 2.9.5, macOS arm64)**: all 34 REPL tests green;
  broker trace shows a single pre-approved read (was 5 requests, 2 elicitable).

### Phase 2 — SDK extraction (DONE)

- `transform.ts` moved as-is; `types.ts` (`ReplExecution`, `ReplKernel`,
  `ReplSnapshot`, `ReplKernelOptions`), `eval-engine.ts` (`EvalEngine`),
  `kernel.ts` (`createReplKernel`), `mod.ts` (SDK surface) added. The SDK
  imports only `node:` built-ins, `acorn`, `astring`, and `esbuild-wasm`.
- `src/host/child-session.ts` + `manager.ts` + `policy.ts` + `transport.ts` +
  `boot.ts` own Aves' spawn/supervision, default BrokerPolicy, and its stdio
  transport; `mcp/server.ts`, `mcp/resources.ts`, `main.ts`, `transform_test.ts`
  updated; `src/repl/session.ts`/`manager.ts`/ `repl-boot.ts` deleted.
- `src/runner.ts` policy logic moved to `src/host/policy.ts`; runner re-exports
  and passes the skill permission module as the policy's `MidDecideHook`.
- `src/repl/mod.ts` and `src/mod.ts` export the SDK + host assemblies.
- New unit tests: `kernel_test.ts` (FIFO serialization, scope persistence,
  top-level await, final-expression results, interrupt / controller /
  AbortSignal.timeout / pre-aborted signal, executionId, snapshot/reset,
  dispose/await-using) and `transport_test.ts` (pure framing: round-trip,
  `timeout_ms` → AbortSignal mapping, error fallback, malformed-line tolerance,
  EOF). All unit suites green; `deno check`, `lint`, `fmt` clean.

### Phase 2 — v2 API redesign (DONE)

The SDK was redesigned pre-1.0 around host neutrality and minimal surface:

- **The SDK produces no output events.** Its only result is `ReplEvalResult` —
  the final-expression value is the one thing a host cannot capture itself
  (persistent scope, top-level await, import rewriting). Console output,
  `Deno.jupyter.*`, and prompt/confirm are all host wiring: the host patches its
  globals, attributes to the in-flight cell via `kernel.current`, and routes
  through its own channels. Earlier output-stream/emit designs were dropped once
  `kernel.current` gave hosts the same execution context.
- **Cancellation = a resident AbortController per execution** — the handle
  exposes `controller` (its own `AbortSignal`), so `controller.signal` is a
  reliable cancellation event source: every source (`execute({ signal })` token,
  `controller.abort()`, `kernel.interrupt()`, `dispose()`) is observed on it,
  and the external-token bridge listener is detached once the execution settles
  (no leaks on long-lived host signals). `timeoutMs` options are gone;
  `AbortSignal.timeout(ms)` maps to the host-token bridge. `kernel.current`
  exposes the in-flight execution; `interrupt()` is
  `current?.controller.abort()`.
- **The kernel takes one option** (`transform`, the cell transformer — its only
  third-party dependency, injected so hosts can share a worker pool / prebundled
  wasm / test stub) and installs no globals. `ReplRuntime`
  (emit/requestInput/onEvalStart/onEvalEnd) is deleted; busy/idle derives from
  the handle.
- FIFO serialization because executions share the persistent scope.

### Phase 2 — findings that changed the design

- **esbuild env reads elicit**: the esbuild _package's node entry_
  (`lib/main.js`) reads `process.env.ESBUILD_BINARY_PATH` /
  `ESBUILD_WORKER_THREADS` at module load — a permission-checked access under
  the broker that the default policy does **not** auto-allow. The SDK therefore
  imports the native backend **dynamically** (`import("esbuild")`) so the
  default wasm path never loads it, and the `ESBUILD_BINARY_PATH` /
  `ESBUILD_WORKER_THREADS` env auto-allows are kept in the host policy (parity
  with HEAD, protects the opt-in native backend). Verified: the wasm path hits
  exactly one broker decision (pre-approved wasm read), zero elicitation.
- **esbuild-wasm `initialize()` is process-singleton**: calling it twice in one
  process throws ("Cannot call initialize more than once"). The resolved backend
  is memoised at module scope in `eval-engine.ts`, shared by all
  kernels/engines.
- **`createReplKernel` is synchronous** (returns `Promise<ReplKernel>` for
  future async setup, but the wasm init is lazy on first execute); the kernel
  itself owns no child process.
- **`prompt()`/`confirm()` are async**: hosts that bind them (e.g. to a Jupyter
  `input_request` round-trip) must make them return Promises, so cell code uses
  `await prompt(...)`. The kernel itself never touches these globals.

### Phase 3 — Jupyter-compat shim (host-owned)

- `Deno.jupyter` namespace (`display`, `html`/`md`/`svg`/`image`, `format`,
  `$display`) is host-owned: the SDK emits no output events, so hosts wire
  `Deno.jupyter.display` to their own display channel (attributing to
  `kernel.current` like console). The SDK may provide MIME formatting helpers
  (extracted so notebook hosts share them) plus a wiring skeleton; it never
  installs the namespace itself. `Deno.jupyter.input` is host territory just
  like `prompt`. Out of scope for the MCP server.

### Phase 4 — example custom entry + docs

- Add `examples/custom-host-boot.ts` showing `createReplKernel` bound to an
  abstract transport, plus a small `examples/custom-host-supervisor.ts` showing
  the host-side spawn/supervision contract (env allowlist, broker wiring,
  timeout escalation, restart on `fatal`).
- Update `README.md` (SDK section), `deno/AGENTS.md`-style notes are N/A here
  (this is the aves repo); add this design doc to an index if one exists.

## 8. Backward-compatibility commitments

- `repl_create` / `repl_eval` / `repl_close` MCP tools: identical schema and
  behavior.
- stdio child protocol (`eval` / `result` / `close` / `closed`, `timeout_ms`,
  `fatal` on timeout): unchanged on the wire.
- `src/repl/transform.ts` semantics: unchanged except the §9 fix.
- Broker protocol v1 (`DENO_PERMISSION_BROKER_PATH`): unchanged.

## 9. Known limitations and fixes

- **Top-level `class` declarations are now persisted** across cells: fixed by
  handling `ClassDeclaration` in `transformStatement` (emit
  `this.Foo = class
  Foo { ... }`, register `Foo` in `declaredNames`) and
  adding a `ClassExpression` branch to `rewriteReferences`' scope walker so the
  class expression's own name binding is not rewritten to `this.Foo`. Verified
  end to end: `class Foo { static v = 42 }` then `Foo.v` → `42` in both the
  child protocol and `createReplKernel` paths.
- **Top-level `await` requires the async-IIFE wrapper** (already the design);
  code that relies on module-level `var` hoisting across cells follows scope
  semantics, not V8 REPL semantics — document as an intentional deviation.
- **The persistent scope is injected via `this`** (not a parameter name): the
  transformed body is called with `fn.call(scope)`, so user code may freely
  declare/reference identifiers named `scope` — there is no reserved identifier
  and no collision (the old `scope`-parameter scheme crashed on
  `const scope = ...`). Consequences: the body is non-strict, so calling without
  `.call(...)` would write to the global object (the SDK is the only caller and
  always passes the scope); and a user's own top-level `this` resolves to the
  injected scope object instead of `undefined`/global — an intentional,
  documented deviation.
- **Cooperative interrupt only**: `kernel.interrupt()` rejects the in-flight
  race but cannot abort arbitrary synchronous work; hosts must still escalate to
  process termination for hard hangs (matches Aves' timeout → SIGKILL path).
  Because process supervision is host-owned (§5.3), this escalation stays
  entirely on the host side.
- **esbuild-wasm startup cost** (~tens of ms `initialize`) is paid once per
  kernel, not per cell.

## 10. Open questions

- Export layout (resolved): the SDK ships as sub-path exports, one
  self-explanatory functional system per entry. `@ghostflyby/aves/repl` is the
  common basics (`createReplKernel` + core types);
  `@ghostflyby/aves/repl/transform` is the AST cell transformer for hosts
  assembling their own pipeline; `@ghostflyby/aves/repl/engine` is the bare
  `EvalEngine` for hosts driving evaluation themselves;
  `@ghostflyby/aves
  /host` is Aves' own assembly (transport, broker policy,
  supervision).
- Whether the SDK should also ship host-side global-install helpers
  (`installConsoleCapture` / `installPromptInput`) in a later version — the
  kernel itself stays argument-free and installs no globals.
- Whether the kernel needs kernel-level flow control across queued executions
  (the SDK currently has none — cells are serialized FIFO and results settle
  once the cell's async IIFE does; defer).

## 11. Verification

- `deno check src/ main.ts mcp_e2e_test.ts`
- `deno lint .` and `deno fmt --check .`
- `deno test ... src/repl/` (transform + kernel tests)
- `deno test ... src/host/` (StdioTransport framing)
- `deno test ... mcp_e2e_test.ts` (MCP surface regression)
- A manual `repl_create` / `repl_eval` / `repl_close` round-trip through the MCP
  stdio server (existing e2e covers this)
