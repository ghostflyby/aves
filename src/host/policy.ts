// ============================================================
// src/host/policy.ts — Aves' default BrokerPolicy
//
// Aves' default permission decision chain (moved out of runner.ts).
// It lives in the host layer, not the SDK: a BrokerPolicy only
// takes effect inside a Deno host that runs `startBroker` over the
// DENO_PERMISSION_BROKER_PATH wire protocol. External hosts (e.g. a
// Jupyter kernel) implement their own decision chain — workspace
// defaults, configuration policy, notebook-user approval, silent
// deny — and pass it to their own `startBroker` call.
//
// Decision chain (no hard denies — everything beyond defaults is
// elicited so the user has final say):
//
//   default allowed (tmp, safe sys/env, import domains) → allow
//   pre-approved run paths → allow
//   import not in built-in list → hard deny
//   optional host mid-decision hook (e.g. skill perm module) → allow/deny
//   extra dirs (run dir, cwd, granted read/write) → allow
//   read-only without ceiling → allow
//   everything else → elicit
// ============================================================

import * as path from "node:path";
import type { BrokerPolicy, PermissionKind } from "../broker.ts";

/** Context passed through to the elicitation handler. */
export interface RunElicitContext {
  codeHash: string | null;
  /** Opaque to the SDK; the example policy only truthiness-checks it. */
  codexCeiling: unknown | null;
  extraDirs: string[];
  /** Run requests whose normalized value exactly matches an entry in this list are auto-allowed without elicitation. */
  preApprovedRunPaths?: string[];
}

/** A host hook inserted between the import hard-deny and extraDirs steps. */
export type MidDecideHook = (
  req: { permission: PermissionKind; value: string },
) => Promise<"allow" | { deny: string } | null>;

// ============================================================
// Default-allowed permissions (always allow, no ceiling/trust)
// ============================================================

const DEFAULT_ALLOWED_SYS = new Set([
  "hostname",
  "osRelease",
  "osUptime",
  "loadavg",
  "systemMemoryInfo",
  "gid",
  "uid",
  "networkInterfaces",
]);

const DEFAULT_ALLOWED_ENV = new Set([
  "HOME",
  "USER",
  "PATH",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TERM",
  "AVES_IO_DIR",
  "NODE_V8_COVERAGE",
]);

export const DEFAULT_IMPORT_DOMAINS = [
  "deno.land:443",
  "jsr.io:443",
  "esm.sh:443",
  "raw.esm.sh:443",
  "cdn.jsdelivr.net:443",
  "raw.githubusercontent.com:443",
  "gist.githubusercontent.com:443",
];

const BROKER_NET_ALLOW = [
  "deno.land",
  "jsr.io",
  "esm.sh",
  "raw.esm.sh",
  "cdn.jsdelivr.net",
  "raw.githubusercontent.com",
  "gist.githubusercontent.com",
];

function resolveTempDirs(): string[] {
  const dirs: string[] = ["/tmp"];
  const tmpdir = Deno.env.get("TMPDIR");
  if (tmpdir && tmpdir !== "/tmp") {
    dirs.push(tmpdir.replace(/\/+\$/, ""));
  }
  return dirs;
}

export function isDefaultAllowed(
  req: { permission: PermissionKind; value: string },
): boolean {
  switch (req.permission) {
    case "sys":
      return DEFAULT_ALLOWED_SYS.has(req.value);
    case "env":
      return req.value.startsWith("NODE_") ||
        DEFAULT_ALLOWED_ENV.has(req.value);
    case "read":
    case "write":
      return resolveTempDirs().some((d) => pathMatches(d + "/", req.value));
    case "net": {
      const reqHost = req.value.split(":")[0];
      return BROKER_NET_ALLOW.some((d) => reqHost === d);
    }
    case "import": {
      const reqHost = req.value.split(":")[0];
      return DEFAULT_IMPORT_DOMAINS.some((d) => {
        const allowedHost = d.split(":")[0];
        return reqHost === allowedHost;
      });
    }
    default:
      return false;
  }
}

// ============================================================
// Path matching (handles macOS /var -> /private/var symlink)
// ============================================================

export function pathMatches(allowed: string, requested: string): boolean {
  if (requested.startsWith(allowed)) return true;
  const normReq = requested.replace(/^\/private/, "");
  const normAllowed = allowed.replace(/^\/private/, "");
  return normReq.startsWith(normAllowed) || allowed.startsWith(normReq);
}

// ============================================================
// createRunBrokerPolicy — the example decision chain
// ============================================================

export function createRunBrokerPolicy(
  ctx: RunElicitContext,
  midDecide?: MidDecideHook,
): BrokerPolicy {
  return {
    async decide(req) {
      // Resolve relative paths against the run directory (read/write only)
      const isPathPerm = req.permission === "read" ||
        req.permission === "write";
      const resolvedValue =
        isPathPerm && !req.value.startsWith("/") && ctx.extraDirs[0]
          ? `${ctx.extraDirs[0]}/${req.value.replace(/^\.\//, "")}`
          : req.value;
      const resolvedReq = { ...req, value: resolvedValue };

      // 1. Default allowed (safe sys, env, tmp, import domains)
      if (isDefaultAllowed(resolvedReq)) return "allow";

      // 1b. Pre-approved run paths — auto-allow without elicitation.
      // Normalise so symlinks or trailing slashes don't defeat the exact match.
      if (
        resolvedReq.permission === "run" &&
        ctx.preApprovedRunPaths?.some((p) =>
          path.normalize(p) === path.normalize(resolvedValue)
        )
      ) {
        return "allow";
      }

      // 1a. Import not in built-in list → hard deny (no host hook override)
      if (resolvedReq.permission === "import") {
        return {
          deny: "import from this domain is not in the built-in allowlist",
        };
      }

      // 2. Host mid-decision hook (e.g. skill permission module) — overrides below
      if (midDecide) {
        const result = await midDecide(resolvedReq);
        if (result === "allow") return "allow";
        if (result && typeof result === "object" && "deny" in result) {
          return { deny: result.deny };
        }
        // null → fall through
      }

      // 3. Extra dirs (run dir, module dir, cwd) — auto-allow
      if (
        (resolvedReq.permission === "read" ||
          resolvedReq.permission === "write") &&
        ctx.extraDirs.some((d) => pathMatches(d + "/", resolvedValue))
      ) return "allow";

      // 5. Read-only with no ceiling → allow silently
      if (!ctx.codexCeiling && resolvedReq.permission === "read") {
        return "allow";
      }

      // 6. Everything else → elicit (user has final say)
      return "elicit";
    },

    onElicitResolved(_id, _allowed) {
      // No-op: elicitation handled by the server via onElicit
    },
  };
}
