# SHA-256 Hashing

Compute SHA-256 hash of input text.

## Code

```ts
import { z } from "zod";

export const inputSchema = z.object({
  text: z.string().describe("Text to hash"),
});

export default async function main(input: z.infer<typeof inputSchema>) {
  const data = new TextEncoder().encode(input.text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return {
    hex: Array.from(new Uint8Array(hash)).map((b) =>
      b.toString(16).padStart(2, "0")
    ).join(""),
  };
}
```

## Input

```json
{ "text": "hello" }
```

## Output

```json
{ "hex": "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" }
```
