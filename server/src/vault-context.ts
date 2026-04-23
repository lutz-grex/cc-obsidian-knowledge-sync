import type { Vault } from "./vault.js";
import type { ResolvedTeamConfig } from "./config.js";
import { validateTeamVault } from "./config.js";

export type VaultTarget = "personal" | "team";

export class VaultContext {
  readonly personal: Vault;
  readonly team: Vault | null;
  private teamValidationPromise: Promise<boolean> | null = null;
  private readonly teamConfig: ResolvedTeamConfig | null;

  constructor(personal: Vault, team: Vault | null, teamConfig: ResolvedTeamConfig | null = null) {
    this.personal = personal;
    this.team = team;
    this.teamConfig = teamConfig;
  }

  get hasTeam(): boolean {
    return this.team !== null;
  }

  /** Validate team vault git repo on first access. Retries after failure. */
  private async ensureTeamValidated(): Promise<void> {
    if (!this.teamConfig) return;
    if (!this.teamValidationPromise) {
      this.teamValidationPromise = validateTeamVault(this.teamConfig);
    }
    const valid = await this.teamValidationPromise;
    if (!valid) {
      // Clear cached result so next call retries (user may fix config between calls)
      this.teamValidationPromise = null;
      throw new Error(
        `Team vault at ${this.teamConfig.vaultPath} is not a valid git repo or remote "${this.teamConfig.remote}" not found`
      );
    }
  }

  /** Get a vault by target. For team vaults, runs deferred git validation on first call. */
  async getVault(target: VaultTarget = "personal"): Promise<Vault> {
    if (target === "team") {
      if (!this.team) {
        throw new Error("Team vault not configured. Run /obsidian config team-vault <path>");
      }
      await this.ensureTeamValidated();
      return this.team;
    }
    return this.personal;
  }
}
