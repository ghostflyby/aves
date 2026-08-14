// ============================================================
// src/repl/utils.ts — host-side global installs
//
// The kernel installs no globals and produces no output events:
// hosts wire their own console.* / prompt() / confirm() /
// Deno.jupyter.* to their own channels, attributing output to the
// in-flight cell via kernel.current. These helpers are the shared,
// fiddly parts of that wiring — library functions, NOT kernel
// options; hosts that handle their globals their own way can skip
// them entirely.
// ============================================================

/**
 * Console output sink for `installConsoleCapture`. The host attributes the
 * output to a cell via `kernel.current` inside its sink, then routes it
 * through its own channel.
 */
export type ConsoleSink = (kind: "stdout" | "stderr", text: string) => void;

/**
 * Async input channel used to answer `prompt()`/`confirm()` — a Jupyter
 * `input_request` round-trip, a control-socket query, a terminal, etc. The
 * return is a Promise because the channel is asynchronous.
 */
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

// console methods whose output has no internal state. group*/time*/count*/
// and clear are intentionally NOT captured: Deno's console writes their
// output directly to the real stdout (not via console.log), and wrapping them
// would require reimplementing their internal state — hosts needing those may
// patch them themselves.
const CONSOLE_KINDS: Array<[keyof Console, "stdout" | "stderr"]> = [
  ["log", "stdout"],
  ["info", "stdout"],
  ["debug", "stdout"],
  ["warn", "stderr"],
  ["error", "stderr"],
  ["assert", "stderr"],
  ["trace", "stderr"],
];

/**
 * Replace console.log/info/debug/warn/error/assert/trace so their output lands
 * in `sink(kind, text)`. Stateful/structural methods (group*, time*, count*,
 * clear, ...) are left alone — their output escapes to the real stdout; hosts
 * that need them patch them separately. Returns a Restore that undoes the
 * install.
 */
export function installConsoleCapture(sink: ConsoleSink): Restore {
  const originals = new Map<keyof Console, (...args: unknown[]) => void>();
  for (const [method, kind] of CONSOLE_KINDS) {
    const original = console[method];
    if (typeof original !== "function") continue;
    originals.set(method, original as (...args: unknown[]) => void);
    const wrapper = (...args: unknown[]) => {
      if (method === "assert") {
        // Faithful to console.assert: output only when the condition is
        // falsy, and only the message args (not the condition itself).
        const [condition, ...message] = args;
        if (condition) return;
        sink(kind, message.map(formatConsoleArg).join(" "));
        return;
      }
      sink(kind, args.map(formatConsoleArg).join(" "));
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
