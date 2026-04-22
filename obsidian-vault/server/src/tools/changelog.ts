import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VaultContext } from "../vault-context.js";
import type { ResolvedConfig } from "../config.js";

const execFileAsync = promisify(execFile);

interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
  files: string[];
}

/**
 * Run git log and return structured commits. Standalone function, not tied to GitSync.
 */
async function gitLog(
  cwd: string,
  options: { days?: number; author?: string; pathFilter?: string; limit?: number }
): Promise<GitCommit[]> {
  const { days = 7, author, pathFilter, limit = 30 } = options;

  const args = [
    "log",
    `--format=%H%x00%h%x00%an%x00%aI%x00%s`,
    "--name-only",
    `--since=${days} days ago`,
    `-n`, String(limit * 2), // fetch extra since name-only groups multiple lines per commit
  ];

  if (author) {
    args.push(`--author=${author}`);
  }

  // Scope to pathFilter or vault root (prevents leaking commits from parent repos)
  args.push("--", pathFilter || ".");


  const { stdout } = await execFileAsync("git", args, { cwd, timeout: 15000 });

  const commits: GitCommit[] = [];
  const blocks = stdout.trim().split("\n\n");

  for (const block of blocks) {
    if (!block.trim()) continue;
    const lines = block.split("\n");
    const headerLine = lines[0];
    const parts = headerLine.split("\0");
    if (parts.length < 5) continue;

    const files = lines.slice(1).filter((l) => l.trim().length > 0);

    commits.push({
      hash: parts[0],
      shortHash: parts[1],
      author: parts[2],
      date: parts[3],
      subject: parts[4],
      files,
    });

    if (commits.length >= limit) break;
  }

  return commits;
}

export function registerChangelogTools(server: McpServer, ctx: VaultContext, _config: ResolvedConfig): void {
  server.tool(
    "recent_changes",
    "Show recent git commits that modified the vault. Requires the vault to be git-tracked.",
    {
      days: z.number().optional().default(7).describe("Look back this many days"),
      author: z.string().optional().describe("Filter by commit author name"),
      path: z.string().optional().describe("Filter to commits affecting this path"),
      limit: z.number().optional().default(30).describe("Max commits to return"),
      vault: z
        .enum(["personal", "team"])
        .optional()
        .default("personal")
        .describe("Which vault to check"),
    },
    async ({ days, author, path: pathFilter, limit, vault: vaultTarget }) => {
      const vault = await ctx.getVault(vaultTarget);

      // Verify the vault is a git repo
      try {
        await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
          cwd: vault.root,
          timeout: 5000,
        });
      } catch {
        return {
          content: [{ type: "text" as const, text: "Error: Vault is not git-tracked" }],
          isError: true,
        };
      }

      try {
        const commits = await gitLog(vault.root, { days, author, pathFilter, limit });

        if (commits.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No commits found in the last ${days} day(s)${author ? ` by ${author}` : ""}${pathFilter ? ` affecting ${pathFilter}` : ""}`,
              },
            ],
          };
        }

        const MAX_FILES_PER_COMMIT = 8;
        const lines = commits.map((c) => {
          let filesStr = "";
          if (c.files.length > 0) {
            const shown = c.files.slice(0, MAX_FILES_PER_COMMIT);
            const overflow = c.files.length - shown.length;
            filesStr = `\n  files: ${shown.join(", ")}`;
            if (overflow > 0) filesStr += ` +${overflow} more`;
          }
          return `${c.shortHash} ${c.date.slice(0, 10)} ${c.author}: ${c.subject}${filesStr}`;
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `${commits.length} commit(s) in the last ${days} day(s):\n\n${lines.join("\n")}`,
            },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error reading git log: ${msg}` }],
          isError: true,
        };
      }
    }
  );
}
