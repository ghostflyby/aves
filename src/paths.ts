import * as os from "os";

/**
 * Aves data directory.
 *
 * Resolution order:
 * 1. $AVES_DATA_DIR (override)
 * 2. Platform-specific default:
 *    - macOS: ~/Library/Application Support/aves/
 *    - Windows: %LocalAppData%/aves/  (fallback: ~/AppData/Local/aves/)
 *    - Other: $XDG_DATA_HOME/aves/  (fallback: ~/.local/share/aves/)
 * 3. Fallback: /tmp/aves/data
 */
export function getAvesDataDir(): string {
  const override = Deno.env.get("AVES_DATA_DIR");
  if (override) return override;

  const home = os.homedir();
  const system = Deno.build.os;

  if (system === "darwin") {
    // macOS: ~/Library/Application Support/aves/
    if (home) return `${home}/Library/Application Support/aves`;
  } else if (system === "windows") {
    // Windows: %LocalAppData%/aves/
    const localAppData = Deno.env.get("LocalAppData");
    if (localAppData) return `${localAppData}/aves`;
    // Fallback: ~/AppData/Local/aves/
    if (home) return `${home}/AppData/Local/aves`;
  } else {
    // Linux / other Unix: XDG_DATA_HOME or ~/.local/share/aves/
    const xdg = Deno.env.get("XDG_DATA_HOME");
    if (xdg) return `${xdg}/aves`;
    if (home) return `${home}/.local/share/aves`;
  }

  return Deno.makeTempDirSync({ prefix: "aves" });
}

export function getAvesDbPath(): string {
  return `${getAvesDataDir()}/aves.db`;
}
