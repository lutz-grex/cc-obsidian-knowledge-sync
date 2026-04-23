import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import type { ResolvedTeamConfig } from "./config.js";
import { validateAuthor } from "./utils.js";

const execFileAsync = promisify(execFile);

/** Extract a useful error message from execFile rejections. */
function gitError(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { stderr?: string; message?: string };
    return (e.stderr || e.message || String(err)).trim();
  }
  return String(err);
}

export interface GitResult {
  success: boolean;
  message: string;
  error?: string;
}

export interface GitStatus {
  clean: boolean;
  ahead: number;
  behind: number;
  branch: string;
  lastCommit: string;
  dirtyFiles: string[];
}

export class GitSync {
  private readonly repoPath: string;
  private readonly remote: string;
  private readonly branch: string;

  constructor(teamConfig: ResolvedTeamConfig) {
    this.repoPath = teamConfig.vaultPath;
    this.remote = teamConfig.remote;
    this.branch = teamConfig.branch;
  }

  private async git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    try {
      return await execFileAsync("git", args, { cwd: this.repoPath });
    } catch (err: unknown) {
      // Surface lock-file errors with a clear message
      const msg = gitError(err);
      if (msg.includes("index.lock") || msg.includes("Unable to create")) {
        const wrapped = new Error(`Another git operation is in progress (lock file exists): ${msg}`);
        (wrapped as unknown as Record<string, unknown>).original = err;
        throw wrapped;
      }
      throw err;
    }
  }

  /** Get repository status: clean/dirty, ahead/behind, current branch. */
  async status(): Promise<GitStatus> {
    try {
      await this.git(["fetch", this.remote]);
    } catch {
      // Offline — proceed with local state
    }

    const { stdout: branchOutput } = await this.git(["branch", "--show-current"]);
    const branch = branchOutput.trim();

    const { stdout: statusOutput } = await this.git(["status", "--porcelain"]);
    const dirtyFiles = statusOutput
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => l.trim());

    let ahead = 0;
    let behind = 0;
    try {
      const { stdout: revList } = await this.git([
        "rev-list",
        "--left-right",
        "--count",
        `${this.remote}/${this.branch}...HEAD`,
      ]);
      const parts = revList.trim().split(/\s+/);
      behind = parseInt(parts[0] || "0", 10);
      ahead = parseInt(parts[1] || "0", 10);
    } catch {
      // No upstream tracking — ignore
    }

    let lastCommit = "";
    try {
      const { stdout: logOutput } = await this.git([
        "log",
        "-1",
        "--format=%h %s (%ar)",
      ]);
      lastCommit = logOutput.trim();
    } catch {
      // Empty repo
    }

    return {
      clean: dirtyFiles.length === 0,
      ahead,
      behind,
      branch,
      lastCommit,
      dirtyFiles,
    };
  }

  /** Pull with --ff-only. Rejects if working tree is dirty or conflicts arise. */
  async pull(): Promise<GitResult> {
    // Check for dirty working tree
    const { stdout: statusOutput } = await this.git(["status", "--porcelain"]);
    if (statusOutput.trim().length > 0) {
      const files = statusOutput
        .split("\n")
        .filter((l) => l.trim())
        .slice(0, 10)
        .map((l) => `  ${l.trim()}`);
      return {
        success: false,
        message: "Working tree is dirty — commit or stash changes first",
        error: `Dirty files:\n${files.join("\n")}`,
      };
    }

    try {
      await this.git(["fetch", this.remote, this.branch]);
    } catch (err: unknown) {
      return {
        success: false,
        message: "Failed to fetch from remote",
        error: gitError(err),
      };
    }

    try {
      const { stdout } = await this.git([
        "merge",
        "--ff-only",
        `${this.remote}/${this.branch}`,
      ]);
      return {
        success: true,
        message: stdout.trim() || "Already up to date",
      };
    } catch (err: unknown) {
      const msg = gitError(err);
      if (msg.includes("Not possible to fast-forward")) {
        return {
          success: false,
          message: "Cannot fast-forward merge — manual resolution needed",
          error: `Run 'git -C ${this.repoPath} merge ${this.remote}/${this.branch}' to resolve`,
        };
      }
      return {
        success: false,
        message: "Merge failed",
        error: msg,
      };
    }
  }

  /** Stage specific paths (or all if none given), commit with message and author, then push.
   *  If the working tree is clean but there are unpushed commits, push only. */
  async commitAndPush(message: string, author: string, paths?: string[]): Promise<GitResult> {
    // Validate author
    const authorErr = validateAuthor(author);
    if (authorErr) {
      return { success: false, message: `Invalid author: ${authorErr}` };
    }

    // Check there's something to commit
    const { stdout: statusOutput } = await this.git(["status", "--porcelain"]);
    const treeClean = statusOutput.trim().length === 0;

    if (treeClean) {
      // Tree is clean — check for unpushed local commits
      let ahead = 0;
      try {
        const { stdout: revList } = await this.git([
          "rev-list", "--count", `${this.remote}/${this.branch}..HEAD`,
        ]);
        ahead = parseInt(revList.trim(), 10) || 0;
      } catch {
        // No upstream tracking
      }

      if (ahead === 0) {
        return { success: false, message: "Nothing to commit and nothing to push" };
      }
      // Fall through to push-only
    } else {
      // Stage and commit
      try {
        if (paths && paths.length > 0) {
          await this.git(["add", "--", ...paths]);
        } else {
          await this.git(["add", "-A"]);
        }
        await this.git([
          "commit",
          "-m",
          message,
          "--author",
          `${author} <${author.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}@team>`,
        ]);
      } catch (err: unknown) {
        return {
          success: false,
          message: "Commit failed",
          error: gitError(err),
        };
      }
    }

    // Attempt push, with one automatic pull-and-retry on non-fast-forward
    try {
      await this.git(["push", this.remote, this.branch]);
    } catch (err: unknown) {
      const pushErr = gitError(err);
      if (pushErr.includes("non-fast-forward") || pushErr.includes("fetch first") || pushErr.includes("rejected")) {
        // One retry: pull --ff-only, then push again
        try {
          await this.git(["fetch", this.remote, this.branch]);
          await this.git(["merge", "--ff-only", `${this.remote}/${this.branch}`]);
          await this.git(["push", this.remote, this.branch]);
        } catch (retryErr: unknown) {
          return {
            success: false,
            message: "Push failed after automatic pull retry — manual resolution may be needed",
            error: gitError(retryErr),
          };
        }
      } else {
        return {
          success: false,
          message: "Push failed — remote may have new commits. Try pulling first.",
          error: pushErr,
        };
      }
    }

    return {
      success: true,
      message: `${treeClean ? "Pushed" : "Committed and pushed"} to ${this.remote}/${this.branch}`,
    };
  }
}
