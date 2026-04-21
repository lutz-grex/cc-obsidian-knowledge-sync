/**
 * YAML frontmatter parser and serializer for Obsidian notes.
 * Handles the --- delimited YAML block at the top of markdown files.
 */

import { parse as yamlParse, stringify as yamlStringify } from "yaml";

// Allows trailing whitespace on delimiter lines
const FRONTMATTER_REGEX = /^---[^\S\r\n]*\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*(?:\r?\n|$)/;

export interface ParsedNote {
  frontmatter: Record<string, unknown> | null;
  body: string;
  raw: string;
}

/** Parse a markdown file into frontmatter + body. */
export function parseNote(content: string): ParsedNote {
  const match = content.match(FRONTMATTER_REGEX);
  if (!match) {
    return { frontmatter: null, body: content, raw: content };
  }

  const yamlStr = match[1];
  const body = content.slice(match[0].length);
  const frontmatter = parseYaml(yamlStr);

  return { frontmatter, body, raw: content };
}

/** Reconstruct a note from frontmatter + body. */
export function serializeNote(
  frontmatter: Record<string, unknown> | null,
  body: string
): string {
  if (!frontmatter || Object.keys(frontmatter).length === 0) {
    return body;
  }
  const yaml = serializeYaml(frontmatter);
  return `---\n${yaml}---\n${body}`;
}

/** Parse a YAML string into an object. */
export function parseYaml(yaml: string): Record<string, unknown> {
  const result = yamlParse(yaml);
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return {};
  }
  return result as Record<string, unknown>;
}

/** Serialize an object to YAML string. */
export function serializeYaml(obj: Record<string, unknown>): string {
  return yamlStringify(obj, {
    lineWidth: 0,
    defaultKeyType: "PLAIN",
    defaultStringType: "PLAIN",
  });
}

/** Deep merge frontmatter fields. */
export function mergeFrontmatter(
  existing: Record<string, unknown>,
  updates: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...existing };
  for (const [key, value] of Object.entries(updates)) {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      existing[key] &&
      typeof existing[key] === "object" &&
      !Array.isArray(existing[key])
    ) {
      result[key] = mergeFrontmatter(
        existing[key] as Record<string, unknown>,
        value as Record<string, unknown>
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}
