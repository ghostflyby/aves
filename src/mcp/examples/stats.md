# Statistics

Compute basic statistics: mean, median, min, max.

## Code

```ts
import { z } from "zod";

export const inputSchema = z.array(z.number()).describe("Array of numbers");

export default async function main(input: z.infer<typeof inputSchema>) {
  const sorted = [...input].sort((a, b) => a - b);
  return {
    count: input.length,
    sum: input.reduce((a, b) => a + b, 0),
    mean: input.reduce((a, b) => a + b, 0) / input.length,
    median: sorted[Math.floor(sorted.length / 2)],
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}
```

## Input

```json
[3, 1, 4, 1, 5, 9]
```

## Output

```json
{ "count": 6, "sum": 23, "mean": 3.833, "median": 4, "min": 1, "max": 9 }
```
