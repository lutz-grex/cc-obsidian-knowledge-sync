import * as path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VaultContext } from "../vault-context.js";
import type { ResolvedConfig } from "../config.js";
import { extractAllLinkTargets, noteNameFromPath, resolveTarget } from "../wikilinks.js";
import { searchContent } from "../search.js";
import { escapeRegex } from "../utils.js";

export function registerLinksTools(server: McpServer, ctx: VaultContext, config: ResolvedConfig): void {
  const vault = ctx.personal;
  // --- get_links ---
  server.tool(
    "get_links",
    "Get backlinks (notes linking to this one), outgoing links, or both.",
    {
      path: z.string().describe("Relative path to the note"),
      direction: z
        .enum(["backlinks", "outgoing", "both"])
        .describe("Which link direction to retrieve"),
    },
    async ({ path: notePath, direction }) => {
      const result: { backlinks?: string[]; outgoing?: string[] } = {};

      if (direction === "outgoing" || direction === "both") {
        const content = await vault.readFile(notePath);
        const targets = extractAllLinkTargets(content);
        const sourceDir = path.dirname(notePath);
        const outgoing: string[] = [];
        for (const target of targets) {
          const resolved = await resolveTarget(vault, target, sourceDir);
          if (resolved.status === "resolved") {
            outgoing.push(resolved.path!);
          } else if (resolved.status === "ambiguous") {
            outgoing.push(`${target} (ambiguous: ${resolved.candidates!.join(", ")})`);
          } else {
            outgoing.push(`${target} (not found)`);
          }
        }
        result.outgoing = outgoing;
      }

      if (direction === "backlinks" || direction === "both") {
        const noteName = noteNameFromPath(notePath);
        const noteRelPath = notePath.replace(/\.md$/, "");

        // Broad search for candidates (basename + path-qualified wikilinks + markdown links)
        const searches = [
          searchContent(vault, `\\[\\[${escapeRegex(noteName)}`, { limit: 500, regex: true }),
          searchContent(vault, `\\]\\(${escapeRegex(noteRelPath)}\\.md`, { limit: 500, regex: true }),
        ];
        if (noteRelPath !== noteName) {
          searches.push(searchContent(vault, `\\[\\[${escapeRegex(noteRelPath)}`, { limit: 500, regex: true }));
        }
        const allMatches = (await Promise.all(searches)).flat();

        const candidatePaths = new Set<string>();
        for (const m of allMatches) {
          if (m.path !== notePath) candidatePaths.add(m.path);
        }

        // Verify: parse each candidate's links and check if any resolve to notePath
        const backlinks: string[] = [];
        for (const candPath of candidatePaths) {
          try {
            const candContent = await vault.readFile(candPath);
            const candTargets = extractAllLinkTargets(candContent);
            const candDir = path.dirname(candPath);
            for (const t of candTargets) {
              const res = await resolveTarget(vault, t, candDir);
              if (res.status === "resolved" && res.path === notePath) {
                backlinks.push(candPath);
                break;
              }
            }
          } catch {
            // skip unreadable
          }
        }
        result.backlinks = backlinks.sort();
      }

      const sections: string[] = [];
      if (result.backlinks) {
        sections.push(
          `Backlinks (${result.backlinks.length}):\n${result.backlinks.map((p) => `  ← ${p}`).join("\n") || "  (none)"}`
        );
      }
      if (result.outgoing) {
        sections.push(
          `Outgoing links (${result.outgoing.length}):\n${result.outgoing.map((p) => `  → ${p}`).join("\n") || "  (none)"}`
        );
      }

      return {
        content: [{ type: "text" as const, text: sections.join("\n\n") }],
      };
    }
  );

  // --- resolve_note ---
  server.tool(
    "resolve_note",
    "Resolve an ambiguous note name or partial path to its full vault path. Returns candidates if multiple matches exist. Matches by exact filename, path suffix, or case-insensitive filename.",
    {
      nameOrAlias: z
        .string()
        .describe("Note name, partial path, or alias to resolve"),
    },
    async ({ nameOrAlias }) => {
      const normalized = nameOrAlias.replace(/\.md$/, "");
      const files = await vault.listAllMarkdownFiles();

      const candidates: Array<{ path: string; matchType: string }> = [];

      for (const file of files) {
        const fileName = file.path.split("/").pop()?.replace(/\.md$/, "") || "";

        // Exact filename match
        if (fileName === normalized) {
          candidates.push({ path: file.path, matchType: "exact" });
          continue;
        }

        // Path ends with the query
        if (file.path.replace(/\.md$/, "").endsWith(normalized)) {
          candidates.push({ path: file.path, matchType: "path-suffix" });
          continue;
        }

        // Case-insensitive filename match
        if (fileName.toLowerCase() === normalized.toLowerCase()) {
          candidates.push({ path: file.path, matchType: "case-insensitive" });
        }
      }

      // Sort: exact > path-suffix > case-insensitive
      const priority = { exact: 0, "path-suffix": 1, "case-insensitive": 2 };
      candidates.sort(
        (a, b) =>
          priority[a.matchType as keyof typeof priority] -
          priority[b.matchType as keyof typeof priority]
      );

      if (candidates.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No note found matching "${nameOrAlias}"`,
            },
          ],
        };
      }

      if (candidates.length === 1) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Resolved: ${candidates[0].path}`,
            },
          ],
        };
      }

      const lines = candidates.map(
        (c) => `  ${c.path} (${c.matchType})`
      );
      return {
        content: [
          {
            type: "text" as const,
            text: `Multiple candidates for "${nameOrAlias}":\n${lines.join("\n")}`,
          },
        ],
      };
    }
  );
}

