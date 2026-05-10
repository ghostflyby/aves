// ============================================================
// sandbox-state.ts — Codex sandbox-state extraction utilities
// Types and schemas both declared here with Zod.
// ============================================================

import { z } from "zod";

// ============================================================
// Zod schemas — matching real Codex "codex/sandbox-state-meta" JSON
// ============================================================

const SandboxPathLiteralSchema = z.object({
  type: z.literal("path"),
  path: z.string(),
});

const SandboxPathSpecialSchema = z.object({
  type: z.literal("special"),
  value: z.object({
    kind: z.enum(["root", "project_roots", "slash_tmp", "tmpdir"]),
    subpath: z.string().optional(),
  }),
});

const SandboxPathEntrySchema = z.discriminatedUnion("type", [
  SandboxPathLiteralSchema,
  SandboxPathSpecialSchema,
]);

const FileSystemEntrySchema = z.object({
  path: SandboxPathEntrySchema,
  access: z.enum(["read", "write", "none"]),
});

const PermissionProfileSchema = z.object({
  type: z.literal("managed"),
  file_system: z.object({
    type: z.enum(["restricted", "unrestricted"]),
    entries: z.array(FileSystemEntrySchema),
  }),
  network: z.string(),
});

const SandboxPolicySchema = z.object({
  type: z.string(),
  writable_roots: z.array(z.string()),
  network_access: z.boolean(),
  exclude_tmpdir_env_var: z.boolean(),
  exclude_slash_tmp: z.boolean(),
});

const SandboxStateMetaSchema = z.object({
  permissionProfile: PermissionProfileSchema,
  sandboxPolicy: SandboxPolicySchema,
  codexLinuxSandboxExe: z.string().nullable(),
  sandboxCwd: z.string(),
  useLegacyLandlock: z.boolean(),
});

// ============================================================
// Exported types (derived from Zod)
// ============================================================

export type SandboxPathLiteral = z.infer<typeof SandboxPathLiteralSchema>;
export type SandboxPathSpecial = z.infer<typeof SandboxPathSpecialSchema>;
export type SandboxPathEntry = z.infer<typeof SandboxPathEntrySchema>;
export type FileSystemEntry = z.infer<typeof FileSystemEntrySchema>;
export type PermissionProfile = z.infer<typeof PermissionProfileSchema>;
export type SandboxPolicy = z.infer<typeof SandboxPolicySchema>;
export type SandboxStateMeta = z.infer<typeof SandboxStateMetaSchema>;

/** Decoded sandbox state with resolved workspace paths. */
export interface SandboxState {
  meta: SandboxStateMeta;
  workspaces: string[];
}

// ============================================================
// Constants
// ============================================================

const SANDBOX_STATE_META_KEY = "codex/sandbox-state-meta";
const TURN_METADATA_KEY = "x-codex-turn-metadata";

// ============================================================
// extractSandboxState
// ============================================================

/**
 * Extract a {@link SandboxState} from the full `params._meta` object.
 * Returns null when the capability key is absent or parsing fails.
 */
export function extractSandboxState(meta: unknown): SandboxState | null {
  if (meta == null || typeof meta !== "object") return null;

  const m = meta as Record<string, unknown>;
  const raw = m[SANDBOX_STATE_META_KEY];
  if (raw == null || typeof raw !== "object") return null;

  const parsed = SandboxStateMetaSchema.safeParse(raw);
  if (!parsed.success) return null;

  // Extract workspace paths from turn metadata
  const turnMeta = m[TURN_METADATA_KEY] as Record<string, unknown> | undefined;
  const workspacesObj = turnMeta?.workspaces as
    | Record<string, unknown>
    | undefined;
  const workspaces = workspacesObj ? Object.keys(workspacesObj) : [];

  return {
    meta: parsed.data,
    workspaces,
  };
}

// ============================================================
// Path resolution
// ============================================================

/**
 * Resolve a sandbox path entry to concrete filesystem paths.
 * Symbolic kinds are expanded using the current runtime context.
 */
function resolveSandboxPath(
  entry: SandboxPathEntry,
  workspaces: string[],
): string[] {
  if (entry.type === "path") {
    return [entry.path];
  }

  const { kind, subpath } = entry.value;

  switch (kind) {
    case "root":
      return ["/"];
    case "project_roots": {
      if (subpath) {
        return workspaces.map((w) => `${w}/${subpath.replace(/^\/+/, "")}`);
      }
      return [...workspaces];
    }
    case "slash_tmp": {
      const paths = ["/tmp"];
      try {
        const rp = Deno.realPathSync("/tmp");
        if (rp !== "/tmp") paths.push(rp);
      } catch { /* best-effort */ }
      return paths;
    }
    case "tmpdir": {
      const tmp = Deno.env.get("TMPDIR") ?? "/tmp";
      const paths = [tmp];
      try {
        const rp = Deno.realPathSync(tmp);
        if (rp !== tmp) paths.push(rp);
      } catch { /* best-effort */ }
      return paths;
    }
  }
}

// ============================================================
// Permission extractors
// ============================================================

/**
 * Extract readable filesystem paths from the sandbox state.
 * Returns `["*"]` when filesystem is unrestricted.
 */
export function extractCodexReadablePaths(state: SandboxState): string[] {
  const pp = state.meta.permissionProfile;
  const fs = pp.file_system;

  if (fs.type === "unrestricted") return ["*"];

  const paths: string[] = [];
  for (const entry of fs.entries) {
    if (entry.access === "read") {
      paths.push(...resolveSandboxPath(entry.path, state.workspaces));
    }
  }
  return paths;
}

/**
 * Extract writable filesystem paths from the sandbox state.
 * Returns `["*"]` when filesystem is unrestricted.
 */
export function extractCodexWritablePaths(state: SandboxState): string[] {
  const pp = state.meta.permissionProfile;
  const fs = pp.file_system;

  if (fs.type === "unrestricted") return ["*"];

  const paths: string[] = [];
  for (const entry of fs.entries) {
    if (entry.access === "write") {
      paths.push(...resolveSandboxPath(entry.path, state.workspaces));
    }
  }
  return paths;
}

/**
 * Extract network target domains from the sandbox state.
 * Returns `["*"]` when network is enabled or unrestricted.
 */
export function extractCodexNetworkTargets(state: SandboxState): string[] {
  const pp = state.meta.permissionProfile;

  if (pp.network === "enabled" || state.meta.sandboxPolicy.network_access) {
    return ["*"];
  }
  return [];
}

/**
 * Return the sandbox-policy type string (e.g. "workspace-write").
 */
export function getSandboxPolicy(state: SandboxState): string {
  return state.meta.sandboxPolicy.type;
}

// ============================================================
// Path intersection
// ============================================================

/**
 * Intersect a list of requested paths against the allowed set.
 *
 * - If allowed includes `"*"`, all requested paths match.
 * - Otherwise, prefix matching: a requested path matches if it starts
 *   with any allowed path, or if an allowed path starts with it.
 *
 * Returns matched and dropped arrays.
 */
export function intersectPaths(
  requested: string[],
  allowed: string[],
): { matched: string[]; dropped: string[] } {
  if (allowed.length === 0) {
    return { matched: [], dropped: [...requested] };
  }

  if (allowed.includes("*")) {
    return { matched: [...requested], dropped: [] };
  }

  const matched: string[] = [];
  const dropped: string[] = [];

  for (const r of requested) {
    const ok = allowed.some(
      (a) => r.startsWith(a) || a.startsWith(r),
    );
    if (ok) {
      matched.push(r);
    } else {
      dropped.push(r);
    }
  }

  return { matched, dropped };
}
