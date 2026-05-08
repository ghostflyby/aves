import { parse as parseToml } from "@std/toml";
import { getAvesConfigDir, getAvesDataDir } from "./paths.ts";
import os from "node:os";

/**
 * Resolve a path string with ~ expansion and $VAR / ${VAR} env substitution.
 */
export function resolvePath(raw: string): string {
  let resolved = raw;

  // ~ expansion
  if (resolved.startsWith("~")) {
    const home = os.homedir();
    resolved = resolved.replace(/^~/, home);
  }

  // $VAR and ${VAR} env substitution
  resolved = resolved.replace(
    /\$(\w+|\{(\w+)\})/g,
    (_match, p1) => {
      const varName = p1.startsWith("{") ? p1.slice(1, -1) : p1;
      return Deno.env.get(varName) ?? "";
    },
  );

  return resolved;
}

export interface AvesConfig {
  skillRoots: string[];
}

const DEFAULT_CONFIG: AvesConfig = {
  skillRoots: [],
};

let _parsedConfig: AvesConfig | null = null;

function getConfigPath(): string {
  return `${getAvesConfigDir()}/config.toml`;
}

/**
 * Parse aves config.toml.
 * Returns default config if file is missing or unreadable.
 */
export async function parseConfig(): Promise<AvesConfig> {
  const configPath = getConfigPath();
  try {
    const raw = await Deno.readTextFile(configPath);
    const parsed = parseToml(raw) as Record<string, unknown>;

    const skillRootsRaw = parsed.skill_roots;
    const skillRoots: string[] = [];
    if (Array.isArray(skillRootsRaw)) {
      for (const entry of skillRootsRaw) {
        if (typeof entry === "string" && entry.trim()) {
          skillRoots.push(resolvePath(entry.trim()));
        }
      }
    }

    _parsedConfig = { ...DEFAULT_CONFIG, skillRoots };
    return _parsedConfig;
  } catch {
    _parsedConfig = { ...DEFAULT_CONFIG };
    return _parsedConfig;
  }
}

/**
 * Get the default (built-in) skill root under the aves data directory.
 */
export function getDefaultSkillRoot(): string {
  return `${getAvesDataDir()}/skills`;
}

/**
 * Get all configured skill roots. Default root always comes first.
 */
export async function getSkillRoots(): Promise<string[]> {
  const config = _parsedConfig ?? await parseConfig();
  const defaultRoot = getDefaultSkillRoot();
  const extraRoots = config.skillRoots.filter((r) => r !== defaultRoot);
  return [defaultRoot, ...extraRoots];
}

/**
 * Ensure all skill root directories exist.
 */
export async function ensureSkillRoots(): Promise<void> {
  const roots = await getSkillRoots();
  for (const root of roots) {
    await Deno.mkdir(root, { recursive: true });
  }
}

/**
 * Find the first writable skill root. Default root should always be writable.
 */
export async function getWritableSkillRoot(): Promise<string> {
  const roots = await getSkillRoots();
  for (const root of roots) {
    try {
      // Check writability by trying to create dir
      await Deno.mkdir(root, { recursive: true });
      const testPath = `${root}/.aves-write-test`;
      await Deno.writeTextFile(testPath, "");
      await Deno.remove(testPath);
      return root;
    } catch {
      continue;
    }
  }
  // Last resort: use the default root
  return getDefaultSkillRoot();
}
