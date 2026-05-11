import type { PermissionKind } from "./broker.ts";

export interface PermissionModule {
  decide(
    permission: PermissionKind,
    value: string,
  ): Promise<"allow" | "deny" | null>;
  dispose(): void;
}

export function loadPermissionModule(skillDir: string): PermissionModule {
  const modulePath = `${skillDir}/mod.permission.ts`;

  // Check if file exists
  try {
    Deno.statSync(modulePath);
  } catch {
    return {
      decide: () => Promise.resolve(null),
      dispose: () => {},
    };
  }

  const workerUrl = new URL("./permission-worker.ts", import.meta.url);
  workerUrl.searchParams.set("module", modulePath);
  const worker = new Worker(workerUrl.href, {
    type: "module",
    deno: {
      permissions: {
        read: [skillDir],
      },
    },
  });

  let nextId = 0;
  const pending = new Map<
    number,
    (result: "allow" | "deny" | null) => void
  >();

  worker.onmessage = (e: MessageEvent) => {
    const { id, result } = e.data;
    const resolve = pending.get(id);
    if (resolve) {
      pending.delete(id);
      resolve(result);
    }
  };

  worker.onmessageerror = (e) => {
    console.error("[aves] permission worker error:", e);
  };

  return {
    decide(permission: PermissionKind, value: string) {
      return new Promise<"allow" | "deny" | null>((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);

        // Timeout: abort the worker call and fall through to elicitation
        const t = AbortSignal.timeout(5000);
        t.addEventListener("abort", () => {
          if (pending.has(id)) {
            pending.delete(id);
            worker.postMessage({ type: "abort", id });
            resolve(null);
          }
        }, { once: true });

        worker.postMessage({ id, permission, value });
      });
    },
    dispose() {
      pending.clear();
      worker.terminate();
    },
  };
}
