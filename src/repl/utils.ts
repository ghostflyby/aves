// ============================================================
// src/repl/utils.ts — host-side global installs
//
// The kernel installs no globals. Hosts that want user code to be
// able to call console.* / prompt() / confirm() wire those globals
// to a ReplExecution's `emit`/input channel themselves — these
// helpers are the shared, fiddly parts of that wiring. They are
// library functions, NOT kernel options: the kernel never uses
// them, and hosts that handle their globals their own way can skip
// them entirely.
// ============================================================

import type { ReplOutputEvent } from "./types.ts";

/** Async input channel (Jupyter input_request, control socket, ...). */
export type InputFn = (
  prompt: string,
  options?: { password?: boolean },
) => Promise<string>;

/**
 * Undo function returned by the install helpers. Callable directly and also
 * `Disposable`, so `using _ = installConsoleCapture(...)` restores the globals
 * when the block exits.
 */
export type Restore = (() => void) & Disposable;

function asRestore(fn: () => void): Restore {
  const restore = fn as Restore;
  restore[Symbol.dispose] = fn;
  return restore;
}

const CONSOLE_KINDS: Array<[keyof Console, "stdout" | "stderr"]> = [
  ["log", "stdout"],
  ["info", "stdout"],
  ["debug", "stdout"],
  ["warn", "stderr"],
  ["error", "stderr"],
];

/**
 * Replace console.log/info/debug/warn/error so output lands in `emit`
 * (e.g. a ReplExecution.emit). Returns a Restore that undoes the install.
 */
export function installConsoleCapture(
  emit: (event: ReplOutputEvent) => void,
): Restore {
  const originals = new Map<keyof Console, (...args: unknown[]) => void>();
  for (const [method, kind] of CONSOLE_KINDS) {
    const original = console[method];
    if (typeof original !== "function") continue;
    originals.set(method, original as (...args: unknown[]) => void);
    const wrapper = (...args: unknown[]) => {
      emit({ kind, text: args.map(formatConsoleArg).join(" ") });
    };
    console[method] = wrapper as typeof console.log;
  }
  return asRestore(() => {
    for (const [method, original] of originals) {
      (console as Record<keyof Console, unknown>)[method] = original;
    }
  });
}

function formatConsoleArg(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return Deno.inspect(value, { colors: false }) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Bind globalThis.prompt/confirm to an async input channel. The bound
 * functions return promises (the channel is asynchronous), so cell code uses
 * `await prompt(...)`. Returns a Restore that undoes the install.
 */
export function installPromptInput(input: InputFn): Restore {
  const g = globalThis as Record<string, unknown>;
  const hadPrompt = Object.prototype.hasOwnProperty.call(g, "prompt");
  const hadConfirm = Object.prototype.hasOwnProperty.call(g, "confirm");
  const prevPrompt = g.prompt;
  const prevConfirm = g.confirm;

  g.prompt = (message?: string) => input(String(message ?? ""));
  g.confirm = async (message?: string) => {
    const answer = (await input(String(message ?? ""))).trim().toLowerCase();
    return answer !== "" && answer !== "0" && answer !== "no" &&
      answer !== "false";
  };

  return asRestore(() => {
    if (hadPrompt) g.prompt = prevPrompt;
    else delete g.prompt;
    if (hadConfirm) g.confirm = prevConfirm;
    else delete g.confirm;
  });
}
