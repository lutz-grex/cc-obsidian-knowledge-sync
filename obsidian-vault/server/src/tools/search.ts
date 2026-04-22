import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VaultContext } from "../vault-context.js";
import type { ResolvedConfig } from "../config.js";
import { searchContent, searchFilename, searchFrontmatter } from "../search.js";

export function registerSearchTools(server: McpServer, ctx: VaultContext, config: ResolvedConfig): void {
  server.tool(
    "search",
    "Search the vault by content (ripgrep), filename (glob), or frontmatter fields.",
    {
      query: z.string().describe("Search query string"),
      mode: z
        .enum(["content", "filename", "frontmatter"])
        .describe("Search mode: content (full-text via ripgrep), filename (path matching), frontmatter (field filtering)"),
      field: z
        .string()
        .optional()
        .describe("Frontmatter field to filter on (required for 'frontmatter' mode, e.g. 'tags', 'type', 'date')"),
      operator: z
        .enum(["equals", "contains", "gt", "lt", "exists"])
        .optional()
        .default("contains")
        .describe("Comparison operator for frontmatter mode"),
      folder: z
        .string()
        .optional()
        .describe("Restrict search to this subfolder"),
      limit: z
        .number()
        .optional()
        .default(20)
        .describe("Maximum number of results"),
      regex: z
        .boolean()
        .optional()
        .default(false)
        .describe("Use regex instead of fixed-string matching for content search"),
      vault: z
        .enum(["personal", "team"])
        .optional()
        .default("personal")
        .describe("Which vault to search (requires team vault configured)"),
    },
    async ({ query, mode, field, operator, folder, limit, regex, vault: vaultTarget }) => {
      const targetVault = await ctx.getVault(vaultTarget);
      let results;

      switch (mode) {
        case "content":
          results = await searchContent(targetVault, query, { folder, limit, regex });
          break;
        case "filename":
          results = await searchFilename(targetVault, query, { folder, limit });
          break;
        case "frontmatter":
          if (!field) {
            return {
              content: [{ type: "text" as const, text: "Error: 'frontmatter' mode requires 'field' parameter" }],
              isError: true,
            };
          }
          results = await searchFrontmatter(targetVault, field, query, operator, { folder, limit });
          break;
      }

      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No results found for "${query}" (mode: ${mode})` }],
        };
      }

      const formatted = results.map((r) => {
        const loc = r.lineNumber ? `${r.path}:${r.lineNumber}` : r.path;
        return r.snippet ? `${loc} | ${r.snippet}` : loc;
      });

      return {
        content: [
          {
            type: "text" as const,
            text: formatted.join("\n"),
          },
        ],
      };
    }
  );
}
