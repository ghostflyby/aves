// Aves boot wrapper — sandboxed process entry point.
// This file runs inside the child Deno process.
// The module to import comes from Deno.args[0].
// The cwd is set to the run directory (contains input.json).

const modulePath = Deno.args[0];
const userMod = await import(modulePath);
const userMain = userMod.default;
const inputSchema = userMod.inputSchema;

const raw = JSON.parse(
  await Deno.readTextFile("./input.json"),
);

let input = raw;
if (inputSchema) {
  const result = inputSchema.safeParse(raw);
  if (!result.success) {
    await Deno.writeTextFile(
      "./output.json",
      JSON.stringify({ ok: false, error: result.error.message }),
    );
    Deno.exit(1);
  }
  input = result.data;

  await Deno.writeTextFile("./parsed_input.json", JSON.stringify(input));

  const schemaJson = JSON.stringify(inputSchema, (_key, value) =>
    typeof value === "function" ? undefined : value
  );
  const _enc = new TextEncoder();
  const _data = _enc.encode(schemaJson);
  const _hashBuf = await crypto.subtle.digest("SHA-256", _data);
  const _hashArr = Array.from(new Uint8Array(_hashBuf));
  const _hashHex = _hashArr.map((b) => b.toString(16).padStart(2, "0")).join("");
  await Deno.writeTextFile("./schema_hash.txt", _hashHex);
}

try {
  const output = await userMain(input);
  await Deno.writeTextFile(
    "./output.json",
    JSON.stringify({ ok: true, data: output }),
  );
} catch (err) {
  await Deno.writeTextFile(
    "./output.json",
    JSON.stringify({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  Deno.exit(1);
}
