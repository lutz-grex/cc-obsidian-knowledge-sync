import * as fs from "node:fs/promises";
import * as path from "node:path";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { z } from "zod";

const execFileAsync = promisify(execFile);

// ─── Schemas ─────────────────────────────────────────────────────────────────

const VaultEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
});

const TeamVaultConfigSchema = z.object({
  path: z.string(),
  name: z.string().default("team"),
  remote: z.string().default("origin"),
  branch: z.string().default("main"),
  knowledgeFolder: z.string().default("Knowledge"),
  proposalFolder: z.string().default(".proposals"),
  requireApproval: z.boolean().default(true),
});

const UserConfigSchema = z.object({
  vaults: z.array(VaultEntrySchema).min(1),
  activeVault: z.string(),
  author: z.string().default(""),
  transport: z.literal("stdio").default("stdio"),
  teamVault: TeamVaultConfigSchema.optional(),
});

const VaultLocalConfigSchema = z.object({
  sessionFolder: z.string().optional(),
  dailyNotesFolder: z.string().optional(),
  knowledgeFolder: z.string().optional(),
  dailyNoteFormat: z.string().optional(),
  trashFolder: z.string().optional(),
  defaultTags: z.array(z.string()).optional(),
  excludeFolders: z.array(z.string()).optional(),
  linkToDailyNote: z.boolean().optional(),
  templateOverrides: z.record(z.string(), z.unknown()).optional(),
  knowledgeMaxLines: z.number().optional(),
  knowledgeMaxHeadings: z.number().optional(),
});

// ─── Inferred Types ──────────────────────────────────────────────────────────

export type VaultEntry = z.infer<typeof VaultEntrySchema>;
export type TeamVaultConfig = z.infer<typeof TeamVaultConfigSchema>;
export type UserConfig = z.infer<typeof UserConfigSchema>;
export type VaultLocalConfig = z.infer<typeof VaultLocalConfigSchema>;

export interface ResolvedTeamConfig {
  vaultPath: string;
  vaultName: string;
  remote: string;
  branch: string;
  knowledgeFolder: string;
  proposalFolder: string;
  requireApproval: boolean;
}

export interface ResolvedConfig {
  vaultPath: string;
  vaultName: string;
  author: string;
  sessionFolder: string;
  dailyNotesFolder: string;
  knowledgeFolder: string;
  dailyNoteFormat: string;
  trashFolder: string;
  defaultTags: string[];
  excludeFolders: string[];
  linkToDailyNote: boolean;
  templateOverrides: Record<string, unknown>;
  knowledgeMaxLines: number;
  knowledgeMaxHeadings: number;
  team: ResolvedTeamConfig | null;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULTS = {
  sessionFolder: "Claude Sessions",
  dailyNotesFolder: "Daily Notes",
  knowledgeFolder: "Knowledge",
  dailyNoteFormat: "YYYY-MM-DD",
  trashFolder: ".trash",
  defaultTags: [] as string[],
  excludeFolders: [".obsidian", ".trash", "Templates"],
  linkToDailyNote: true,
  templateOverrides: {} as Record<string, unknown>,
  knowledgeMaxLines: 400,
  knowledgeMaxHeadings: 10,
} as const;

// ─── Paths ───────────────────────────────────────────────────────────────────

const USER_CONFIG_DIR = path.join(homedir(), ".config", "obsidian-claude");
const USER_CONFIG_PATH = path.join(USER_CONFIG_DIR, "config.json");
const VAULT_LOCAL_FILENAME = ".obsidian-claude.json";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Expand ~ to home directory in paths. */
function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return path.join(homedir(), p.slice(2));
  }
  return p;
}

async function readJsonFile(filePath: string): Promise<unknown | null> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch (err: unknown) {
    // Only treat ENOENT as "missing" — rethrow real errors
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw new Error(`Failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return JSON.parse(content);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Invalid JSON in ${filePath}: ${msg}`);
  }
}

export async function loadUserConfig(): Promise<UserConfig | null> {
  const raw = await readJsonFile(USER_CONFIG_PATH);
  if (raw === null) return null;

  const result = UserConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(
      `Invalid config in ${USER_CONFIG_PATH}:\n${issues.join("\n")}`
    );
  }
  return result.data;
}

export async function loadVaultLocalConfig(vaultPath: string): Promise<VaultLocalConfig | null> {
  const configPath = path.join(vaultPath, VAULT_LOCAL_FILENAME);
  const raw = await readJsonFile(configPath);
  if (raw === null) return null;

  const result = VaultLocalConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(
      `Invalid vault config in ${configPath}:\n${issues.join("\n")}`
    );
  }
  return result.data;
}

// ─── Git Validation ──────────────────────────────────────────────────────────

async function validateGitRepo(repoPath: string, remote: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: repoPath,
    });
    if (stdout.trim() !== "true") return false;

    await execFileAsync("git", ["remote", "get-url", remote], { cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}

async function resolveTeamVault(userConfig: UserConfig | null): Promise<ResolvedTeamConfig | null> {
  const envTeamPath = process.env.OBSIDIAN_TEAM_VAULT_PATH;
  const teamConfig = userConfig?.teamVault;

  if (!envTeamPath && !teamConfig) return null;

  const teamPath = path.resolve(expandHome(envTeamPath || teamConfig!.path));
  const name = teamConfig?.name || path.basename(teamPath);
  const remote = teamConfig?.remote || "origin";
  const branch = teamConfig?.branch || "main";

  if (!existsSync(teamPath)) {
    process.stderr.write(`[team-vault] Path does not exist: ${teamPath}\n`);
    return null;
  }

  const isGit = await validateGitRepo(teamPath, remote);
  if (!isGit) {
    process.stderr.write(
      `[team-vault] Not a valid git repo or remote "${remote}" not found: ${teamPath}\n`
    );
    return null;
  }

  return {
    vaultPath: teamPath,
    vaultName: name,
    remote,
    branch,
    knowledgeFolder: teamConfig?.knowledgeFolder || "Knowledge",
    proposalFolder: teamConfig?.proposalFolder || ".proposals",
    requireApproval: teamConfig?.requireApproval ?? true,
  };
}

// ─── Main Resolution ─────────────────────────────────────────────────────────

export async function resolveConfig(): Promise<ResolvedConfig> {
  // Layer 1: Environment variable override
  const envVaultPath = process.env.OBSIDIAN_VAULT_PATH;

  // Layer 2: User config
  const userConfig = await loadUserConfig();

  // Determine vault path
  let vaultPath: string;
  let vaultName: string;

  if (envVaultPath) {
    vaultPath = path.resolve(expandHome(envVaultPath));
    vaultName = path.basename(vaultPath);
  } else if (userConfig && userConfig.vaults.length > 0) {
    const active = userConfig.vaults.find((v) => v.name === userConfig.activeVault);
    const vault = active || userConfig.vaults[0];
    vaultPath = path.resolve(expandHome(vault.path));
    vaultName = vault.name;
  } else {
    throw new Error(
      "No vault configured. Set OBSIDIAN_VAULT_PATH or run /obsidian config vault <path>"
    );
  }

  if (!existsSync(vaultPath)) {
    throw new Error(`Vault path does not exist: ${vaultPath}`);
  }

  // Layer 3: Vault-local config
  const vaultLocal = await loadVaultLocalConfig(vaultPath);

  // Resolve team vault (graceful — returns null if not configured or invalid)
  const team = await resolveTeamVault(userConfig);

  // Merge: vault-local overrides defaults
  const resolved: ResolvedConfig = {
    vaultPath,
    vaultName,
    author: userConfig?.author || "",
    sessionFolder: vaultLocal?.sessionFolder ?? DEFAULTS.sessionFolder,
    dailyNotesFolder: vaultLocal?.dailyNotesFolder ?? DEFAULTS.dailyNotesFolder,
    knowledgeFolder: vaultLocal?.knowledgeFolder ?? DEFAULTS.knowledgeFolder,
    dailyNoteFormat: vaultLocal?.dailyNoteFormat ?? DEFAULTS.dailyNoteFormat,
    trashFolder: vaultLocal?.trashFolder ?? DEFAULTS.trashFolder,
    defaultTags: vaultLocal?.defaultTags ?? [...DEFAULTS.defaultTags],
    excludeFolders: vaultLocal?.excludeFolders ?? [...DEFAULTS.excludeFolders],
    linkToDailyNote: vaultLocal?.linkToDailyNote ?? DEFAULTS.linkToDailyNote,
    templateOverrides: vaultLocal?.templateOverrides ?? { ...DEFAULTS.templateOverrides },
    knowledgeMaxLines: vaultLocal?.knowledgeMaxLines ?? DEFAULTS.knowledgeMaxLines,
    knowledgeMaxHeadings: vaultLocal?.knowledgeMaxHeadings ?? DEFAULTS.knowledgeMaxHeadings,
    team,
  };

  return resolved;
}

// ─── Save Helpers ────────────────────────────────────────────────────────────

export async function saveUserConfig(config: Partial<UserConfig>): Promise<void> {
  await fs.mkdir(USER_CONFIG_DIR, { recursive: true });

  const existing = (await loadUserConfig()) || {
    vaults: [],
    activeVault: "main",
    author: "",
    transport: "stdio" as const,
  };

  const merged = { ...existing, ...config };
  await fs.writeFile(USER_CONFIG_PATH, JSON.stringify(merged, null, 2) + "\n", "utf-8");
}

export async function saveVaultLocalConfig(
  vaultPath: string,
  config: VaultLocalConfig
): Promise<void> {
  const configPath = path.join(vaultPath, VAULT_LOCAL_FILENAME);
  const existing = (await loadVaultLocalConfig(vaultPath)) || {};
  const merged = { ...existing, ...config };
  await fs.writeFile(configPath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
}

/**
 * Build a ResolvedConfig-compatible object for the team vault.
 */
export function buildTeamVaultConfig(config: ResolvedConfig): ResolvedConfig {
  if (!config.team) {
    throw new Error("No team vault configured");
  }
  return {
    vaultPath: config.team.vaultPath,
    vaultName: config.team.vaultName,
    author: config.author,
    sessionFolder: DEFAULTS.sessionFolder,
    dailyNotesFolder: DEFAULTS.dailyNotesFolder,
    knowledgeFolder: config.team.knowledgeFolder,
    dailyNoteFormat: DEFAULTS.dailyNoteFormat,
    trashFolder: DEFAULTS.trashFolder,
    defaultTags: [...DEFAULTS.defaultTags],
    excludeFolders: [...DEFAULTS.excludeFolders, config.team.proposalFolder],
    linkToDailyNote: false,
    templateOverrides: { ...DEFAULTS.templateOverrides },
    knowledgeMaxLines: DEFAULTS.knowledgeMaxLines,
    knowledgeMaxHeadings: DEFAULTS.knowledgeMaxHeadings,
    team: null,
  };
}

export function getUserConfigPath(): string {
  return USER_CONFIG_PATH;
}

export function getVaultLocalConfigPath(vaultPath: string): string {
  return path.join(vaultPath, VAULT_LOCAL_FILENAME);
}
