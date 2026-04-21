import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VaultContext } from "./vault-context.js";
import type { ResolvedConfig } from "./config.js";
import { registerFileOpsTools } from "./tools/file-ops.js";
import { registerSearchTools } from "./tools/search.js";
import { registerVaultInfoTools } from "./tools/vault-info.js";
import { registerMetadataTools } from "./tools/metadata.js";
import { registerLinksTools } from "./tools/links.js";
import { registerAutomationTools } from "./tools/automation.js";
import { registerTeamTools } from "./tools/team.js";
import { registerLintTools } from "./tools/lint.js";
import { registerDailyQueryTools } from "./tools/daily-query.js";
import { registerGraphTools } from "./tools/graph.js";
import { registerChangelogTools } from "./tools/changelog.js";

export function createServer(ctx: VaultContext, config: ResolvedConfig): McpServer {
  const server = new McpServer({
    name: "obsidian-vault",
    version: "1.0.0",
  });

  // Register all tool groups
  registerFileOpsTools(server, ctx, config);
  registerSearchTools(server, ctx, config);
  registerVaultInfoTools(server, ctx, config);
  registerMetadataTools(server, ctx, config);
  registerLinksTools(server, ctx, config);
  registerAutomationTools(server, ctx, config);
  registerLintTools(server, ctx, config);
  registerDailyQueryTools(server, ctx, config);
  registerGraphTools(server, ctx, config);
  registerChangelogTools(server, ctx, config);

  // Team tools (only registered when team vault is configured)
  if (ctx.hasTeam) {
    registerTeamTools(server, ctx, config);
  }

  return server;
}
