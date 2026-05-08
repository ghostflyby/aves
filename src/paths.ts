import os from "node:os";
import * as path from "path";

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

/**
 * Aves config directory (XDG_CONFIG_HOME/aves).
 *
 * Resolution order:
 * 1. $AVES_CONFIG_DIR (override)
 * 2. Platform-specific default:
 *    - macOS: ~/Library/Application Support/aves/ (same as data for simplicity)
 *    - Windows: %AppData%/aves/
 *    - Other: $XDG_CONFIG_HOME/aves/ (fallback: ~/.config/aves/)
 * 3. Fallback: ~/.config/aves/
 */
export function getAvesConfigDir(): string {
  const override = Deno.env.get("AVES_CONFIG_DIR");
  if (override) return override;

  const home = os.homedir();
  const system = Deno.build.os;

  if (system === "darwin") {
    // macOS: ~/Library/Application Support/aves/
    if (home) return `${home}/Library/Application Support/aves`;
  } else if (system === "windows") {
    // Windows: %AppData%/aves/
    const appData = Deno.env.get("AppData");
    if (appData) return `${appData}/aves`;
    if (home) return `${home}/AppData/Roaming/aves`;
  } else {
    // Linux / other Unix: XDG_CONFIG_HOME or ~/.config/aves/
    const xdg = Deno.env.get("XDG_CONFIG_HOME");
    if (xdg) return `${xdg}/aves`;
    if (home) return `${home}/.config/aves`;
  }

  return `${Deno.env.get("HOME") ?? "/tmp"}/.config/aves`;
}


/**
 * Aves state directory.
 * Used for session-level runtime state: server registry, locks.
 *
 * Resolution order:
 * 1. $AVES_STATE_DIR (override)
 * 2. Platform-specific:
 *    - Linux: $XDG_STATE_HOME/aves/ (fallback: ~/.local/state/aves/)
 *    - macOS / Windows: same as getAvesDataDir()
 */
export function getAvesStateDir(): string {
  const override = Deno.env.get("AVES_STATE_DIR");
  if (override) return override;

  const home = os.homedir();
  const system = Deno.build.os;

  if (system === "linux") {
    const xdg = Deno.env.get("XDG_STATE_HOME");
    if (xdg) return `${xdg}/aves`;
    if (home) return `${home}/.local/state/aves`;
  }

  // macOS, Windows, and others: use data dir
  return path.join(getAvesDataDir(),"state");

}
