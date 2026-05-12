# Semantic Version Compare

Compare, sort, and validate semver versions with `npm:semver`.

## Code

```ts
import { z } from "zod";
import { compare, satisfies, valid } from "npm:semver@7";

export const inputSchema = z.object({
  versions: z.array(z.string()).describe("Array of semver strings"),
  range: z.string().optional().describe("Optional semver range, e.g. '^1.2.0'"),
});

export default async function main(input: z.infer<typeof inputSchema>) {
  const sorted = [...input.versions].sort(compare);
  const allValid = input.versions.every((v) => valid(v) !== null);
  const matching = input.range
    ? input.versions.filter((v) => satisfies(v, input.range))
    : null;
  return { sorted, allValid, matching };
}
```
