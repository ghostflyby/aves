// Aves MCP prompt — lazy-loaded singleton from aves-guide.md

const GUIDE_URL = new URL("./aves-guide.md", import.meta.url);

let _cached: string | null = null;

async function loadGuide(): Promise<string> {
  if (_cached !== null) return _cached;
  _cached = await Deno.readTextFile(GUIDE_URL);
  return _cached;
}

export const AVES_PROMPT_NAME = "aves-guide";
export const AVES_PROMPT_DESCRIPTION =
  "How to use Aves for sandboxed Deno script execution";

export async function buildAvesPrompt(): Promise<string> {
  return await loadGuide();
}
