// Worker: loads mod.permission.ts and responds to permission queries
const modulePath = new URL(import.meta.url).searchParams.get("module");
if (!modulePath) throw new Error("module search param not set on worker URL");

type PermissionFn = (value: string) => boolean | undefined;

let mod: Record<string, PermissionFn> | null = null;

// deno-lint-ignore no-explicit-any
const ctx = self as any;
ctx.onmessage = async (e: MessageEvent) => {
  const { id, permission, value } = e.data;

  if (!mod) {
    try {
      const imported = await import(modulePath);
      mod = imported.default ?? {};
      if (typeof mod !== "object" || mod === null) mod = {};
    } catch (err) {
      mod = {};
      self.postMessage({ type: "error", error: String(err) });
    }
  }

  const fn = Object.hasOwn(mod, permission) ? mod[permission] : undefined;
  let result: boolean | undefined;
  if (typeof fn === "function") {
    try {
      result = fn(value);
      if (typeof result === "boolean") result = result ? "allow" : "deny";
    } catch {
      result = undefined;
    }
  }
  ctx.postMessage({ id, result: result ?? null });
};
