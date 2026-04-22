import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VaultContext } from "../vault-context.js";
import type { ResolvedConfig } from "../config.js";
import { parseNote, serializeNote } from "../frontmatter.js";
import { escapeRegex, escapeReplacement, localDate, localTime, formatDate, parseDateString } from "../utils.js";
import { appendUnderHeading } from "../sections.js";

export function registerAutomationTools(server: McpServer, ctx: VaultContext, config: ResolvedConfig): void {
  const vault = ctx.personal;
  // --- daily_capture ---
  server.tool(
    "daily_capture",
    "Append content to today's (or specified date's) daily note under an optional heading. Creates the daily note if it does not exist.",
    {
      content: z.string().describe("Content to append"),
      heading: z
        .string()
        .optional()
        .describe("Heading to append under (e.g. 'Log', 'Claude Sessions'). Created if missing."),
      date: z
        .string()
        .optional()
        .describe("ISO date YYYY-MM-DD (defaults to today)"),
    },
    async ({ content, heading, date }) => {
      const now = new Date();
      const targetDate = date || localDate(now);
      const dateObj = date ? parseDateString(date) : now;
      const formattedName = formatDate(dateObj, config.dailyNoteFormat);
      const dailyNotePath = `${config.dailyNotesFolder}/${formattedName}.md`;

      if (await vault.exists(dailyNotePath)) {
        // Append to existing
        const existing = await vault.readFile(dailyNotePath);

        let updated: string;
        if (heading) {
          updated = appendUnderHeading(existing, heading, content, "\n");
        } else {
          updated = existing.trimEnd() + "\n" + content + "\n";
        }

        await vault.writeFile(dailyNotePath, updated);
      } else {
        // Create new daily note
        const frontmatter = {
          date: targetDate,
          type: "daily-note",
        };
        let body = `# ${targetDate}\n\n`;
        if (heading) {
          body += `## ${heading}\n\n${content}\n`;
        } else {
          body += `${content}\n`;
        }
        const fullContent = serializeNote(frontmatter, body);
        await vault.writeFile(dailyNotePath, fullContent);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Captured to ${dailyNotePath}${heading ? ` under "${heading}"` : ""}`,
          },
        ],
      };
    }
  );

  // --- apply_template ---
  server.tool(
    "apply_template",
    "Read a template file, substitute {{variable}} placeholders, and write to target path.",
    {
      templatePath: z.string().describe("Relative path to the template file"),
      targetPath: z.string().describe("Relative path where the result should be written"),
      variables: z
        .record(z.string(), z.string())
        .optional()
        .describe("Key-value pairs for template substitution (replaces {{key}} with value)"),
      overwrite: z.boolean().optional().default(false).describe("Allow overwriting an existing file at targetPath"),
    },
    async ({ templatePath, targetPath, variables, overwrite }) => {
      if (!(await vault.exists(templatePath))) {
        return {
          content: [{ type: "text" as const, text: `Error: Template not found: ${templatePath}` }],
          isError: true,
        };
      }

      let content = await vault.readFile(templatePath);

      if (variables) {
        for (const [key, value] of Object.entries(variables)) {
          content = content.replace(
            new RegExp(`\\{\\{\\s*${escapeRegex(key)}\\s*\\}\\}`, "g"),
            escapeReplacement(value)
          );
        }
      }

      // Also substitute built-in variables
      const tplNow = new Date();
      const builtins: Record<string, string> = {
        date: localDate(tplNow),
        time: localTime(tplNow),
        datetime: `${localDate(tplNow)}T${localTime(tplNow)}`,
        year: String(tplNow.getFullYear()),
        month: String(tplNow.getMonth() + 1).padStart(2, "0"),
        day: String(tplNow.getDate()).padStart(2, "0"),
      };

      for (const [key, value] of Object.entries(builtins)) {
        content = content.replace(
          new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, "g"),
          value
        );
      }

      if (!overwrite && (await vault.exists(targetPath))) {
        return {
          content: [{ type: "text" as const, text: `Error: File already exists: ${targetPath}. Use overwrite=true to replace.` }],
          isError: true,
        };
      }

      await vault.writeFile(targetPath, content);
      return {
        content: [
          {
            type: "text" as const,
            text: `Template applied: ${templatePath} → ${targetPath}`,
          },
        ],
      };
    }
  );

  // --- preview_edit ---
  server.tool(
    "preview_edit",
    "Preview what an edit would look like WITHOUT writing changes. Returns a diff-style preview. Same parameters as edit_note.",
    {
      path: z.string().describe("Relative path to the note"),
      operation: z.enum(["replace", "append", "prepend"]).describe("Edit mode"),
      oldString: z.string().optional().describe("String to find (for replace)"),
      newString: z.string().optional().describe("Replacement string (for replace)"),
      content: z.string().optional().describe("Content to append or prepend"),
      heading: z.string().optional().describe("For append: target heading"),
    },
    async ({ path: notePath, operation, oldString, newString, content: newContent, heading }) => {
      if (!(await vault.exists(notePath))) {
        return {
          content: [{ type: "text" as const, text: `Error: File not found: ${notePath}` }],
          isError: true,
        };
      }

      const existing = await vault.readFile(notePath);
      let preview: string;

      switch (operation) {
        case "replace": {
          if (!oldString || newString === undefined) {
            return {
              content: [{ type: "text" as const, text: "Error: 'replace' requires oldString and newString" }],
              isError: true,
            };
          }
          if (!existing.includes(oldString)) {
            return {
              content: [{ type: "text" as const, text: `Error: oldString not found in ${notePath}` }],
              isError: true,
            };
          }
          const updated = existing.replaceAll(oldString, newString);
          preview = generateDiff(existing, updated, notePath);
          break;
        }
        case "append": {
          if (!newContent) {
            return {
              content: [{ type: "text" as const, text: "Error: 'append' requires content" }],
              isError: true,
            };
          }
          // Simulate the same way edit_note does — operate on full content, not parsed body
          const simulated = heading
            ? appendUnderHeading(existing, heading, newContent)
            : existing.trimEnd() + "\n\n" + newContent + "\n";
          preview = generateDiff(existing, simulated, notePath);
          break;
        }
        case "prepend": {
          if (!newContent) {
            return {
              content: [{ type: "text" as const, text: "Error: 'prepend' requires content" }],
              isError: true,
            };
          }
          const { frontmatter: fm, body } = parseNote(existing);
          const updatedBody = newContent + "\n\n" + body;
          const simulated = serializeNote(fm, updatedBody);
          preview = generateDiff(existing, simulated, notePath);
          break;
        }
        default:
          preview = "Unknown operation";
      }

      return {
        content: [{ type: "text" as const, text: `Preview (no changes written):\n\n${preview}` }],
      };
    }
  );
}

/**
 * Compute the longest common subsequence of two string arrays.
 * Returns an array of [oldIndex, newIndex] pairs.
 */
function lcs(a: string[], b: string[]): Array<[number, number]> {
  const m = a.length;
  const n = b.length;
  // DP table — only store lengths, then backtrack
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  // Backtrack to find pairs
  const pairs: Array<[number, number]> = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      pairs.push([i - 1, j - 1]);
      i--; j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return pairs.reverse();
}

/** Max combined line count for full LCS diff; above this, use simple line-by-line. */
const MAX_DIFF_LINES = 4000;

/**
 * Generate a unified diff between two texts with @@ hunk headers and context lines.
 * Falls back to simple line-by-line diff for large files to avoid O(m*n) cost.
 */
function generateDiff(oldText: string, newText: string, filePath: string): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  // Guard: fall back to simple diff for very large files
  if (oldLines.length + newLines.length > MAX_DIFF_LINES) {
    return generateSimpleDiff(oldLines, newLines, filePath);
  }
  const common = lcs(oldLines, newLines);

  // Build edit script: groups of (equal | removed | added)
  interface Edit { type: "eq" | "rm" | "add"; oldIdx: number; newIdx: number; line: string; }
  const edits: Edit[] = [];
  let oi = 0, ni = 0;
  for (const [ci, cj] of common) {
    while (oi < ci) { edits.push({ type: "rm", oldIdx: oi, newIdx: ni, line: oldLines[oi] }); oi++; }
    while (ni < cj) { edits.push({ type: "add", oldIdx: oi, newIdx: ni, line: newLines[ni] }); ni++; }
    edits.push({ type: "eq", oldIdx: oi, newIdx: ni, line: oldLines[oi] });
    oi++; ni++;
  }
  while (oi < oldLines.length) { edits.push({ type: "rm", oldIdx: oi, newIdx: ni, line: oldLines[oi] }); oi++; }
  while (ni < newLines.length) { edits.push({ type: "add", oldIdx: oi, newIdx: ni, line: newLines[ni] }); ni++; }

  // Group edits into hunks with 3 lines of context
  const CTX = 3;
  const hunks: Array<{ oldStart: number; oldLen: number; newStart: number; newLen: number; lines: string[] }> = [];
  let hunk: typeof hunks[0] | null = null;
  let lastChangeEnd = -1;

  for (let e = 0; e < edits.length; e++) {
    const edit = edits[e];
    if (edit.type !== "eq") {
      const ctxStart = Math.max(0, e - CTX);
      if (!hunk || ctxStart > lastChangeEnd + CTX) {
        // Start new hunk
        if (hunk) hunks.push(hunk);
        const firstEdit = edits[ctxStart];
        hunk = { oldStart: firstEdit.oldIdx + 1, oldLen: 0, newStart: firstEdit.newIdx + 1, newLen: 0, lines: [] };
        // Add leading context
        for (let c = ctxStart; c < e; c++) {
          hunk.lines.push(` ${edits[c].line}`);
          hunk.oldLen++;
          hunk.newLen++;
        }
      } else {
        // Extend current hunk with bridging context
        for (let c = lastChangeEnd + 1; c < e; c++) {
          hunk.lines.push(` ${edits[c].line}`);
          hunk.oldLen++;
          hunk.newLen++;
        }
      }
      if (edit.type === "rm") {
        hunk.lines.push(`-${edit.line}`);
        hunk.oldLen++;
      } else {
        hunk.lines.push(`+${edit.line}`);
        hunk.newLen++;
      }
      lastChangeEnd = e;
    }
  }
  // Trailing context for last hunk
  if (hunk) {
    for (let c = lastChangeEnd + 1; c < Math.min(edits.length, lastChangeEnd + 1 + CTX); c++) {
      hunk.lines.push(` ${edits[c].line}`);
      hunk.oldLen++;
      hunk.newLen++;
    }
    hunks.push(hunk);
  }

  if (hunks.length === 0) return "No differences found.";

  const out: string[] = [`--- ${filePath}`, `+++ ${filePath} (modified)`];
  for (const h of hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLen} +${h.newStart},${h.newLen} @@`);
    out.push(...h.lines);
  }
  return out.join("\n");
}

/** Simple line-by-line diff for large files — O(n) instead of O(m*n). */
function generateSimpleDiff(oldLines: string[], newLines: string[], filePath: string): string {
  const out: string[] = [`--- ${filePath}`, `+++ ${filePath} (modified)`, `(simplified diff — file too large for full LCS)`];
  const maxLen = Math.max(oldLines.length, newLines.length);
  let inHunk = false;
  for (let i = 0; i < maxLen; i++) {
    const ol = i < oldLines.length ? oldLines[i] : undefined;
    const nl = i < newLines.length ? newLines[i] : undefined;
    if (ol === nl) {
      inHunk = false;
    } else {
      if (!inHunk) { out.push(`@@ line ${i + 1} @@`); inHunk = true; }
      if (ol !== undefined) out.push(`-${ol}`);
      if (nl !== undefined) out.push(`+${nl}`);
    }
  }
  return out.join("\n");
}
