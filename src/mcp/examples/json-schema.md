# JSON Schema Validation

Use Zod inputSchema for runtime validation. Required for promote_to_skill.

## Code

```ts
import { z } from "zod";

export const inputSchema = z.object({
  name: z.string().min(1).describe("Person's name"),
  age: z.number().int().min(0).describe("Person's age"),
});

export default async function main(input: z.infer<typeof inputSchema>) {
  return { greeting: `Hello ${input.name}, you are ${input.age}` };
}
```

## Input

```json
{ "name": "Alice", "age": 30 }
```

## Output

```json
{ "greeting": "Hello Alice, you are 30" }
```
