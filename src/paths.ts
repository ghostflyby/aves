/**
 * Aves state directory.
 * Uses XDG_STATE_HOME by default, falls back to $HOME/.local/state/aves.
 * Override via AVES_STATE_DIR env var.
 */
export function getAvesStateDir(): string {
  const override = Deno.env.get("AVES_STATE_DIR");
  if (override) return override;

  const home = Deno.env.get("HOME");
  const xdg = Deno.env.get("XDG_STATE_HOME");
  if (xdg) return `${xdg}/aves`;
  if (home) return `${home}/.local/state/aves`;
  return "/tmp/aves/state";
}

export function getAvesDbPath(): string {
  return `${getAvesStateDir()}/aves.db`;
}
