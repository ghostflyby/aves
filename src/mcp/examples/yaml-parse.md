# YAML Parser

Parse YAML files into structured JSON using `jsr:@std/yaml`.

## Code

```ts
import { z } from "zod";
import { parse } from "jsr:@std/yaml@1";

export const inputSchema = z.string().describe("YAML text to parse");

export default async function main(input: z.infer<typeof inputSchema>) {
  const parsed = parse(input);
  return { data: parsed };
}
```
