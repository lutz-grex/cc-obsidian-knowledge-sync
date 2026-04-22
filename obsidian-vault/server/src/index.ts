#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveConfig, buildTeamVaultConfig } from "./config.js";
import { Vault } from "./vault.js";
import { VaultContext } from "./vault-context.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const config = await resolveConfig();
  const personalVault = new Vault(config);

  let teamVault: Vault | null = null;
  if (config.team) {
    const teamVaultConfig = buildTeamVaultConfig(config);
    teamVault = new Vault(teamVaultConfig);
  }

  const context = new VaultContext(personalVault, teamVault, config.team);
  const server = createServer(context, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(
    `obsidian-vault-mcp started: ${config.vaultName} (${config.vaultPath})` +
      (config.team ? ` + team: ${config.team.vaultName}` : "") +
      "\n"
  );
}

main().catch((error) => {
  process.stderr.write(`Fatal error: ${error.message}\n`);
  process.exit(1);
});
