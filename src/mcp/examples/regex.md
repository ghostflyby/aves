# Regex Extraction

Extract structured data from text using regular expressions.

## Code

```ts
import { z } from "zod";

export const inputSchema = z.string().describe(
  "Text to search for emails and URLs",
);

export default async function main(input: z.infer<typeof inputSchema>) {
  const emails = input.match(/[\w.-]+@[\w.-]+\.\w+/g) || [];
  const urls = input.match(/https?:\/\/[^\s]+/g) || [];
  return { emails, urls };
}
```

## Input

```json
"Contact alice@example.com or visit https://example.com"
```

## Output

```json
{ "emails": ["alice@example.com"], "urls": ["https://example.com"] }
```
