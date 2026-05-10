// Aves MCP resources — static metadata, dynamic examples, and parameterized lookups.

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { RUNS_TABLE_DDL } from "../db-schema.ts";
import { loadRun } from "../run-store.ts";
import { listSkills } from "../skill.ts";

// ============================================================
// Examples — dynamically discovered from ./examples/*.md
// ============================================================

const EXAMPLES_DIR = new URL("./examples/", import.meta.url);

async function listExampleNames(): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(EXAMPLES_DIR)) {
      if (entry.isFile && entry.name.endsWith(".md")) {
        names.push(entry.name.replace(/\.md$/, ""));
      }
    }
  } catch {
    // examples dir doesn't exist or is unreadable
  }
  names.sort();
  return names;
}

async function readExample(name: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(
      new URL(`./${name}.md`, EXAMPLES_DIR),
    );
  } catch {
    return null;
  }
}

// ============================================================
// Handlers
// ============================================================

export const handleListResources = async () => {
  const skills = await listSkills();
  const exampleNames = await listExampleNames();

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
      ...exampleNames.map((name) => ({
        uri: `aves://examples/${name}`,
        name,
        description: `Example script: ${name}`,
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

  // Dynamic example lookup
  const exampleMatch = uri.match(/^aves:\/\/examples\/(.+)$/);
  if (exampleMatch) {
    const content = await readExample(exampleMatch[1]);
    if (content) {
      return {
        contents: [{ uri, mimeType: "text/markdown", text: content }],
      };
    }
    throw new McpError(
      ErrorCode.InvalidParams,
      `Example not found: ${exampleMatch[1]}`,
    );
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
