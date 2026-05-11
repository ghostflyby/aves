// Global tracker for spawned Deno child processes.
// Ensures cleanup on abnormal exit (SIGINT, crash, etc.)

const _spawned: Deno.ChildProcess[] = [];

export function trackProcess(proc: Deno.ChildProcess): void {
  _spawned.push(proc);
}

export function untrackProcess(proc: Deno.ChildProcess): void {
  const i = _spawned.indexOf(proc);
  if (i !== -1) _spawned.splice(i, 1);
}

export function killAllTracked(): void {
  for (const proc of _spawned.splice(0)) {
    try {
      proc.kill("SIGKILL");
    } catch { /* already dead */ }
  }
}
