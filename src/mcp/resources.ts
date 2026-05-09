// Aves MCP resources — static metadata and parameterized lookups.
// Extracted from server.ts to keep the server module focused on tool handling.

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { RUNS_TABLE_DDL } from "../db-schema.ts";
import { loadRun } from "../run-store.ts";
import { listSkills } from "../skill.ts";

import csvToJson from "./examples/csv-to-json.md" with { type: "text" };
import hash from "./examples/hash.md" with { type: "text" };
import jsonSchema from "./examples/json-schema.md" with { type: "text" };
import regex from "./examples/regex.md" with { type: "text" };
import stats from "./examples/stats.md" with { type: "text" };

const EXAMPLE_RESOURCES: Record<string, string> = {
  "aves://examples/csv-to-json": csvToJson,
  "aves://examples/hash": hash,
  "aves://examples/json-schema": jsonSchema,
  "aves://examples/regex": regex,
  "aves://examples/stats": stats,
};

const EXAMPLE_URIS = [
  "aves://examples/csv-to-json",
  "aves://examples/hash",
  "aves://examples/json-schema",
  "aves://examples/regex",
  "aves://examples/stats",
];

export const handleListResources = () => ({
  resources: [
    {
      uri: "aves://schema/runs",
      name: "Runs table schema",
      description:
        "Column definitions for the runs table with type annotations",
      mimeType: "text/plain",
    },
    ...EXAMPLE_URIS.map((uri) => ({
      uri,
      name: uri.replace("aves://examples/", ""),
      description: `Example script: ${uri.replace("aves://examples/", "")}`,
      mimeType: "text/markdown",
    })),
  ],
});

export const handleListResourceTemplates = () => ({
  resourceTemplates: [
    {
      uriTemplate: "aves://skills/{name}",
      name: "Skill by name",
      description: "Retrieve a single skill's manifest by its directory name",
      mimeType: "application/json",
    },
    {
      uriTemplate: "aves://runs/{run_id}",
      name: "Run by ID",
      description: "Retrieve a single run record by its UUID",
      mimeType: "application/json",
    },
  ],
});

export async function handleReadResource(uri: string): Promise<{
  contents: { uri: string; mimeType: string; text: string }[];
}> {
  if (uri === "aves://schema/runs") {
    return {
      contents: [{
        uri,
        mimeType: "text/plain",
        text: `CREATE TABLE runs (\n${RUNS_TABLE_DDL})`,
      }],
    };
  }

  const exampleContent = EXAMPLE_RESOURCES[uri];
  if (exampleContent) {
    return {
      contents: [{ uri, mimeType: "text/markdown", text: exampleContent }],
    };
  }

  const skillMatch = uri.match(/^aves:\/\/skills\/(.+)$/);
  if (skillMatch) {
    const skills = await listSkills();
    const skill = skills.find((s) => s.name === skillMatch[1]);
    if (!skill) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Skill not found: ${skillMatch[1]}`,
      );
    }
    return {
      contents: [{
        uri,
        mimeType: "application/json",
        text: JSON.stringify(skill, null, 2),
      }],
    };
  }

  const runMatch = uri.match(/^aves:\/\/runs\/(.+)$/);
  if (runMatch) {
    const run = await loadRun(runMatch[1]);
    if (!run) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Run not found: ${runMatch[1]}`,
      );
    }
    return {
      contents: [{
        uri,
        mimeType: "application/json",
        text: JSON.stringify(run, null, 2),
      }],
    };
  }

  throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${uri}`);
}
