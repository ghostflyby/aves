# Date Formatting

Format dates with `npm:date-fns`. More readable than raw `Date` manipulation.

## Code

```ts
import { z } from "zod";
import { addDays, differenceInDays, format } from "npm:date-fns@4";

export const inputSchema = z.object({
  date: z.string().describe("ISO date string, e.g. 2026-01-15"),
  daysToAdd: z.number().optional().describe("Days to add"),
});

export default async function main(input: z.infer<typeof inputSchema>) {
  const d = new Date(input.date);
  const future = input.daysToAdd ? addDays(d, input.daysToAdd) : d;
  const diff = differenceInDays(new Date(), d);
  return {
    formatted: format(future, "yyyy-MM-dd EEEE"),
    daysFromNow: diff,
  };
}
```
