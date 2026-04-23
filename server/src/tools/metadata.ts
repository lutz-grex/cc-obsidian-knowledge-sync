import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VaultContext } from "../vault-context.js";
import type { ResolvedConfig } from "../config.js";
import { parseNote, serializeNote, mergeFrontmatter } from "../frontmatter.js";
import { fmStringArray } from "../schemas.js";
import { escapeRegex } from "../utils.js";

export function registerMetadataTools(server: McpServer, ctx: VaultContext, config: ResolvedConfig): void {
  const vault = ctx.personal;
  // --- manage_frontmatter ---
  server.tool(
    "manage_frontmatter",
    "Get, set, or merge frontmatter fields on a single note. Can also add/remove tags.",
    {
      path: z.string().describe("Relative path to the note"),
      action: z
        .enum(["get", "set", "merge"])
        .describe("'get' returns frontmatter, 'set' replaces it, 'merge' deep-merges fields"),
      fields: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Fields to set or merge (for 'set' and 'merge' actions)"),
      addTags: z
        .array(z.string())
        .optional()
        .describe("Tags to add to the frontmatter tags array"),
      removeTags: z
        .array(z.string())
        .optional()
        .describe("Tags to remove from the frontmatter tags array"),
    },
    async ({ path: notePath, action, fields, addTags, removeTags }) => {
      const content = await vault.readFile(notePath);
      const parsed = parseNote(content);

      if (action === "get") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { path: notePath, frontmatter: parsed.frontmatter || {} },
                null,
                2
              ),
            },
          ],
        };
      }

      let fm = parsed.frontmatter || {};

      if (action === "set" && fields) {
        fm = fields as Record<string, unknown>;
      } else if (action === "merge" && fields) {
        fm = mergeFrontmatter(fm, fields as Record<string, unknown>);
      }

      // Handle tag operations
      if (addTags || removeTags) {
        let tags: string[] = fmStringArray(fm, "tags");

        if (addTags) {
          for (const tag of addTags) {
            const normalized = tag.replace(/^#/, "");
            if (!tags.includes(normalized)) {
              tags.push(normalized);
            }
          }
        }

        if (removeTags) {
          const removeSet = new Set(removeTags.map((t) => t.replace(/^#/, "")));
          tags = tags.filter((t) => !removeSet.has(t));
        }

        fm.tags = tags;
      }

      const updated = serializeNote(fm, parsed.body);
      await vault.writeFile(notePath, updated);

      return {
        content: [
          {
            type: "text" as const,
            text: `Updated frontmatter for ${notePath}:\n${JSON.stringify(fm, null, 2)}`,
          },
        ],
      };
    }
  );

  // --- vault_tags ---
  server.tool(
    "vault_tags",
    "List all tags in the vault with occurrence counts, or rename a tag vault-wide.",
    {
      action: z.enum(["list", "rename"]).describe("'list' shows all tags, 'rename' replaces one tag with another"),
      oldTag: z.string().optional().describe("Tag to rename (for 'rename' action)"),
      newTag: z.string().optional().describe("New tag name (for 'rename' action)"),
      dryRun: z.boolean().optional().default(false).describe("When true, scan but don't write — return count + list of files that would change"),
    },
    async ({ action, oldTag, newTag, dryRun }) => {
      if (action === "list") {
        const tagCounts = new Map<string, number>();
        let skippedFiles = 0;
        const files = await vault.listAllMarkdownFiles();
        const BATCH = 20;

        for (let i = 0; i < files.length; i += BATCH) {
          const batch = files.slice(i, i + BATCH);
          const results = await Promise.all(batch.map(async (file) => {
            try {
              const content = await vault.readFile(file.path);
              const { frontmatter, body } = parseNote(content);
              const tags = fmStringArray(frontmatter, "tags");
              const inlineTags = body.match(/(?:^|\s)#([a-zA-Z][\w-/]*)(?=\s|$)/gm);
              return { tags, inlineTags, error: false };
            } catch (err: unknown) {
              process.stderr.write(`[vault_tags] skipped ${file.path}: ${err}\n`);
              return { tags: [] as string[], inlineTags: null, error: true };
            }
          }));
          for (const r of results) {
            if (r.error) { skippedFiles++; continue; }
            for (const tag of r.tags) {
              tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
            }
            if (r.inlineTags) {
              for (const match of r.inlineTags) {
                const tag = match.trim().slice(1);
                tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
              }
            }
          }
        }

        const sorted = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]);
        const lines = sorted.map(([tag, count]) => `#${tag} (${count})`);
        const warn = skippedFiles > 0 ? `\n\n(${skippedFiles} file(s) could not be read)` : "";

        return {
          content: [
            {
              type: "text" as const,
              text: `${sorted.length} unique tag(s):\n\n${lines.join("\n")}${warn}`,
            },
          ],
        };
      }

      if (action === "rename") {
        if (!oldTag || !newTag) {
          return {
            content: [{ type: "text" as const, text: "Error: 'rename' requires oldTag and newTag" }],
            isError: true,
          };
        }

        const normalizedOld = oldTag.replace(/^#/, "");
        const normalizedNew = newTag.replace(/^#/, "");
        const affectedPaths: string[] = [];

        const files = await vault.listAllMarkdownFiles();
        const BATCH = 20;

        // Phase 1: read + compute changes in batches
        const changes: Array<{ path: string; content: string }> = [];
        for (let i = 0; i < files.length; i += BATCH) {
          const batch = files.slice(i, i + BATCH);
          const results = await Promise.all(batch.map(async (file) => {
            try {
              let content = await vault.readFile(file.path);
              let modified = false;

              const parsed = parseNote(content);
              if (parsed.frontmatter) {
                const tags = fmStringArray(parsed.frontmatter, "tags");
                let tagModified = false;
                for (let ti = 0; ti < tags.length; ti++) {
                  if (tags[ti] === normalizedOld) {
                    tags[ti] = normalizedNew;
                    tagModified = true;
                  }
                }
                if (tagModified) {
                  parsed.frontmatter.tags = tags;
                  content = serializeNote(parsed.frontmatter, parsed.body);
                  modified = true;
                }
              }

              const replaced = content.replace(
                new RegExp(`(^|\\s)#${escapeRegex(normalizedOld)}(?=\\s|$)`, "g"),
                `$1#${normalizedNew}`
              );
              if (replaced !== content) {
                content = replaced;
                modified = true;
              }

              return modified ? { path: file.path, content } : null;
            } catch (err: unknown) {
              process.stderr.write(`[vault_tags rename] skipped ${file.path}: ${err}\n`);
              return null;
            }
          }));
          for (const r of results) {
            if (r) { changes.push(r); affectedPaths.push(r.path); }
          }
        }

        // Phase 2: batch writes
        if (!dryRun) {
          for (let i = 0; i < changes.length; i += BATCH) {
            const batch = changes.slice(i, i + BATCH);
            await Promise.all(batch.map((c) => vault.writeFile(c.path, c.content)));
          }
        }

        const filesUpdated = changes.length;

        if (dryRun) {
          const fileList = affectedPaths.length > 0
            ? "\n\nFiles that would change:\n" + affectedPaths.map((p) => `  ${p}`).join("\n")
            : "";
          return {
            content: [
              {
                type: "text" as const,
                text: `[dry run] #${normalizedOld} → #${normalizedNew} would affect ${filesUpdated} file(s)${fileList}`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Renamed #${normalizedOld} → #${normalizedNew} in ${filesUpdated} file(s)`,
            },
          ],
        };
      }

      return { content: [{ type: "text" as const, text: "Unknown action" }], isError: true };
    }
  );
}

