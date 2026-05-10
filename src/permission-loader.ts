export interface PermissionModule {
  decide(permission: string, value: string): Promise<"allow" | "deny" | null>;
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

  const worker = new Worker(
    new URL("./permission-worker.ts", import.meta.url).href,
    {
      type: "module",
      deno: {
        permissions: {
          read: [skillDir],
        },
      },
      env: {
        AVES_PERMISSION_MODULE: modulePath,
      },
    },
  );

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
    decide(permission: string, value: string) {
      return new Promise((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        worker.postMessage({ id, permission, value });
      });
    },
    dispose() {
      pending.clear();
      worker.terminate();
    },
  };
}
