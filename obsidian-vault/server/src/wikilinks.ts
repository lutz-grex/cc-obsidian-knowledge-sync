/**
 * Wikilink parser and rewriter for Obsidian-style links.
 * Handles [[link]], [[link|alias]], and standard markdown [text](path.md) links.
 */

import * as path from "node:path";
import { escapeRegex } from "./utils.js";
import type { Vault } from "./vault.js";

export interface WikiLink {
  /** Full match including brackets */
  raw: string;
  /** The target path/name (without alias) */
  target: string;
  /** Display alias if present */
  alias: string | null;
  /** Start index in the source string */
  start: number;
  /** End index in the source string */
  end: number;
}

export interface MarkdownLink {
  raw: string;
  text: string;
  target: string;
  start: number;
  end: number;
}

const WIKILINK_REGEX = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
const MARKDOWN_LINK_REGEX = /\[([^\]]*)\]\(([^)]+\.md(?:#[^)]*)?)\)/g;

/** Extract all wikilinks from content. */
export function extractWikilinks(content: string): WikiLink[] {
  const links: WikiLink[] = [];
  let match: RegExpExecArray | null;

  const regex = new RegExp(WIKILINK_REGEX.source, "g");
  while ((match = regex.exec(content)) !== null) {
    links.push({
      raw: match[0],
      target: match[1].trim(),
      alias: match[2]?.trim() || null,
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  return links;
}

/** Extract all markdown-style links that point to .md files. */
export function extractMarkdownLinks(content: string): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  let match: RegExpExecArray | null;

  const regex = new RegExp(MARKDOWN_LINK_REGEX.source, "g");
  while ((match = regex.exec(content)) !== null) {
    links.push({
      raw: match[0],
      text: match[1],
      target: match[2],
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  return links;
}

/** Extract all links (both styles) from content. Returns target paths. */
export function extractAllLinkTargets(content: string): string[] {
  const wikilinks = extractWikilinks(content);
  const mdLinks = extractMarkdownLinks(content);

  const targets = new Set<string>();
  for (const link of wikilinks) {
    // Remove heading anchors for path resolution
    const target = link.target.split("#")[0];
    if (target) targets.add(target);
  }
  for (const link of mdLinks) {
    const target = link.target.split("#")[0];
    if (target) targets.add(target);
  }

  return [...targets];
}

/**
 * Rewrite all wikilinks and markdown links that reference oldName to newName.
 * Optionally also rewrites path-based wikilinks (e.g. [[folder/Note]]) when
 * oldPath/newPath are provided.
 */
export function rewriteLinks(
  content: string,
  oldName: string,
  newName: string,
  oldRelPath?: string,
  newRelPath?: string
): string {
  let result = content;

  // Rewrite path-based wikilinks first: [[folder/Note]] → [[newFolder/Note]]
  if (oldRelPath && newRelPath) {
    result = result.replace(
      new RegExp(
        `\\[\\[${escapeRegex(oldRelPath)}(#[^\\]|]*)?(?:\\|([^\\]]+))?\\]\\]`,
        "g"
      ),
      (_, anchor = "", alias) => {
        if (alias) return `[[${newRelPath}${anchor}|${alias}]]`;
        return `[[${newRelPath}${anchor}]]`;
      }
    );
  }

  // Rewrite basename-only wikilinks: [[oldName]] → [[newName]], [[oldName|alias]] → [[newName|alias]]
  result = result.replace(
    new RegExp(
      `\\[\\[${escapeRegex(oldName)}(#[^\\]|]*)?(?:\\|([^\\]]+))?\\]\\]`,
      "g"
    ),
    (_, anchor = "", alias) => {
      if (alias) return `[[${newName}${anchor}|${alias}]]`;
      return `[[${newName}${anchor}]]`;
    }
  );

  // Rewrite markdown links: [text](oldName.md) → [text](newName.md)
  const oldMdPath = oldName.endsWith(".md") ? oldName : `${oldName}.md`;
  const newMdPath = newName.endsWith(".md") ? newName : `${newName}.md`;
  result = result.replace(
    new RegExp(
      `\\[([^\\]]*)\\]\\(${escapeRegex(oldMdPath)}(#[^)]*)?\\)`,
      "g"
    ),
    (_, text, anchor = "") => `[${text}](${newMdPath}${anchor})`
  );

  // Also rewrite path-based markdown links
  if (oldRelPath && newRelPath) {
    const oldFullMdPath = oldRelPath.endsWith(".md") ? oldRelPath : `${oldRelPath}.md`;
    const newFullMdPath = newRelPath.endsWith(".md") ? newRelPath : `${newRelPath}.md`;
    result = result.replace(
      new RegExp(
        `\\[([^\\]]*)\\]\\(${escapeRegex(oldFullMdPath)}(#[^)]*)?\\)`,
        "g"
      ),
      (_, text, anchor = "") => `[${text}](${newFullMdPath}${anchor})`
    );
  }

  return result;
}

/** Get the note name from a relative path (filename without .md). */
export function noteNameFromPath(relativePath: string): string {
  const basename = relativePath.split("/").pop() || relativePath;
  return basename.replace(/\.md$/, "");
}

// ─── Canonical Link Resolver ────────────────────────────────────────────────

export interface ResolveResult {
  status: "resolved" | "missing" | "ambiguous";
  path?: string;
  candidates?: string[];
}

/**
 * Resolve a link target to a canonical vault path.
 * Resolution order: source-relative → vault-root → basename match.
 * Returns structured result where ambiguity is first-class.
 */
/**
 * Resolve a link target to a canonical vault path.
 * Pass `fileList` to avoid repeated filesystem walks in batch operations (lint, graph).
 */
export async function resolveTarget(
  vault: Vault,
  target: string,
  sourceDir?: string,
  fileList?: Array<{ path: string }>
): Promise<ResolveResult> {
  // Strip anchors and aliases defensively (callers should already strip, but be safe)
  const clean = target.replace(/[#|].*$/, "");
  if (!clean) return { status: "missing" };
  const stripped = clean.replace(/\.md$/, "");
  const withMd = `${stripped}.md`;

  // 1. Source-relative resolution
  if (sourceDir) {
    for (const candidate of [path.join(sourceDir, withMd), path.join(sourceDir, clean)]) {
      try {
        if (await vault.exists(candidate)) return { status: "resolved", path: candidate };
      } catch { /* traversal rejection */ }
    }
  }

  // 2. Vault-root-relative resolution
  for (const candidate of [withMd, clean]) {
    try {
      if (await vault.exists(candidate)) return { status: "resolved", path: candidate };
    } catch { /* traversal rejection */ }
  }

  // 3. Basename + suffix match (use provided file list to avoid repeated walks)
  const files = fileList || await vault.listAllMarkdownFiles();
  const baseName = stripped.split("/").pop() || stripped;

  // Try path-suffix match first (more specific than basename)
  if (stripped.includes("/")) {
    const suffixMatches = files.filter((f) => {
      const normalized = f.path.replace(/\.md$/, "");
      return normalized === stripped || normalized.endsWith(`/${stripped}`);
    });
    if (suffixMatches.length === 1) return { status: "resolved", path: suffixMatches[0].path };
    if (suffixMatches.length > 1) return { status: "ambiguous", candidates: suffixMatches.map((m) => m.path) };
  }

  // Fall back to basename match
  const basenameMatches = files.filter((f) => {
    const fName = f.path.split("/").pop()?.replace(/\.md$/, "") || "";
    return fName === baseName;
  });
  if (basenameMatches.length === 1) return { status: "resolved", path: basenameMatches[0].path };
  if (basenameMatches.length > 1) return { status: "ambiguous", candidates: basenameMatches.map((m) => m.path) };

  return { status: "missing" };
}

