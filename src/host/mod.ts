// ============================================================
// src/host/mod.ts — Aves host-side assemblies (public surface)
//
// The host layer is Aves' own assembly over the SDK: it spawns
// `deno run` children, runs the permission broker (with Aves'
// default BrokerPolicy), and supervises sessions (design doc
// §5.3). It also owns Aves' transport (StdioTransport + boot.ts,
// the stdio child entry). External hosts normally implement their
// own supervision, BrokerPolicy, and transport, and only consume
// `@ghostflyby/aves/repl`.
// ============================================================

export { ReplManager, replManager } from "./manager.ts";
export {
  type ReplResult,
  ReplSession,
  type ReplSessionInfo,
  type SpawnOptions,
  spawnReplSession,
} from "./child-session.ts";
export { StdioTransport } from "./transport.ts";
export {
  createRunBrokerPolicy,
  DEFAULT_IMPORT_DOMAINS,
  isDefaultAllowed,
  type MidDecideHook,
  pathMatches,
  type RunElicitContext,
} from "./policy.ts";
