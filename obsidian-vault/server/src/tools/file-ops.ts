import * as path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VaultContext } from "../vault-context.js";
import type { ResolvedConfig } from "../config.js";
import { parseNote, serializeNote } from "../frontmatter.js";
import { noteNameFromPath, rewriteLinks, extractAllLinkTargets, resolveTarget } from "../wikilinks.js";
import { searchContent } from "../search.js";
import { escapeRegex } from "../utils.js";
import { appendUnderHeading } from "../sections.js";

export function registerFileOpsTools(server: McpServer, ctx: VaultContext, config: ResolvedConfig): void {
  const vault = ctx.personal;
  // --- read_note ---
  server.tool(
    "read_note",
    "Read a note from the vault. Optionally parse frontmatter as structured JSON.",
    {
      path: z.string().describe("Relative path to the note (e.g. 'Knowledge/Docker.md')"),
      parseFrontmatter: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, return frontmatter as separate JSON object"),
      vault: z
        .enum(["personal", "team"])
        .optional()
        .default("personal")
        .describe("Which vault to read from (requires team vault configured)"),
    },
    async ({ path: notePath, parseFrontmatter, vault: vaultTarget }) => {
      const targetVault = ctx.getVault(vaultTarget);
      const content = await targetVault.readFile(notePath);

      if (parseFrontmatter) {
        const parsed = parseNote(content);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  path: notePath,
                  frontmatter: parsed.frontmatter,
                  body: parsed.body,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      return {
        content: [{ type: "text" as const, text: content }],
      };
    }
  );

  // --- create_note ---
  server.tool(
    "create_note",
    "Create a new note in the vault with optional YAML frontmatter.",
    {
      path: z.string().describe("Relative path for the new note"),
      content: z.string().describe("Markdown body content"),
      frontmatter: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Frontmatter fields as an object (auto-serialized to YAML)"),
      overwrite: z
        .boolean()
        .optional()
        .default(false)
        .describe("Overwrite if file already exists"),
    },
    async ({ path: notePath, content, frontmatter, overwrite }) => {
      if (!overwrite && (await vault.exists(notePath))) {
        return {
          content: [{ type: "text" as const, text: `Error: File already exists: ${notePath}. Use overwrite=true to replace.` }],
          isError: true,
        };
      }

      const fullContent = frontmatter
        ? serializeNote(frontmatter as Record<string, unknown>, content)
        : content;

      const absPath = await vault.writeFile(notePath, fullContent);
      return {
        content: [{ type: "text" as const, text: `Created: ${notePath}\nAbsolute: ${absPath}` }],
      };
    }
  );

  // --- edit_note ---
  server.tool(
    "edit_note",
    "Edit an existing note using str_replace, append (optionally under a heading), or prepend.",
    {
      path: z.string().describe("Relative path to the note"),
      operation: z.enum(["replace", "append", "prepend"]).describe("Edit mode"),
      oldString: z
        .string()
        .optional()
        .describe("String to find and replace (required for 'replace' operation)"),
      newString: z
        .string()
        .optional()
        .describe("Replacement string (required for 'replace' operation)"),
      content: z
        .string()
        .optional()
        .describe("Content to append or prepend"),
      heading: z
        .string()
        .optional()
        .describe("For 'append': insert content under this heading. Creates heading if not found."),
    },
    async ({ path: notePath, operation, oldString, newString, content: newContent, heading }) => {
      const existing = await vault.readFile(notePath);
      let updated: string;

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
          updated = existing.replaceAll(oldString, newString);
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
            updated = appendUnderHeading(existing, heading, newContent);
          } else {
            updated = existing.trimEnd() + "\n\n" + newContent + "\n";
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
          // Prepend after frontmatter if present
          const parsed = parseNote(existing);
          if (parsed.frontmatter) {
            updated = serializeNote(parsed.frontmatter, newContent + "\n\n" + parsed.body);
          } else {
            updated = newContent + "\n\n" + existing;
          }
          break;
        }
        default:
          return {
            content: [{ type: "text" as const, text: `Error: Unknown operation: ${operation}` }],
            isError: true,
          };
      }

      await vault.writeFile(notePath, updated);
      return {
        content: [{ type: "text" as const, text: `Updated: ${notePath} (${operation})` }],
      };
    }
  );

  // --- delete_note ---
  server.tool(
    "delete_note",
    "Delete a note from the vault. By default moves to .trash/ (soft delete).",
    {
      path: z.string().describe("Relative path to the note"),
      trash: z
        .boolean()
        .optional()
        .default(true)
        .describe("Move to .trash/ instead of permanent delete"),
    },
    async ({ path: notePath, trash }) => {
      if (!(await vault.exists(notePath))) {
        return {
          content: [{ type: "text" as const, text: `Error: File not found: ${notePath}` }],
          isError: true,
        };
      }

      await vault.deleteFile(notePath, trash);
      const action = trash ? "Moved to trash" : "Permanently deleted";
      return {
        content: [{ type: "text" as const, text: `${action}: ${notePath}` }],
      };
    }
  );

  // --- move_note ---
  server.tool(
    "move_note",
    "Move or rename a note. Optionally updates all wikilinks across the vault that referenced the old path.",
    {
      oldPath: z.string().describe("Current relative path of the note"),
      newPath: z.string().describe("New relative path for the note"),
      updateLinks: z
        .boolean()
        .optional()
        .default(true)
        .describe("Rewrite wikilinks in other notes that pointed to the old path"),
    },
    async ({ oldPath, newPath, updateLinks }) => {
      if (!(await vault.exists(oldPath))) {
        return {
          content: [{ type: "text" as const, text: `Error: Source not found: ${oldPath}` }],
          isError: true,
        };
      }

      await vault.moveFile(oldPath, newPath);

      let linksUpdated = 0;
      let linksSkipped = 0;
      let linksAmbiguous = 0;
      if (updateLinks) {
        const oldName = noteNameFromPath(oldPath);
        const newName = noteNameFromPath(newPath);
        const oldRelPath = oldPath.replace(/\.md$/, "");
        const newRelPath = newPath.replace(/\.md$/, "");

        // Broad search: wikilinks (basename + path) and markdown links (basename + path)
        const searches = [
          searchContent(vault, `\\[\\[${escapeRegex(oldName)}`, { limit: 500, regex: true }),
          searchContent(vault, `\\]\\(${escapeRegex(oldName)}\\.md`, { limit: 500, regex: true }),
        ];
        if (oldRelPath !== oldName) {
          searches.push(searchContent(vault, `\\[\\[${escapeRegex(oldRelPath)}`, { limit: 500, regex: true }));
          searches.push(searchContent(vault, `\\]\\(${escapeRegex(oldRelPath)}\\.md`, { limit: 500, regex: true }));
        }
        const searchResults = await Promise.all(searches);

        const allBacklinks = new Map<string, (typeof searchResults)[0][0]>();
        for (const r of searchResults.flat()) {
          allBacklinks.set(r.path, r);
        }

        // Parse-and-resolve: only rewrite links proven to point to the moved file
        for (const result of allBacklinks.values()) {
          if (result.path === newPath) continue;
          try {
            const content = await vault.readFile(result.path);
            const targets = extractAllLinkTargets(content);
            const candDir = path.dirname(result.path);

            // Only rewrite links individually proven to point to the moved file
            let rewritten = content;
            for (const t of targets) {
              const res = await resolveTarget(vault, t, candDir);
              const tName = t.split("/").pop()?.replace(/\.md$/, "") || "";
              const shouldRewrite =
                (res.status === "resolved" && res.path === newPath) ||
                (res.status === "missing" && tName === oldName);

              if (res.status === "ambiguous") {
                linksAmbiguous++;
                continue;
              }
              if (!shouldRewrite) continue;

              // Rewrite only this specific link target, not all basename matches
              if (t.includes("/")) {
                // Path-qualified: rewrite the exact path form
                const tNoMd = t.replace(/\.md$/, "");
                rewritten = rewriteLinks(rewritten, tName, newName, tNoMd, newRelPath);
              } else {
                // Basename-only: always pass path args so folder moves are rewritten
                rewritten = rewriteLinks(rewritten, t.replace(/\.md$/, ""), newName, oldRelPath, newRelPath);
              }
            }
            if (rewritten !== content) {
              await vault.writeFile(result.path, rewritten);
              linksUpdated++;
            }
          } catch (err: unknown) {
            linksSkipped++;
            process.stderr.write(`[move_note] skipped backlink update for ${result.path}: ${err}\n`);
          }
        }
      }

      const parts = [`Moved: ${oldPath} → ${newPath}`];
      if (updateLinks) {
        parts.push(`Links updated: ${linksUpdated} files`);
        if (linksAmbiguous > 0) parts.push(`Ambiguous links (not rewritten): ${linksAmbiguous}`);
        if (linksSkipped > 0) parts.push(`Links skipped (errors): ${linksSkipped}`);
      }

      return {
        content: [{ type: "text" as const, text: parts.join("\n") }],
      };
    }
  );
}

