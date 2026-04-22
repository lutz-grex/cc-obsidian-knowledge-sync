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

export interface VaultIndexResult {
  index: Map<string, IndexEntry>;
  /** Files that were skipped due to read/parse errors. */
  skipped: Array<{ path: string; error: string }>;
}

// ─── Cache ───────────────────────────────────────────────────────────────────

interface CacheEntry {
  result: VaultIndexResult;
  generation: number;
  builtAt: number;
  folder: string;
}

const indexCache = new Map<string, CacheEntry>();
/** Max TTL in ms — safety net for out-of-band changes (Obsidian edits, git pull, etc.) */
const CACHE_MAX_TTL_MS = 30_000;

/**
 * Build a full index of the vault by scanning all markdown files once.
 * Results are cached per vault+folder and invalidated when vault.writeGeneration changes
 * or CACHE_MAX_TTL_MS has elapsed (safety net for out-of-band changes).
 */
export async function buildVaultIndex(
  vault: Vault,
  folder?: string
): Promise<VaultIndexResult> {
  const cacheKey = `${vault.root}:${folder ?? ""}`;
  const cached = indexCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.generation === vault.writeGeneration && (now - cached.builtAt) < CACHE_MAX_TTL_MS) {
    return cached.result;
  }

  const index = new Map<string, IndexEntry>();
  const skipped: Array<{ path: string; error: string }> = [];
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
          return { path: file.path, entry: { frontmatter: parsed.frontmatter, outgoingTargets, title }, error: null };
        } catch (err) {
          return { path: file.path, entry: null, error: err instanceof Error ? err.message : String(err) };
        }
      })
    );
    for (const r of results) {
      if (r.entry) {
        index.set(r.path, r.entry);
      } else if (r.error) {
        skipped.push({ path: r.path, error: r.error });
      }
    }
  }

  const result = { index, skipped };
  indexCache.set(cacheKey, { result, generation: vault.writeGeneration, builtAt: Date.now(), folder: folder ?? "" });
  return result;
}
