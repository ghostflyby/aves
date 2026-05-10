import { assertEquals } from "@std/assert";
import {
  isForbidden,
  resolvePermissions,
  type ServerPolicy,
} from "./policy.ts";
import {
  applyCodexCeiling,
  isReadOnly,
  isWithinCodexCeiling,
} from "./policy.ts";
import type { SandboxState } from "./sandbox-state.ts";

Deno.test("resolvePermissions - grants requested perms by default", () => {
  const { granted, denied } = resolvePermissions({
    read: ["/tmp"],
    net: ["api.github.com"],
  });
  assertEquals(granted.read, ["/tmp"]);
  assertEquals(granted.net, ["api.github.com"]);
  assertEquals(denied, []);
});

Deno.test("resolvePermissions - empty request yields empty grant", () => {
  const { granted, denied } = resolvePermissions({});
  assertEquals(granted, {});
  assertEquals(denied, []);
});

Deno.test("resolvePermissions - policy can deny specific keys", () => {
  const policy: ServerPolicy = {
    rules: { net: { allow: false } },
    default_action: "allow",
  };
  const { granted, denied } = resolvePermissions(
    { net: ["api.github.com"] },
    policy,
  );
  assertEquals(granted.net, undefined);
  assertEquals(denied, ["net"]);
});

Deno.test("resolvePermissions - policy can restrict net to patterns", () => {
  const policy: ServerPolicy = {
    rules: { net: { allow: true, path_patterns: ["api.github.com"] } },
    default_action: "deny",
  };
  const { granted, denied } = resolvePermissions(
    { net: ["api.github.com", "example.com"] },
    policy,
  );
  assertEquals(granted.net, ["api.github.com"]);
  assertEquals(denied, []);
});

Deno.test("resolvePermissions - non-matching pattern denied", () => {
  const policy: ServerPolicy = {
    rules: { net: { allow: true, path_patterns: ["api.github.com"] } },
    default_action: "deny",
  };
  const { granted, denied } = resolvePermissions(
    { net: ["example.com"] },
    policy,
  );
  assertEquals(granted.net, undefined);
  assertEquals(denied, ["net"]);
});

Deno.test("resolvePermissions - policy with default deny", () => {
  const policy: ServerPolicy = {
    rules: {},
    default_action: "deny",
  };
  const { granted, denied } = resolvePermissions(
    { read: ["/tmp"] },
    policy,
  );
  assertEquals(granted.read, undefined);
  assertEquals(denied, ["read"]);
});

Deno.test("isForbidden - run and ffi", () => {
  assertEquals(isForbidden("run"), true);
  assertEquals(isForbidden("ffi"), true);
  assertEquals(isForbidden("read"), false);
  assertEquals(isForbidden("net"), false);
});

// ============================================================
// applyCodexCeiling, isWithinCodexCeiling, isReadOnly tests
// ============================================================

/** Mock sandbox state with restricted read/write but network disabled (no net). */
const mockRestrictedNoNet: SandboxState = {
  meta: {
    permissionProfile: {
      type: "managed",
      file_system: {
        type: "restricted",
        entries: [
          {
            path: { type: "path", path: "/Users/ghostflyby/repos/learn/aves" },
            access: "read",
          },
          {
            path: { type: "path", path: "/Users/ghostflyby/repos/learn/aves" },
            access: "write",
          },
          { path: { type: "path", path: "/tmp" }, access: "write" },
        ],
      },
      network: "disabled",
    },
    sandboxPolicy: {
      type: "workspace-write",
      writable_roots: [],
      network_access: false,
      exclude_tmpdir_env_var: false,
      exclude_slash_tmp: false,
    },
    codexLinuxSandboxExe: null,
    sandboxCwd: "/Users/ghostflyby/repos/learn/aves",
    useLegacyLandlock: false,
  },
  workspaces: ["/Users/ghostflyby/repos/learn/aves"],
};

/** Mock sandbox state with network fully enabled. */
const mockRestrictedWithNet: SandboxState = {
  ...mockRestrictedNoNet,
  meta: {
    ...mockRestrictedNoNet.meta,
    permissionProfile: {
      ...mockRestrictedNoNet.meta.permissionProfile,
      network: "enabled",
    },
    sandboxPolicy: {
      ...mockRestrictedNoNet.meta.sandboxPolicy,
      network_access: true,
    },
  },
};

Deno.test("applyCodexCeiling - read within ceiling", () => {
  const { granted, dropped } = applyCodexCeiling(
    { read: ["/Users/ghostflyby/repos/learn/aves/src"] },
    mockRestrictedNoNet,
  );
  assertEquals(granted.read, ["/Users/ghostflyby/repos/learn/aves/src"]);
  assertEquals(dropped.read, undefined);
});

Deno.test("applyCodexCeiling - read outside ceiling", () => {
  const { granted, dropped } = applyCodexCeiling(
    { read: ["/etc/passwd"] },
    mockRestrictedNoNet,
  );
  assertEquals(granted.read, undefined);
  assertEquals(dropped.read, ["/etc/passwd"]);
});

Deno.test("applyCodexCeiling - write within ceiling", () => {
  const { granted, dropped } = applyCodexCeiling(
    { write: ["/tmp/myfile"] },
    mockRestrictedNoNet,
  );
  assertEquals(granted.write, ["/tmp/myfile"]);
  assertEquals(dropped.write, undefined);
});

Deno.test("applyCodexCeiling - write outside ceiling", () => {
  const { granted, dropped } = applyCodexCeiling(
    { write: ["/etc/hosts"] },
    mockRestrictedNoNet,
  );
  assertEquals(granted.write, undefined);
  assertEquals(dropped.write, ["/etc/hosts"]);
});

Deno.test("applyCodexCeiling - net allowed when network enabled", () => {
  const { granted, dropped } = applyCodexCeiling(
    { net: ["api.github.com", "evil.com"] },
    mockRestrictedWithNet,
  );
  // network is fully enabled, all targets pass
  assertEquals(granted.net, ["api.github.com", "evil.com"]);
  assertEquals(dropped.net, undefined);
});

Deno.test("applyCodexCeiling - net dropped when network disabled", () => {
  const { granted, dropped } = applyCodexCeiling(
    { net: ["api.github.com"] },
    mockRestrictedNoNet,
  );
  assertEquals(granted.net, undefined);
  assertEquals(dropped.net, ["api.github.com"]);
});

Deno.test("applyCodexCeiling - mixed read+write+net", () => {
  const { granted, dropped } = applyCodexCeiling(
    {
      read: ["/Users/ghostflyby/repos/learn/aves/src", "/etc/shadow"],
      write: ["/tmp/ok", "/etc/nope"],
      net: ["api.github.com", "evil.com"],
    },
    mockRestrictedWithNet,
  );
  assertEquals(granted.read, ["/Users/ghostflyby/repos/learn/aves/src"]);
  assertEquals(dropped.read, ["/etc/shadow"]);
  assertEquals(granted.write, ["/tmp/ok"]);
  assertEquals(dropped.write, ["/etc/nope"]);
  // network is fully enabled, all net passes
  assertEquals(granted.net, ["api.github.com", "evil.com"]);
  assertEquals(dropped.net, undefined);
});

Deno.test("applyCodexCeiling - null sandbox state passes all", () => {
  const { granted, dropped } = applyCodexCeiling(
    { read: ["/anywhere"], write: ["/anywhere"], net: ["anything.com"] },
    null,
  );
  assertEquals(granted.read, ["/anywhere"]);
  assertEquals(granted.write, ["/anywhere"]);
  assertEquals(granted.net, ["anything.com"]);
  assertEquals(dropped.read, undefined);
  assertEquals(dropped.write, undefined);
  assertEquals(dropped.net, undefined);
});

Deno.test("isWithinCodexCeiling - true when no drops", () => {
  assertEquals(isWithinCodexCeiling({}), true);
});

Deno.test("isWithinCodexCeiling - false when read dropped", () => {
  assertEquals(isWithinCodexCeiling({ read: ["/etc/passwd"] }), false);
});

Deno.test("isWithinCodexCeiling - false when write dropped", () => {
  assertEquals(isWithinCodexCeiling({ write: ["/etc/hosts"] }), false);
});

Deno.test("isReadOnly - true for read only", () => {
  assertEquals(isReadOnly({ read: ["/tmp"] }), true);
});

Deno.test("isReadOnly - false with write", () => {
  assertEquals(isReadOnly({ read: ["/tmp"], write: ["/tmp"] }), false);
});

Deno.test("isReadOnly - false with net", () => {
  assertEquals(isReadOnly({ read: ["/tmp"], net: ["example.com"] }), false);
});

Deno.test("isReadOnly - false with env", () => {
  assertEquals(isReadOnly({ read: ["/tmp"], env: ["FOO"] }), false);
});

Deno.test("isReadOnly - false with no read", () => {
  assertEquals(isReadOnly({ write: ["/tmp"] }), false);
});
