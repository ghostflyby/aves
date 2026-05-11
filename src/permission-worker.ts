// Worker: loads mod.permission.ts and responds to permission queries.
//
// Function signature:
//   fn(value: string, opts: { signal: AbortSignal }): PermitResult
//   PermitResult = "allow" | "deny" | undefined (undefined = fall through)

const modulePath = new URL(import.meta.url).searchParams.get("module");
if (!modulePath) throw new Error("module search param not set on worker URL");

type PermitResult = "allow" | "deny" | undefined;
type PermissionFn = (
  value: string,
  opts: { signal: AbortSignal },
) => PermitResult | Promise<PermitResult>;

let mod: Record<string, PermissionFn> | null = null;

// Per-call abort controllers, keyed by call id
const acByCall = new Map<number, AbortController>();

// deno-lint-ignore no-explicit-any
const ctx = self as any;
ctx.onmessage = async (e: MessageEvent) => {
  const { type, id, permission, value } = e.data;

  // Abort signal from loader
  if (type === "abort") {
    acByCall.get(id)?.abort();
    return;
  }

  if (!mod) {
    try {
      const imported = await import(modulePath);
      mod = imported.default ?? {};
      if (typeof mod !== "object" || mod === null) mod = {};
    } catch (_err) {
      mod = {};
      ctx.postMessage({ id, result: null });
      return;
    }
  }

  const fn = Object.hasOwn(mod, permission) ? mod[permission] : undefined;
  if (typeof fn !== "function") {
    ctx.postMessage({ id, result: null });
    return;
  }

  const ac = new AbortController();
  acByCall.set(id, ac);

  try {
    const result = await fn(value, { signal: ac.signal });
    acByCall.delete(id);
    if (result === "allow" || result === "deny") {
      ctx.postMessage({ id, result });
    } else {
      ctx.postMessage({ id, result: null });
    }
  } catch {
    acByCall.delete(id);
    ctx.postMessage({ id, result: null });
  }
};
