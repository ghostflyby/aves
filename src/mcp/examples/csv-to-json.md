# CSV to JSON

Parse CSV text into JSON arrays.

## Code

```ts
import { z } from "zod";

export const inputSchema = z.object({
  csv: z.string().describe("CSV text with header row"),
});

export default async function main(input: z.infer<typeof inputSchema>) {
  const lines = input.csv.trim().split("\n");
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const vals = line.split(",").map((v) => v.trim());
    return Object.fromEntries(headers.map((h, i) => [h, vals[i]]));
  });
}
```

## Input

```json
{ "csv": "name,score\nAlice,95\nBob,87" }
```

## Output

```json
[{ "name": "Alice", "score": "95" }, { "name": "Bob", "score": "87" }]
```
