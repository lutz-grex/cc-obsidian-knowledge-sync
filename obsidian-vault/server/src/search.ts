/**
 * Search implementation using ripgrep for content search
 * and filesystem operations for filename/frontmatter search.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import type { Vault } from "./vault.js";
import { parseNote } from "./frontmatter.js";
import { RipgrepMatchSchema } from "./schemas.js";

const execFileAsync = promisify(execFile);

export interface SearchResult {
  path: string;
  matchType: "content" | "filename" | "frontmatter";
  snippet?: string;
  lineNumber?: number;
  score?: number;
}

/**
 * Full-text content search using ripgrep.
 */
export async function searchContent(
  vault: Vault,
  query: string,
  options: { folder?: string; limit?: number; regex?: boolean } = {}
): Promise<SearchResult[]> {
  const { folder = "", limit = 20, regex = false } = options;
  const searchDir = vault.resolve(folder);

  // Build ripgrep arguments
  const args = [
    "--json",
    "--max-count", "3", // max matches per file
    "--type", "md",
    "--smart-case",
  ];

  // Use fixed-strings by default to prevent regex injection
  if (!regex) {
    args.push("--fixed-strings");
  }

  // Add glob exclusions
  for (const exclude of vault.config.excludeFolders) {
    args.push("--glob", `!${exclude}/**`);
  }

  args.push("--", query, searchDir);

  try {
    const { stdout } = await execFileAsync("rg", args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 15000,
    });

    const results: SearchResult[] = [];
    const lines = stdout.trim().split("\n").filter(Boolean);

    for (const line of lines) {
      if (results.length >= limit) break;

      try {
        const raw = JSON.parse(line);
        const parsed = RipgrepMatchSchema.safeParse(raw);
        if (!parsed.success) continue;

        const { data } = parsed;
        const filePath = vault.relative(data.data.path.text);
        const lineText = data.data.lines.text.trim();
        const lineNumber = data.data.line_number;

        // Deduplicate: only show first match per file
        const existing = results.find((r) => r.path === filePath);
        if (!existing) {
          results.push({
            path: filePath,
            matchType: "content",
            snippet: lineText.slice(0, 200),
            lineNumber,
          });
        }
      } catch {
        // Skip malformed JSON lines
      }
    }

    return results;
  } catch (error: unknown) {
    if (error && typeof error === "object") {
      const e = error as { code?: string | number };
      // rg exits with code 1 when no matches found
      if (e.code === 1) return [];
      // rg not installed
      if (e.code === "ENOENT") {
        throw new Error("ripgrep (rg) is required but not found in PATH. Install: https://github.com/BurntSushi/ripgrep");
      }
    }
    throw error;
  }
}

/**
 * Filename/path search using glob-style matching.
 */
export async function searchFilename(
  vault: Vault,
  pattern: string,
  options: { folder?: string; limit?: number } = {}
): Promise<SearchResult[]> {
  const { folder = "", limit = 20 } = options;
  const files = await vault.listAllMarkdownFiles(folder);

  const lowerPattern = pattern.toLowerCase();
  const results: SearchResult[] = [];

  for (const file of files) {
    const fileName = path.basename(file.path).toLowerCase();
    const filePath = file.path.toLowerCase();

    if (fileName.includes(lowerPattern) || filePath.includes(lowerPattern)) {
      results.push({
        path: file.path,
        matchType: "filename",
        score: fileName === lowerPattern + ".md" ? 100 : fileName.includes(lowerPattern) ? 50 : 10,
      });
    }
  }

  results.sort((a, b) => (b.score || 0) - (a.score || 0));
  return results.slice(0, limit);
}

/**
 * Frontmatter field search — walks vault and filters by field values.
 */
export async function searchFrontmatter(
  vault: Vault,
  field: string,
  value: string,
  operator: "equals" | "contains" | "gt" | "lt" | "exists" = "contains",
  options: { folder?: string; limit?: number } = {}
): Promise<SearchResult[]> {
  const { folder = "", limit = 20 } = options;
  const files = await vault.listAllMarkdownFiles(folder);
  const results: SearchResult[] = [];

  // Process files in concurrent batches
  const BATCH_SIZE = 20;
  for (let batch = 0; batch < files.length && results.length < limit; batch += BATCH_SIZE) {
    const chunk = files.slice(batch, batch + BATCH_SIZE);
    const reads = await Promise.all(
      chunk.map(async (file) => {
        try {
          const content = await vault.readFile(file.path);
          return { file, content };
        } catch {
          return null;
        }
      })
    );

    for (const entry of reads) {
      if (results.length >= limit) break;
      if (!entry) continue;

      const { file, content } = entry;
      const { frontmatter } = parseNote(content);
      if (!frontmatter) continue;

      const fieldValue = frontmatter[field];
      if (fieldValue === undefined && operator !== "exists") continue;

      let matches = false;
      switch (operator) {
        case "exists":
          matches = fieldValue !== undefined;
          break;
        case "equals":
          matches = String(fieldValue) === value;
          break;
        case "contains":
          if (Array.isArray(fieldValue)) {
            matches = fieldValue.some((v) =>
              String(v).toLowerCase().includes(value.toLowerCase())
            );
          } else {
            matches = String(fieldValue).toLowerCase().includes(value.toLowerCase());
          }
          break;
        case "gt": {
          const numField = Number(fieldValue);
          const numVal = Number(value);
          if (!isNaN(numField) && !isNaN(numVal)) {
            matches = numField > numVal;
          } else {
            matches = String(fieldValue) > value;
          }
          break;
        }
        case "lt": {
          const numField = Number(fieldValue);
          const numVal = Number(value);
          if (!isNaN(numField) && !isNaN(numVal)) {
            matches = numField < numVal;
          } else {
            matches = String(fieldValue) < value;
          }
          break;
        }
      }

      if (matches) {
        results.push({
          path: file.path,
          matchType: "frontmatter",
          snippet: `${field}: ${JSON.stringify(fieldValue)}`,
        });
      }
    }
  }

  return results;
}
