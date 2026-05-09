# Statistics

Compute basic statistics: mean, median, min, max.

## Code

```ts
import { z } from "zod";

export const inputSchema = z.object({
  numbers: z.array(z.number()).describe("Array of numbers"),
});

export default async function main(input: z.infer<typeof inputSchema>) {
  const n = input.numbers;
  const sorted = [...n].sort((a, b) => a - b);
  return {
    count: n.length,
    sum: n.reduce((a, b) => a + b, 0),
    mean: n.reduce((a, b) => a + b, 0) / n.length,
    median: sorted[Math.floor(sorted.length / 2)],
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}
```

## Input

```json
{ "numbers": [3, 1, 4, 1, 5, 9] }
```

## Output

```json
{ "count": 6, "sum": 23, "mean": 3.833, "median": 4, "min": 1, "max": 9 }
```
