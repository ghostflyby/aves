import type { Permissions } from "./types.ts";
import type { SandboxState } from "./sandbox-state.ts";
import {
  extractCodexNetworkTargets,
  extractCodexReadablePaths,
  extractCodexWritablePaths,
  intersectPaths,
} from "./sandbox-state.ts";

// Permission categories that map to Deno CLI flags
export type PermissionKey = "read" | "write" | "net" | "env";

// Categories that can NEVER be granted
export const FORBIDDEN_KEYS = ["run", "ffi"] as const;

export interface PolicyRule {
  allow?: boolean;
  path_patterns?: string[]; // allowed path/domain prefixes
}

export interface ServerPolicy {
  rules: Partial<Record<PermissionKey, PolicyRule>>;
  default_action: "allow" | "deny";
}

export const DEFAULT_POLICY: ServerPolicy = {
  rules: {
    read: { allow: true },
    write: { allow: true },
    net: { allow: true },
    env: { allow: true },
  },
  default_action: "allow",
};

export interface PolicyResult {
  granted: Permissions;
  denied: PermissionKey[];
}

/**
 * Resolve final granted permissions from request + policy.
 *
 * - Forbidden keys (run, ffi) are always denied.
 * - Policy rules can restrict to specific path/domain patterns.
 * - If a rule has allow=false, that key is denied entirely.
 * - Default action applies to any key not mentioned in policy rules.
 */
export function resolvePermissions(
  requested: Permissions,
  policy?: ServerPolicy,
): PolicyResult {
  const activePolicy = policy ?? DEFAULT_POLICY;
  const denied: PermissionKey[] = [];
  const granted: Permissions = {};

  for (const key of ["read", "write", "net", "env"] as const) {
    const rule = activePolicy.rules[key];
    const isAllowedByDefault = activePolicy.default_action === "allow";
    const paths = requested[key];

    if (rule?.allow === false) {
      // Explicitly denied by policy
      denied.push(key);
      continue;
    }

    if (!paths || paths.length === 0) {
      // No paths requested, nothing to grant
      continue;
    }

    if (rule?.path_patterns && rule.path_patterns.length > 0) {
      // Restrict to matching patterns only
      const filtered = paths.filter((p) =>
        rule.path_patterns!.some((pattern) => p.startsWith(pattern))
      );
      if (filtered.length > 0) {
        granted[key] = filtered;
      } else {
        denied.push(key);
      }
    } else if (isAllowedByDefault || rule?.allow === true) {
      granted[key] = paths;
    } else {
      denied.push(key);
    }
  }

  return { granted, denied };
}

/**
 * Check if a permission key is forbidden (run/ffi).
 */
export function isForbidden(key: string): boolean {
  return (FORBIDDEN_KEYS as readonly string[]).includes(key);
}

/**
 * Apply Codex sandbox ceiling to requested permissions.
 *
 * - read: intersection with Codex readable paths (can exceed ceiling)
 * - write: intersection with Codex writable paths (CANNOT exceed ceiling)
 * - net: intersection with Codex network targets
 *        Bare allow-net (empty requested) is rejected
 *        Specific domains that exceed ceiling are dropped
 * - env: passed through (not gated by sandbox-state)
 *
 * Returns granted permissions and dropped paths (paths that were
 * requested but not in the Codex ceiling).
 */
export function applyCodexCeiling(
  requested: Permissions,
  sandboxState: SandboxState | null,
): { granted: Permissions; dropped: Partial<Permissions> } {
  const granted: Permissions = {};
  const dropped: Partial<Permissions> = {};

  const readablePaths = sandboxState
    ? extractCodexReadablePaths(sandboxState)
    : ["*"];
  const writablePaths = sandboxState
    ? extractCodexWritablePaths(sandboxState)
    : ["*"];
  const networkTargets = sandboxState
    ? extractCodexNetworkTargets(sandboxState)
    : ["*"];

  // Read: intersect; excess is dropped but allowed (read is safe)
  if (requested.read && requested.read.length > 0) {
    const { matched, dropped: readDropped } = intersectPaths(
      requested.read,
      readablePaths,
    );
    if (matched.length > 0) granted.read = matched;
    if (readDropped.length > 0) dropped.read = readDropped;
  }

  // Write: intersect; excess is DENIED (write cannot exceed ceiling)
  if (requested.write && requested.write.length > 0) {
    const { matched, dropped: writeDropped } = intersectPaths(
      requested.write,
      writablePaths,
    );
    if (matched.length > 0) granted.write = matched;
    if (writeDropped.length > 0) dropped.write = writeDropped;
  }

  // Net: intersect; bare allow-net is rejected via empty intersection
  if (requested.net && requested.net.length > 0) {
    const { matched, dropped: netDropped } = intersectPaths(
      requested.net,
      networkTargets,
    );
    if (matched.length > 0) granted.net = matched;
    if (netDropped.length > 0) dropped.net = netDropped;
  }

  // Env: pass through (not gated by sandbox-state, but policy may restrict it)
  if (requested.env && requested.env.length > 0) {
    granted.env = requested.env;
  }

  return { granted, dropped };
}

/**
 * Returns true when all requested permissions are within the Codex ceiling
 * (i.e., no paths were dropped by applyCodexCeiling).
 * This corresponds to the "C" dimension in the approval truth table.
 */
export function isWithinCodexCeiling(
  dropped: Partial<Permissions>,
): boolean {
  const allKeys = ["read", "write", "net"] as const;
  return allKeys.every((k) => !dropped[k] || dropped[k]!.length === 0);
}

/**
 * Returns true when the permissions only contain read access
 * (no write, net, or env).
 */
export function isReadOnly(permissions: Permissions): boolean {
  return (
    (permissions.read?.length ?? 0) > 0 &&
    (permissions.write?.length ?? 0) === 0 &&
    (permissions.net?.length ?? 0) === 0 &&
    (permissions.env?.length ?? 0) === 0
  );
}
