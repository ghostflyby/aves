// Aves boot wrapper — sandboxed process entry point.
// This file runs inside the child Deno process.
// The module to import comes from Deno.args[0].
// Input/output files are at paths in AVES_IO_DIR env var (or cwd as fallback).

const modulePath = Deno.args[0];
const ioDir = Deno.env.get("AVES_IO_DIR") ?? Deno.cwd();
const inputPath = `${ioDir}/input.json`;
const outputPath = `${ioDir}/output.json`;
const parsedInputPath = `${ioDir}/parsed_input.json`;
const schemaHashPath = `${ioDir}/schema_hash.txt`;
const schemaPath = `${ioDir}/schema.json`;

const userMod = await import(modulePath);
const userMain = userMod.default;
const inputSchema = userMod.inputSchema;

const raw = JSON.parse(await Deno.readTextFile(inputPath));

let input = raw;
if (inputSchema) {
  const result = inputSchema.safeParse(raw);
  if (!result.success) {
    await Deno.writeTextFile(
      outputPath,
      JSON.stringify({ ok: false, error: result.error.message }),
    );
    Deno.exit(1);
  }
  input = result.data;

  await Deno.writeTextFile(parsedInputPath, JSON.stringify(input));

  const schemaJson = JSON.stringify(
    inputSchema,
    (_key, value) => typeof value === "function" ? undefined : value,
  );
  const _enc = new TextEncoder();
  const _data = _enc.encode(schemaJson);
  const _hashBuf = await crypto.subtle.digest("SHA-256", _data);
  const _hashArr = Array.from(new Uint8Array(_hashBuf));
  const _hashHex = _hashArr.map((b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  await Deno.writeTextFile(schemaHashPath, _hashHex);

  const jsonSchema = inputSchema.toJSONSchema();
  await Deno.writeTextFile(schemaPath, JSON.stringify(jsonSchema));
}

try {
  const output = await userMain(input);
  await Deno.writeTextFile(
    outputPath,
    JSON.stringify({ ok: true, data: output }),
  );
} catch (err) {
  await Deno.writeTextFile(
    outputPath,
    JSON.stringify({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  Deno.exit(1);
}
