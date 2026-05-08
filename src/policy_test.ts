import { assertEquals } from "@std/assert";
import {
  resolvePermissions,
  isForbidden,
  DEFAULT_POLICY,
  type ServerPolicy,
} from "./policy.ts";

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
