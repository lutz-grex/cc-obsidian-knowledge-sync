import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VaultContext } from "../vault-context.js";
import type { ResolvedConfig } from "../config.js";

export function registerVaultInfoTools(server: McpServer, ctx: VaultContext, config: ResolvedConfig): void {
  server.tool(
    "vault_info",
    "Get vault information: list files, directory tree, statistics, recent files, or resolved config.",
    {
      action: z
        .enum(["list", "tree", "stats", "recent", "config"])
        .describe("What to retrieve"),
      folder: z
        .string()
        .optional()
        .describe("Subfolder to scope the action to"),
      limit: z
        .number()
        .optional()
        .default(50)
        .describe("Max items for list/recent"),
      depth: z
        .number()
        .optional()
        .default(3)
        .describe("Max depth for tree"),
      vault: z
        .enum(["personal", "team"])
        .optional()
        .default("personal")
        .describe("Which vault to query (requires team vault configured)"),
    },
    async ({ action, folder, limit, depth, vault: vaultTarget }) => {
      const targetVault = ctx.getVault(vaultTarget);
      switch (action) {
        case "list": {
          const files = await targetVault.listMarkdownFiles(folder || "", true, limit);
          const lines = files.map(
            (f) => `${f.path} (${formatBytes(f.size)}, ${f.mtime.toISOString().split("T")[0]})`
          );
          return {
            content: [
              {
                type: "text" as const,
                text: `${files.length} note(s)${folder ? ` in ${folder}/` : ""}:\n\n${lines.join("\n")}`,
              },
            ],
          };
        }

        case "tree": {
          const tree = await targetVault.getTree(folder || "", depth);
          return {
            content: [{ type: "text" as const, text: tree || "(empty)" }],
          };
        }

        case "stats": {
          const stats = await targetVault.getStats();
          const text = [
            `Notes: ${stats.noteCount}`,
            `Folders: ${stats.folders}`,
            `Total size: ${formatBytes(stats.totalSizeBytes)}`,
            ``,
            `Recently modified:`,
            ...stats.recentlyModified.map((r) => `  ${r.path} (${r.mtime.split("T")[0]})`),
          ].join("\n");
          return {
            content: [{ type: "text" as const, text }],
          };
        }

        case "recent": {
          const files = await targetVault.listMarkdownFiles(folder || "", true, limit);
          // Already sorted by mtime desc
          const lines = files.map(
            (f) => `${f.mtime.toISOString().split("T")[0]} ${f.mtime.toISOString().split("T")[1].slice(0, 5)} ${f.path}`
          );
          return {
            content: [
              {
                type: "text" as const,
                text: `${files.length} most recent note(s):\n\n${lines.join("\n")}`,
              },
            ],
          };
        }

        case "config": {
          return {
            content: [
              {
                type: "text" as const,
                text: `Resolved configuration:\n\n${JSON.stringify(config, null, 2)}`,
              },
            ],
          };
        }
      }
    }
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
