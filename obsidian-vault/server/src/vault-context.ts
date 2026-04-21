import type { Vault } from "./vault.js";

export type VaultTarget = "personal" | "team";

export class VaultContext {
  readonly personal: Vault;
  readonly team: Vault | null;

  constructor(personal: Vault, team: Vault | null) {
    this.personal = personal;
    this.team = team;
  }

  get hasTeam(): boolean {
    return this.team !== null;
  }

  getVault(target: VaultTarget = "personal"): Vault {
    if (target === "team") {
      if (!this.team) {
        throw new Error("Team vault not configured. Run /obsidian config team-vault <path>");
      }
      return this.team;
    }
    return this.personal;
  }
}
