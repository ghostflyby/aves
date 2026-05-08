/**
 * Generate the boot wrapper script content.
 * The boot wrapper is the process entry point.
 *
 * Module path comes from Deno.args[0] -- the runner passes the
 * local filesystem path directly. No file copying needed.
 *
 * It:
 * 1. Imports user module from Deno.args[0] via dynamic import
 * 2. Reads input.json
 * 3. If inputSchema exists: parses with Zod,
 *    writes parsed_input.json + schema_hash.txt
 * 4. Calls main(input)
 * 5. Writes output.json
 */
export function generateBootWrapper(): string {
  return `const modulePath = Deno.args[0];
const userMod = await import(modulePath);
const userMain = userMod.default;
const inputSchema = userMod.inputSchema;

const raw = JSON.parse(
  await Deno.readTextFile("./input.json")
);

let input = raw;
if (inputSchema) {
  const result = inputSchema.safeParse(raw);
  if (!result.success) {
    await Deno.writeTextFile(
      "./output.json",
      JSON.stringify({ ok: false, error: result.error.message })
    );
    Deno.exit(1);
  }
  input = result.data;

  await Deno.writeTextFile(
    "./parsed_input.json",
    JSON.stringify(input)
  );

  const schemaJson = JSON.stringify(inputSchema, (_key, value) =>
    typeof value === "function" ? undefined : value
  );
  const _enc = new TextEncoder();
  const _data = _enc.encode(schemaJson);
  const _hashBuf = await crypto.subtle.digest("SHA-256", _data);
  const _hashArr = Array.from(new Uint8Array(_hashBuf));
  const _hashHex = _hashArr.map((b: number) => b.toString(16).padStart(2, "0")).join("");
  await Deno.writeTextFile("./schema_hash.txt", _hashHex);
}

try {
  const output = await userMain(input);
  await Deno.writeTextFile(
    "./output.json",
    JSON.stringify({ ok: true, data: output })
  );
} catch (err) {
  await Deno.writeTextFile(
    "./output.json",
    JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) })
  );
  Deno.exit(1);
}
`;
}
