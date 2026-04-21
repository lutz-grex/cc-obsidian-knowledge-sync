/**
 * Heading/section helpers for navigating and editing markdown documents.
 */

import { escapeRegex } from "./utils.js";

export interface SectionRange {
  /** Start offset of the heading line in the body string */
  start: number;
  /** End offset (exclusive) — either the start of the next same/higher heading or end of string */
  end: number;
  /** The full text of the section (heading line through end) */
  content: string;
}

/**
 * Find the range of a section identified by its heading text.
 * Returns the span from the heading line to the next heading of same/higher level (or EOF).
 */
export function findSectionRange(body: string, heading: string): SectionRange | null {
  const headingRegex = new RegExp(
    `^(#{1,6}\\s+${escapeRegex(heading)})\\s*$`,
    "m"
  );
  const match = body.match(headingRegex);
  if (!match || match.index === undefined) return null;

  const start = match.index;
  const headingLevel = match[1].match(/^#+/)![0].length;
  const afterHeading = body.slice(start + match[0].length);
  const nextHeadingRegex = new RegExp(`^#{1,${headingLevel}}\\s+`, "m");
  const nextMatch = afterHeading.match(nextHeadingRegex);

  const end = nextMatch && nextMatch.index !== undefined
    ? start + match[0].length + nextMatch.index
    : body.length;

  return { start, end, content: body.slice(start, end) };
}

/**
 * Append content under a heading. If the heading exists, inserts before the next
 * same/higher-level heading. If the heading does not exist, creates it at the end.
 *
 * `trailingSeparator` controls the whitespace before content when there is no next heading:
 *   - `"\n\n"` (default) — blank line before content (matches edit_note behaviour)
 *   - `"\n"` — single newline before content (matches daily_capture behaviour)
 */
export function appendUnderHeading(
  body: string,
  heading: string,
  content: string,
  trailingSeparator: string = "\n\n"
): string {
  const section = findSectionRange(body, heading);

  if (section) {
    // Heading exists — check whether next section follows
    const headingRegex = new RegExp(
      `^(#{1,6}\\s+${escapeRegex(heading)})\\s*$`,
      "m"
    );
    const match = body.match(headingRegex)!;
    const headingLevel = match[1].match(/^#+/)![0].length;
    const afterHeading = body.slice(section.start + match[0].length);
    const nextHeadingRegex = new RegExp(`^#{1,${headingLevel}}\\s+`, "m");
    const nextMatch = afterHeading.match(nextHeadingRegex);

    if (nextMatch && nextMatch.index !== undefined) {
      // Insert before next heading
      const insertPos = section.start + match[0].length + nextMatch.index;
      return body.slice(0, insertPos) + content + "\n\n" + body.slice(insertPos);
    }
    // No next heading — append at end
    return body.trimEnd() + trailingSeparator + content + "\n";
  }

  // Heading not found — create at end
  return body.trimEnd() + "\n\n## " + heading + "\n\n" + content + "\n";
}
