/**
 * Single-pass vault index: scans all files once and returns structured data
 * for link analysis, linting, and graph operations.
 */

import { parseNote } from "./frontmatter.js";
import { extractAllLinkTargets } from "./wikilinks.js";
import type { Vault } from "./vault.js";

export interface IndexEntry {
  frontmatter: Record<string, unknown> | null;
  outgoingTargets: string[];
  title: string;
}

/**
 * Build a full index of the vault by scanning all markdown files once.
 * Returns a Map keyed by relative path.
 */
export async function buildVaultIndex(
  vault: Vault,
  folder?: string
): Promise<Map<string, IndexEntry>> {
  const index = new Map<string, IndexEntry>();
  const files = await vault.listAllMarkdownFiles(folder || "");

  const BATCH_SIZE = 20;
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (file) => {
        try {
          const content = await vault.readFile(file.path);
          const parsed = parseNote(content);
          const outgoingTargets = extractAllLinkTargets(content);
          const rawTitle = parsed.frontmatter?.title;
          const title =
            (typeof rawTitle === "string" ? rawTitle : String(rawTitle ?? "")) ||
            file.path.split("/").pop()?.replace(/\.md$/, "") ||
            file.path;
          return { path: file.path, entry: { frontmatter: parsed.frontmatter, outgoingTargets, title } };
        } catch {
          return null;
        }
      })
    );
    for (const r of results) {
      if (r) index.set(r.path, r.entry);
    }
  }

  return index;
}
