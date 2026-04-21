import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VaultContext } from "../vault-context.js";
import type { ResolvedConfig } from "../config.js";
import { serializeNote } from "../frontmatter.js";
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
    },
    async ({ templatePath, targetPath, variables }) => {
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
          if (heading) {
            preview = `Would append under "${heading}" in ${notePath}:\n\n${newContent}`;
          } else {
            preview = `Would append to end of ${notePath}:\n\n${newContent}`;
          }
          break;
        }
        case "prepend": {
          if (!newContent) {
            return {
              content: [{ type: "text" as const, text: "Error: 'prepend' requires content" }],
              isError: true,
            };
          }
          preview = `Would prepend to ${notePath} (after frontmatter):\n\n${newContent}`;
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

function generateDiff(oldText: string, newText: string, filePath: string): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const diff: string[] = [`--- ${filePath}`, `+++ ${filePath} (modified)`];

  // Sets for O(1) membership checks; stall guard forces progress
  // when both pointers land on lines present in both files.
  const newLineSet = new Set<string>(newLines);
  const oldLineSet = new Set<string>(oldLines);

  let i = 0;
  let j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      i++;
      j++;
    } else {
      const contextStart = Math.max(0, i - 2);
      for (let c = contextStart; c < i; c++) {
        diff.push(` ${oldLines[c]}`);
      }
      let oi = i;
      let ni = j;
      while (oi < oldLines.length && !newLineSet.has(oldLines[oi])) {
        diff.push(`-${oldLines[oi]}`);
        oi++;
      }
      while (ni < newLines.length && !oldLineSet.has(newLines[ni])) {
        diff.push(`+${newLines[ni]}`);
        ni++;
      }
      // If both loops stalled (lines exist in each other's set but at
      // different positions), force one step to avoid an infinite loop.
      if (oi === i && ni === j) {
        if (i < oldLines.length) { diff.push(`-${oldLines[oi]}`); oi++; }
        if (j < newLines.length) { diff.push(`+${newLines[ni]}`); ni++; }
      }
      i = oi;
      j = ni;
    }
  }

  return diff.join("\n");
}
