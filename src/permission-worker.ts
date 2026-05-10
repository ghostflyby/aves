// Worker: loads mod.permission.ts and responds to permission queries
const modulePath = Deno.env.get("AVES_PERMISSION_MODULE");
if (!modulePath) throw new Error("AVES_PERMISSION_MODULE not set");

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
    } catch {
      mod = {};
    }
  }

  const fn = mod[permission];
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
