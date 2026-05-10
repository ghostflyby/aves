import { assertEquals } from "@std/assert";

// ============================================================
// Unit tests for helper function patterns
// (mirrors the private helpers in server.ts)
// ============================================================

/** Hash a string using SHA-256, return hex. */
async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder();
  const data = enc.encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Check if two permission objects match (same keys, sorted). */
function permissionsMatch(
  a: Record<string, string[] | undefined>,
  b: Record<string, string[] | undefined>,
): boolean {
  const allKeys = ["read", "write", "net", "env"] as const;
  for (const k of allKeys) {
    const aa = (a[k] ?? []).slice().sort();
    const bb = (b[k] ?? []).slice().sort();
    if (aa.length !== bb.length) return false;
    if (!aa.every((v, i) => v === bb[i])) return false;
  }
  return true;
}

Deno.test("sha256Hex - deterministic", async () => {
  const h1 = await sha256Hex("hello");
  const h2 = await sha256Hex("hello");
  assertEquals(h1, h2);
  assertEquals(typeof h1, "string");
  assertEquals(h1.length, 64);
});

Deno.test("sha256Hex - different inputs produce different hash", async () => {
  const h1 = await sha256Hex("hello");
  const h2 = await sha256Hex("world");
  assertEquals(h1 !== h2, true);
});

Deno.test("permissionsMatch - both empty", () => {
  assertEquals(permissionsMatch({}, {}), true);
});

Deno.test("permissionsMatch - same read paths (unsorted)", () => {
  assertEquals(
    permissionsMatch({ read: ["/tmp", "/home"] }, { read: ["/home", "/tmp"] }),
    true,
  );
});

Deno.test("permissionsMatch - different read paths", () => {
  assertEquals(
    permissionsMatch({ read: ["/tmp"] }, { read: ["/home"] }),
    false,
  );
});

Deno.test("permissionsMatch - extra key in one", () => {
  assertEquals(
    permissionsMatch(
      { read: ["/tmp"], write: ["/tmp"] },
      { read: ["/tmp"] },
    ),
    false,
  );
});

Deno.test("permissionsMatch - net sorted", () => {
  assertEquals(
    permissionsMatch(
      { net: ["b.com", "a.com"] },
      { net: ["a.com", "b.com"] },
    ),
    true,
  );
});

Deno.test("permissionsMatch - env match", () => {
  assertEquals(
    permissionsMatch({ env: ["FOO", "BAR"] }, { env: ["BAR", "FOO"] }),
    true,
  );
});

Deno.test("permissionsMatch - env mismatch", () => {
  assertEquals(
    permissionsMatch({ env: ["FOO"] }, { env: ["BAR"] }),
    false,
  );
});

Deno.test("permissionsMatch - undefined vs empty array", () => {
  assertEquals(
    permissionsMatch({ read: undefined }, { read: [] }),
    true,
  );
});
