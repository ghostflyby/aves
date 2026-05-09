# Regex Extraction

Extract structured data from text using regular expressions.

## Code

```ts
import { z } from "zod";

export const inputSchema = z.object({
  text: z.string().describe("Text to search for emails and URLs"),
});

export default async function main(input: z.infer<typeof inputSchema>) {
  const emails = input.text.match(/[\w.-]+@[\w.-]+\.\w+/g) || [];
  const urls = input.text.match(/https?:\/\/[^\s]+/g) || [];
  return { emails, urls };
}
```

## Input

```json
{ "text": "Contact alice@example.com or visit https://example.com" }
```

## Output

```json
{ "emails": ["alice@example.com"], "urls": ["https://example.com"] }
```
