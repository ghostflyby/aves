export function getSystemTempDir(): string {
  return Deno.env.get("TMPDIR")
    ?? Deno.env.get("TEMP")
    ?? Deno.env.get("TMP")
    ?? "/tmp";
}

/**
 * Aves state directory.
 * Uses XDG_STATE_HOME by default, falls back to temp dir when
 * the XDG path isn't writable (e.g. sandboxed environments).
 *
 * Override via AVES_STATE_DIR env var.
 */
export function getAvesStateDir(): string {
  const override = Deno.env.get("AVES_STATE_DIR");
  if (override) return override;

  const home = Deno.env.get("HOME");
  const xdg = Deno.env.get("XDG_STATE_HOME");
  if (xdg) return `${xdg}/aves`;
  if (home) return `${home}/.local/state/aves`;
  return `${getSystemTempDir()}/aves/state`;
}

export function getAvesDbPath(): string {
  return `${getAvesStateDir()}/aves.db`;
}
