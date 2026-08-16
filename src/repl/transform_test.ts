import { assertEquals, assertStringIncludes } from "@std/assert";
import { rewriteReferences, transform } from "./transform.ts";
import { replManager } from "../host/manager.ts";

// ============================================================
// Part 1: transform() tests (pure functions)
// ============================================================

Deno.test("transform - const", () => {
  const names = new Set<string>();
  const r = transform("const x = 1", names);
  assertStringIncludes(r, "$aves$scope.x = 1");
  assertEquals(names.has("x"), true);
});

Deno.test("transform - let", () => {
  const names = new Set<string>();
  const r = transform("let y = 2", names);
  assertStringIncludes(r, "$aves$scope.y = 2");
  assertEquals(names.has("y"), true);
});

Deno.test("transform - var", () => {
  const names = new Set<string>();
  const r = transform("var z = 3", names);
  assertStringIncludes(r, "$aves$scope.z = 3");
  assertEquals(names.has("z"), true);
});

Deno.test("transform - function", () => {
  const names = new Set<string>();
  const r = transform("function foo() {}", names);
  assertStringIncludes(r, "$aves$scope.foo = function foo()");
  assertEquals(names.has("foo"), true);
});

Deno.test("transform - class", () => {
  const names = new Set<string>();
  const r = transform("class Foo { static v = 1 }", names);
  assertStringIncludes(r, "$aves$scope.Foo = class Foo");
  assertEquals(names.has("Foo"), true);
});

Deno.test("transform - class with extends", () => {
  const names = new Set<string>();
  const r = transform("class Foo extends Base {}", names);
  assertStringIncludes(r, "$aves$scope.Foo = class Foo extends Base");
  assertEquals(names.has("Foo"), true);
});

Deno.test("transform - import default", () => {
  const names = new Set<string>();
  const r = transform('import x from "pkg"', names);
  assertStringIncludes(r, '$aves$scope.x = (await import("pkg")).default');
});

Deno.test("transform - import named", () => {
  const names = new Set<string>();
  const r = transform('import { a, b } from "pkg"', names);
  assertStringIncludes(r, '$aves$scope.a = (await import("pkg")).a');
  assertStringIncludes(r, '$aves$scope.b = (await import("pkg")).b');
});

Deno.test("transform - import namespace", () => {
  const names = new Set<string>();
  const r = transform('import * as m from "pkg"', names);
  assertStringIncludes(r, '$aves$scope.m = await import("pkg")');
});

Deno.test("transform - import side-effect", () => {
  const names = new Set<string>();
  const r = transform('import "pkg"', names);
  assertStringIncludes(r, 'await import("pkg")');
});

Deno.test("transform - export stripped", () => {
  const names = new Set<string>();
  const r = transform("export default 42", names);
  const inner = r.slice(r.indexOf("{") + 1, r.lastIndexOf("}"));
  assertEquals(inner.includes("export"), false);
});

Deno.test("transform - returns final expression", () => {
  const names = new Set<string>();
  names.add("x");
  const r = transform("x + 1", names);
  assertStringIncludes(r, "return $aves$scope.x + 1;");
});

Deno.test("transform - user may declare a variable named scope", () => {
  // The injection parameter is `$aves$scope`, so `scope` is an ordinary user
  // identifier: declaring and referencing it works normally and lands on the
  // persistent scope.
  const names = new Set<string>();
  const r = transform("const scope = 5; scope + 1", names);
  assertStringIncludes(r, "$aves$scope.scope = 5;");
  assertStringIncludes(r, "return $aves$scope.scope + 1;");
  assertEquals(names.has("scope"), true);
});

Deno.test("transform - user may reference scope across cells", () => {
  // `scope` is not reserved; a later cell referencing it resolves to the
  // user's own declared `scope`, not the injection parameter.
  const names = new Set<string>();
  transform("const x = 1", names);
  const r = transform("x + scope", names);
  assertStringIncludes(r, "return $aves$scope.x + scope;");
});

Deno.test("transform - user this stays untouched", () => {
  // `this` is a normal user expression inside the transformed body (the
  // scope travels via the `$aves$scope` parameter, not `this`).
  const names = new Set<string>();
  const r = transform("this", names);
  assertStringIncludes(r, "return this;");
});

Deno.test("transform - destructuring object", () => {
  const names = new Set<string>();
  const r = transform("const { a, b } = obj", names);
  assertStringIncludes(r, "$aves$scope.a");
  assertStringIncludes(r, "$aves$scope.b");
});

Deno.test("transform - destructuring array", () => {
  const names = new Set<string>();
  const r = transform("const [x, y] = arr", names);
  assertStringIncludes(r, "$aves$scope.x");
  assertStringIncludes(r, "$aves$scope.y");
});

Deno.test("transform - destructuring default", () => {
  const names = new Set<string>();
  const r = transform("const { a = 5 } = obj", names);
  assertStringIncludes(r, "$aves$scope.a");
  assertStringIncludes(r, "??");
});

Deno.test("transform - destructuring rest", () => {
  const names = new Set<string>();
  const r = transform("const [a, ...rest] = arr", names);
  assertStringIncludes(r, "$aves$scope.a");
  assertStringIncludes(r, "$aves$scope.rest");
});

Deno.test("transform - destructuring reads temporary from scope", () => {
  const names = new Set<string>();
  const r = transform("const { a, b } = { a: 2, b: 3 }; a + b", names);
  assertStringIncludes(r, "$aves$scope.__aves_tmp_");
  assertStringIncludes(r, ".a");
  assertStringIncludes(r, ".b");
  assertStringIncludes(r, "return $aves$scope.a + $aves$scope.b;");
});

// ============================================================
// Part 2: rewriteReferences() tests
// ============================================================

Deno.test("rewriteRef - basic", () => {
  const names = new Set<string>();
  names.add("x");
  const r = rewriteReferences("$aves$scope.x = 1", names);
  assertStringIncludes(r, "$aves$scope.x = 1");
});

Deno.test("rewriteRef - empty names", () => {
  const r = rewriteReferences("console.log(1)", new Set());
  assertEquals(r, "console.log(1)");
});

Deno.test("rewriteRef - undeclared not rewritten", () => {
  const names = new Set<string>();
  names.add("x");
  const r = rewriteReferences("console.log(y)", names);
  assertEquals(r.includes("$aves$scope.y"), false);
});

Deno.test("rewriteRef - closure reference", () => {
  const names = new Set<string>();
  names.add("x");
  const code = "$aves$scope.x = 1;\nfunction f() { return x; }";
  const r = rewriteReferences(code, names);
  assertStringIncludes(r, "return $aves$scope.x;");
});

Deno.test("rewriteRef - class reference", () => {
  const names = new Set<string>();
  names.add("Foo");
  const code = "$aves$scope.Foo = class Foo {};\nFoo.v;";
  const r = rewriteReferences(code, names);
  assertStringIncludes(r, "$aves$scope.Foo.v;");
});

Deno.test("rewriteRef - shadowed local", () => {
  const names = new Set<string>();
  names.add("x");
  const code = "$aves$scope.x = 1;\nfunction f() { const x = 2; return x; }";
  const r = rewriteReferences(code, names);
  assertStringIncludes(r, "return x;");
});

Deno.test("rewriteRef - arrow closure", () => {
  const names = new Set<string>();
  names.add("x");
  const code = "$aves$scope.x = 1;\nconst f = () => x;";
  const r = rewriteReferences(code, names);
  assertStringIncludes(r, "$aves$scope.x");
});

Deno.test("rewriteRef - $aves$scope.x is not rewritten", () => {
  const names = new Set<string>();
  names.add("x");
  const r = rewriteReferences("$aves$scope.x = 1;", names);
  assertEquals(r.includes("$aves$scope.x"), true);
  assertEquals(r.includes("$aves$scope.scope"), false);
});

Deno.test("rewriteRef - object literal keys are not rewritten", () => {
  const names = new Set<string>(["a", "b"]);
  const r = rewriteReferences("const obj = { a: b };", names);
  assertStringIncludes(r, "{ a: $aves$scope.b }");
  assertEquals(r.includes("$aves$scope.a:"), false);
});

Deno.test("rewriteRef - computed member property is rewritten", () => {
  const names = new Set<string>(["obj", "key"]);
  const r = rewriteReferences("obj[key];", names);
  assertStringIncludes(r, "$aves$scope.obj[$aves$scope.key]");
});

Deno.test("rewriteRef - $aves$scope.x computed property is rewritten", () => {
  const names = new Set<string>(["k"]);
  const r = rewriteReferences("$aves$scope.x[k];", names);
  assertStringIncludes(r, "$aves$scope.x[$aves$scope.k]");
});

// ============================================================
// Part 3: repl-boot integration tests
// Expressions auto-return from the async IIFE; declarations persist in $aves$scope.
// Tests focus on child-process protocol and state behavior.
// ============================================================

const BOOT_PATH = new URL("../host/boot.ts", import.meta.url).pathname;
const PROJECT_DIR = new URL("..", import.meta.url).pathname;
// esbuild-wasm reads its esbuild.wasm payload from the package directory at
// first transform; grant the child that one read explicitly.
const WASM_DIR =
  new URL("..", import.meta.resolve("esbuild-wasm/lib/browser.js"))
    .pathname;

async function bootEval(
  inputs: string[],
): Promise<Record<string, unknown>[]> {
  const cmd = new Deno.Command("deno", {
    args: [
      "run",
      "--no-prompt",
      "--allow-env",
      "--allow-read=.," + PROJECT_DIR + "," + WASM_DIR,
      "--allow-import=deno.land:443,jsr.io:443,esm.sh:443,raw.esm.sh:443,cdn.jsdelivr.net:443,raw.githubusercontent.com:443,gist.githubusercontent.com:443,registry.npmjs.org:443",
      BOOT_PATH,
    ],
    cwd: PROJECT_DIR,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });

  const proc = cmd.spawn();
  const writer = proc.stdin.getWriter();
  const enc = new TextEncoder();

  for (const line of inputs) {
    await writer.write(enc.encode(line + "\n"));
  }
  writer.releaseLock();
  proc.stdin.close();

  const out = await proc.output();

  return new TextDecoder()
    .decode(out.stdout)
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

Deno.test("repl-boot - evaluate expression", async () => {
  const r = await bootEval([
    '{"type":"eval","id":"1","code":"const x = 42"}',
    '{"type":"close"}',
  ]);
  assertEquals(r[0].ok, true);
});

Deno.test("repl-boot - state across evals", async () => {
  const r = await bootEval([
    '{"type":"eval","id":"1","code":"const x = 1"}',
    '{"type":"eval","id":"2","code":"const y = x + 1"}',
    '{"type":"close"}',
  ]);
  assertEquals(r[0].ok, true);
  assertEquals(r[1].ok, true);
});

Deno.test("repl-boot - class persists across evals", async () => {
  const r = await bootEval([
    '{"type":"eval","id":"1","code":"class Foo { static v = 42 }"}',
    '{"type":"eval","id":"2","code":"Foo.v"}',
    '{"type":"close"}',
  ]);
  assertEquals(r[0].ok, true);
  assertEquals(r[1].ok, true);
  assertEquals(r[1].data, 42);
});

Deno.test("repl-boot - top-level await", async () => {
  const r = await bootEval([
    '{"type":"eval","id":"1","code":"const p = await Promise.resolve(99); const q = p + 1"}',
    '{"type":"close"}',
  ]);
  assertEquals(r[0].ok, true);
});

Deno.test("repl-boot - import resolves", async () => {
  const r = await bootEval([
    '{"type":"eval","id":"1","code":"import { assertEquals } from \\"@std/assert\\"; const t = typeof assertEquals"}',
    '{"type":"close"}',
  ]);
  assertEquals(r[0].ok, true);
});

Deno.test("repl-boot - parse error", async () => {
  const r = await bootEval([
    '{"type":"eval","id":"1","code":"const x ="}',
    '{"type":"close"}',
  ]);
  assertEquals(r[0].ok, false);
});

Deno.test("repl-boot - runtime error", async () => {
  const r = await bootEval([
    '{"type":"eval","id":"1","code":"throw new Error(\\"boom\\")"}',
    '{"type":"close"}',
  ]);
  assertEquals(r[0].ok, false);
  assertStringIncludes(String(r[0].error ?? ""), "boom");
});

Deno.test("repl-boot - close message", async () => {
  const r = await bootEval([
    '{"type":"close"}',
  ]);
  assertEquals(r[0].type, "closed");
});

Deno.test("repl-boot - ignores malformed", async () => {
  const r = await bootEval([
    "garbage",
    '{"type":"eval","id":"2","code":"const z = 1"}',
    '{"type":"close"}',
  ]);
  assertEquals(r[0].type, "result");
  assertEquals(r[0].id, "2");
  assertEquals(r[0].ok, true);
});

// ============================================================
// Part 4: ReplManager tests
// ============================================================

Deno.test("ReplManager.eval - unknown", async () => {
  const r1 = await replManager.eval("nonexistent", "1");
  assertEquals(r1.ok, false);
  assertStringIncludes(r1.error!, "session not found");
});

Deno.test("ReplManager.close - unknown", async () => {
  const r2 = await replManager.close("nonexistent");
  assertEquals(r2, false);
});
