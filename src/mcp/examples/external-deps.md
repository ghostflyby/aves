# External Dependencies

Import libraries from JSR and npm using inline specifiers.

## Code

```ts
import { z } from "zod";
import { camelCase } from "npm:lodash-es";
import { join } from "jsr:@std/path@1";

export default async function main(input: unknown) {
  const name = camelCase("hello world");
  const path = join("/tmp", name);
  return { name, path };
}
```

## Notes

- JSR: use `jsr:@scope/pkg@version` (e.g. `jsr:@std/path@1`)
- npm: use `npm:pkg` (e.g. `npm:lodash-es`)
- The `zod` package is pre-installed — use `import { z } from "zod"` directly
- Deno built-ins (crypto, fetch, TextEncoder...) are always available
