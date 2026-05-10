// ============================================================
// sandbox-state_test.ts — unit tests for sandbox-state
// ============================================================

import {
  extractCodexNetworkTargets,
  extractCodexReadablePaths,
  extractCodexWritablePaths,
  extractSandboxState,
  getSandboxPolicy,
  intersectPaths,
} from "./sandbox-state.ts";

import type { SandboxState, SandboxStateMeta } from "./sandbox-state.ts";

// ============================================================
// Helpers
// ============================================================

/** Wrap sandbox payload in the full _meta shape that extractSandboxState expects. */
function makeMeta(raw: unknown, workspaces?: Record<string, unknown>): unknown {
  return {
    "codex/sandbox-state-meta": raw,
    "x-codex-turn-metadata": {
      workspaces: workspaces ?? { "/home/user/project": {} },
    },
  };
}

function makePermissionProfile(
  fsType: "restricted" | "unrestricted",
  entries: SandboxState["meta"]["permissionProfile"]["file_system"]["entries"],
  network?: string,
): SandboxState["meta"]["permissionProfile"] {
  return {
    type: "managed",
    file_system: { type: fsType, entries },
    network: network ?? "disabled",
  };
}

function makeSandboxPolicy(
  overrides?: Partial<SandboxState["meta"]["sandboxPolicy"]>,
): SandboxState["meta"]["sandboxPolicy"] {
  return {
    type: "workspace-write",
    writable_roots: [],
    network_access: false,
    exclude_tmpdir_env_var: false,
    exclude_slash_tmp: false,
    ...overrides,
  };
}

function makeRestrictedState(
  entries: SandboxState["meta"]["permissionProfile"]["file_system"]["entries"],
  workspaces?: Record<string, unknown>,
): { meta: unknown; workspaces: string[] } {
  return {
    meta: {
      permissionProfile: makePermissionProfile(
        "restricted",
        entries,
        "disabled",
      ),
      sandboxPolicy: makeSandboxPolicy(),
      codexLinuxSandboxExe: null,
      sandboxCwd: "/home/user/project",
      useLegacyLandlock: false,
    },
    workspaces: Object.keys(workspaces ?? { "/home/user/project": {} }),
  };
}

function pathLiteral(p: string) {
  return { type: "path" as const, path: p };
}

function pathSpecial(
  kind: "root" | "project_roots" | "slash_tmp" | "tmpdir",
  subpath?: string,
) {
  return {
    type: "special" as const,
    value: { kind, ...(subpath ? { subpath } : {}) },
  };
}

// ============================================================
// extractSandboxState
// ============================================================

Deno.test("extractSandboxState — null / missing input", () => {
  console.assert(extractSandboxState(null) === null, "null");
  console.assert(extractSandboxState(undefined) === null, "undefined");
  console.assert(extractSandboxState(42) === null, "number");
  console.assert(extractSandboxState({}) === null, "empty object");
  console.assert(
    extractSandboxState({ "codex/sandbox-state-meta": null }) === null,
    "capability key with null value",
  );
  console.assert(
    extractSandboxState({
      other_key: { sandboxPolicy: {}, sandboxCwd: "/x" },
    }) === null,
    "wrong key",
  );
});

Deno.test("extractSandboxState — valid payload", () => {
  const rawMeta: SandboxStateMeta = {
    permissionProfile: makePermissionProfile("restricted", [
      { path: pathLiteral("/tmp"), access: "read" },
      { path: pathLiteral("/workspace"), access: "write" },
    ]),
    sandboxPolicy: makeSandboxPolicy(),
    codexLinuxSandboxExe: null,
    sandboxCwd: "/home/user/project",
    useLegacyLandlock: false,
  };
  const result = extractSandboxState(
    makeMeta(rawMeta, { "/home/user/project": {}, "/other": {} }),
  );
  console.assert(result !== null, "should extract");
  console.assert(result!.meta.sandboxPolicy.type === "workspace-write");
  console.assert(result!.meta.sandboxCwd === "/home/user/project");
  console.assert(result!.meta.useLegacyLandlock === false);
  console.assert(result!.workspaces.length === 2);
  console.assert(result!.workspaces.includes("/home/user/project"));
  console.assert(result!.workspaces.includes("/other"));
});

Deno.test("extractSandboxState — malformed (missing permissionProfile)", () => {
  const result = extractSandboxState(makeMeta({
    sandboxPolicy: makeSandboxPolicy(),
    sandboxCwd: "/x",
  }));
  console.assert(
    result === null,
    "missing permissionProfile should return null",
  );
});

Deno.test("extractSandboxState — malformed (missing sandboxPolicy)", () => {
  const result = extractSandboxState(makeMeta({
    permissionProfile: makePermissionProfile("restricted", []),
    sandboxCwd: "/x",
  }));
  console.assert(result === null, "missing sandboxPolicy should return null");
});

Deno.test("extractSandboxState — malformed (missing sandboxCwd)", () => {
  const result = extractSandboxState(makeMeta({
    permissionProfile: makePermissionProfile("restricted", []),
    sandboxPolicy: makeSandboxPolicy(),
  }));
  console.assert(result === null, "missing sandboxCwd should return null");
});

Deno.test("extractSandboxState — no workspaces in turn metadata", () => {
  const rawMeta: SandboxStateMeta = {
    permissionProfile: makePermissionProfile("restricted", []),
    sandboxPolicy: makeSandboxPolicy(),
    codexLinuxSandboxExe: null,
    sandboxCwd: "/x",
    useLegacyLandlock: false,
  };
  const result = extractSandboxState({
    "codex/sandbox-state-meta": rawMeta,
  });
  console.assert(result !== null, "should extract without workspaces");
  console.assert(result!.workspaces.length === 0);
});

// ============================================================
// extractCodexReadablePaths
// ============================================================

Deno.test("extractCodexReadablePaths — restricted entries", () => {
  const state = makeRestrictedState([
    { path: pathLiteral("/tmp"), access: "read" },
    { path: pathLiteral("/workspace"), access: "write" },
    { path: pathLiteral("/home"), access: "read" },
  ]) as SandboxState;
  const paths = extractCodexReadablePaths(state);
  console.assert(paths.length === 2, `expected 2, got ${paths.length}`);
  console.assert(paths.includes("/tmp"));
  console.assert(paths.includes("/home"));
  console.assert(!paths.includes("/workspace"));
});

Deno.test("extractCodexReadablePaths — unrestricted", () => {
  const state = {
    meta: {
      permissionProfile: makePermissionProfile("unrestricted", []),
      sandboxPolicy: makeSandboxPolicy(),
      codexLinuxSandboxExe: null,
      sandboxCwd: "/x",
      useLegacyLandlock: false,
    },
    workspaces: [],
  } as SandboxState;
  const paths = extractCodexReadablePaths(state);
  console.assert(paths.length === 1);
  console.assert(paths[0] === "*");
});

Deno.test("extractCodexReadablePaths — resolves project_roots", () => {
  const state = {
    meta: {
      permissionProfile: makePermissionProfile("restricted", [
        { path: pathSpecial("project_roots"), access: "read" },
      ]),
      sandboxPolicy: makeSandboxPolicy(),
      codexLinuxSandboxExe: null,
      sandboxCwd: "/x",
      useLegacyLandlock: false,
    },
    workspaces: ["/ws1", "/ws2"],
  } as SandboxState;
  const paths = extractCodexReadablePaths(state);
  console.assert(paths.length === 2, `expected 2, got ${paths}`);
  console.assert(paths.includes("/ws1"));
  console.assert(paths.includes("/ws2"));
});

Deno.test("extractCodexReadablePaths — resolves project_roots with subpath", () => {
  const state = {
    meta: {
      permissionProfile: makePermissionProfile("restricted", [
        { path: pathSpecial("project_roots", ".git"), access: "read" },
      ]),
      sandboxPolicy: makeSandboxPolicy(),
      codexLinuxSandboxExe: null,
      sandboxCwd: "/x",
      useLegacyLandlock: false,
    },
    workspaces: ["/ws1"],
  } as SandboxState;
  const paths = extractCodexReadablePaths(state);
  console.assert(paths.length === 1);
  console.assert(paths[0] === "/ws1/.git");
});

Deno.test("extractCodexReadablePaths — resolves root", () => {
  const state = {
    meta: {
      permissionProfile: makePermissionProfile("restricted", [
        { path: pathSpecial("root"), access: "read" },
      ]),
      sandboxPolicy: makeSandboxPolicy(),
      codexLinuxSandboxExe: null,
      sandboxCwd: "/x",
      useLegacyLandlock: false,
    },
    workspaces: [],
  } as SandboxState;
  const paths = extractCodexReadablePaths(state);
  console.assert(paths.length === 1);
  console.assert(paths[0] === "/");
});

Deno.test("extractCodexReadablePaths — resolves slash_tmp", () => {
  const state = {
    meta: {
      permissionProfile: makePermissionProfile("restricted", [
        { path: pathSpecial("slash_tmp"), access: "read" },
      ]),
      sandboxPolicy: makeSandboxPolicy(),
      codexLinuxSandboxExe: null,
      sandboxCwd: "/x",
      useLegacyLandlock: false,
    },
    workspaces: [],
  } as SandboxState;
  const paths = extractCodexReadablePaths(state);
  console.assert(paths.length === 1);
  console.assert(paths[0] === "/tmp");
});

// ============================================================
// extractCodexWritablePaths
// ============================================================

Deno.test("extractCodexWritablePaths — restricted entries", () => {
  const state = makeRestrictedState([
    { path: pathLiteral("/tmp"), access: "read" },
    { path: pathLiteral("/workspace"), access: "write" },
    { path: pathLiteral("/home"), access: "write" },
  ]) as SandboxState;
  const paths = extractCodexWritablePaths(state);
  console.assert(paths.length === 2);
  console.assert(paths.includes("/workspace"));
  console.assert(paths.includes("/home"));
  console.assert(!paths.includes("/tmp"));
});

Deno.test("extractCodexWritablePaths — unrestricted", () => {
  const state = {
    meta: {
      permissionProfile: makePermissionProfile("unrestricted", []),
      sandboxPolicy: makeSandboxPolicy(),
      codexLinuxSandboxExe: null,
      sandboxCwd: "/x",
      useLegacyLandlock: false,
    },
    workspaces: [],
  } as SandboxState;
  const paths = extractCodexWritablePaths(state);
  console.assert(paths.length === 1);
  console.assert(paths[0] === "*");
});

// ============================================================
// extractCodexNetworkTargets
// ============================================================

Deno.test("extractCodexNetworkTargets — network enabled", () => {
  const state = {
    meta: {
      permissionProfile: makePermissionProfile("restricted", [], "enabled"),
      sandboxPolicy: makeSandboxPolicy({ network_access: false }),
      codexLinuxSandboxExe: null,
      sandboxCwd: "/x",
      useLegacyLandlock: false,
    },
    workspaces: [],
  } as SandboxState;
  const targets = extractCodexNetworkTargets(state);
  console.assert(targets.length === 1);
  console.assert(targets[0] === "*");
});

Deno.test("extractCodexNetworkTargets — policy network_access true", () => {
  const state = {
    meta: {
      permissionProfile: makePermissionProfile("restricted", [], "disabled"),
      sandboxPolicy: makeSandboxPolicy({ network_access: true }),
      codexLinuxSandboxExe: null,
      sandboxCwd: "/x",
      useLegacyLandlock: false,
    },
    workspaces: [],
  } as SandboxState;
  const targets = extractCodexNetworkTargets(state);
  console.assert(targets.length === 1);
  console.assert(targets[0] === "*");
});

Deno.test("extractCodexNetworkTargets — network disabled", () => {
  const state = {
    meta: {
      permissionProfile: makePermissionProfile("restricted", [], "disabled"),
      sandboxPolicy: makeSandboxPolicy({ network_access: false }),
      codexLinuxSandboxExe: null,
      sandboxCwd: "/x",
      useLegacyLandlock: false,
    },
    workspaces: [],
  } as SandboxState;
  const targets = extractCodexNetworkTargets(state);
  console.assert(targets.length === 0);
});

// ============================================================
// getSandboxPolicy
// ============================================================

Deno.test("getSandboxPolicy", () => {
  const state = makeRestrictedState([]) as SandboxState;
  console.assert(getSandboxPolicy(state) === "workspace-write");
});

// ============================================================
// intersectPaths
// ============================================================

Deno.test("intersectPaths — empty allowed", () => {
  const r = intersectPaths(["/a", "/b"], []);
  console.assert(r.matched.length === 0);
  console.assert(r.dropped.length === 2);
});

Deno.test("intersectPaths — wildcard allowed", () => {
  const r = intersectPaths(["/a", "/b", "/c"], ["*"]);
  console.assert(r.matched.length === 3);
  console.assert(r.dropped.length === 0);
});

Deno.test("intersectPaths — prefix matching", () => {
  const r = intersectPaths(
    ["/workspace/src/a.ts", "/workspace/test/b.ts", "/tmp/x.ts"],
    ["/workspace"],
  );
  console.assert(r.matched.length === 2, `matched: ${r.matched}`);
  console.assert(r.dropped.length === 1, `dropped: ${r.dropped}`);
  console.assert(r.dropped[0] === "/tmp/x.ts");
});

Deno.test("intersectPaths — exact match", () => {
  const r = intersectPaths(["/tmp"], ["/tmp"]);
  console.assert(r.matched.length === 1);
  console.assert(r.dropped.length === 0);
});

Deno.test("intersectPaths — parent match (requested dir, allowed file)", () => {
  const r = intersectPaths(
    ["/workspace"],
    ["/workspace/src/a.ts"],
  );
  console.assert(r.matched.length === 1, "parent path should match child");
  console.assert(r.dropped.length === 0);
});
