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

export const handleListResources = async () => {
  const skills = await listSkills();
  return {
    resources: [
      {
        uri: "aves://schema/runs",
        name: "Runs table schema",
        description:
          "Column definitions for the runs table with type annotations",
        mimeType: "text/plain",
      },
      {
        uri: "aves://skills",
        name: "Skills",
        description:
          "List of all installed skills with names, paths, and descriptions",
        mimeType: "application/json",
      },
      ...EXAMPLE_URIS.map((uri) => ({
        uri,
        name: uri.replace("aves://examples/", ""),
        description: `Example script: ${uri.replace("aves://examples/", "")}`,
        mimeType: "text/markdown",
      })),
      ...skills.map((s) => ({
        uri: `aves://skills/${s.name}`,
        name: s.name,
        description: s.description,
        mimeType: "application/json",
      })),
    ],
  };
};

export const handleListResourceTemplates = () => ({
  resourceTemplates: [
    {
      uriTemplate: "aves://skills/{name}",
      name: "Skill by name",
      description:
        "Retrieve a single skill's SKILL.md and metadata by its directory name",
      mimeType: "text/markdown",
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
        text: RUNS_TABLE_DDL,
      }],
    };
  }

  if (uri === "aves://skills") {
    const skills = await listSkills();
    return {
      contents: [{
        uri,
        mimeType: "application/json",
        text: JSON.stringify(skills, null, 2),
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
    const skillName = skillMatch[1];
    const skills = await listSkills();
    const skill = skills.find((s) => s.name === skillName);
    if (!skill) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Skill not found: ${skillName}`,
      );
    }
    // Read and return SKILL.md content
    try {
      const mdContent = await Deno.readTextFile(`${skill.path}/SKILL.md`);
      return {
        contents: [{
          uri,
          mimeType: "text/markdown",
          text: mdContent,
        }],
      };
    } catch {
      throw new McpError(
        ErrorCode.InternalError,
        `Could not read SKILL.md for skill: ${skillName}`,
      );
    }
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
