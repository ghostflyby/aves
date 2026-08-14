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

/** Async input channel (Jupyter input_request, control socket, ...). */
export type InputFn = (
  prompt: string,
  options?: { password?: boolean },
) => Promise<string>;

/**
 * Undo function returned by the install helpers. Callable directly and also
 * `Disposable`, so `using _ = installPromptInput(...)` restores the globals
 * when the block exits.
 */
export type Restore = (() => void) & Disposable;

function asRestore(fn: () => void): Restore {
  const restore = fn as Restore;
  restore[Symbol.dispose] = fn;
  return restore;
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
