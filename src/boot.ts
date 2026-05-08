/**
 * Generate the boot wrapper script content.
 * The boot wrapper is the real entry point for a sandboxed run.
 * It imports the user module, parses input via Zod, calls main(), and writes output.
 */
export function generateBootWrapper(): string {
  return `const userMod = await import("./user_module.ts");
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
