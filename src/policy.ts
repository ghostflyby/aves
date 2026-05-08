import type { Permissions } from "./types.ts";

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
