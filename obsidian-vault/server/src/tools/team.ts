import { z } from "zod";
import * as path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VaultContext } from "../vault-context.js";
import type { ResolvedConfig } from "../config.js";
import { GitSync } from "../git-sync.js";
import { searchContent, searchFilename, searchFrontmatter, type SearchResult } from "../search.js";
import { parseNote, serializeNote } from "../frontmatter.js";
import {
  parseTeamProposalFm,
  fmString,
  fmStringArray,
  fmNumber,
} from "../schemas.js";
import { localDate, localTime } from "../utils.js";

export function registerTeamTools(server: McpServer, ctx: VaultContext, config: ResolvedConfig): void {
  if (!config.team) return;

  const gitSync = new GitSync(config.team);

  // --- team_sync ---
  server.tool(
    "team_sync",
    "Sync the team vault with remote: pull latest, push local commits, or check status.",
    {
      action: z
        .enum(["pull", "push", "status"])
        .describe("'status' shows sync state, 'pull' fetches and fast-forward merges, 'push' commits and pushes local changes"),
      message: z
        .string()
        .optional()
        .describe("Commit message (required for 'push')"),
    },
    async ({ action, message }) => {
      switch (action) {
        case "status": {
          const status = await gitSync.status();
          const lines = [
            `Branch: ${status.branch}`,
            `Clean: ${status.clean}`,
            `Ahead: ${status.ahead} commit(s)`,
            `Behind: ${status.behind} commit(s)`,
            `Last commit: ${status.lastCommit || "(none)"}`,
          ];
          if (status.dirtyFiles.length > 0) {
            lines.push(`\nDirty files (${status.dirtyFiles.length}):`);
            lines.push(...status.dirtyFiles.slice(0, 20).map((f) => `  ${f}`));
            if (status.dirtyFiles.length > 20) {
              lines.push(`  ... and ${status.dirtyFiles.length - 20} more`);
            }
          }
          return {
            content: [{ type: "text" as const, text: lines.join("\n") }],
          };
        }

        case "pull": {
          const result = await gitSync.pull();
          const text = result.success
            ? `Pulled: ${result.message}`
            : `Pull failed: ${result.message}${result.error ? `\n${result.error}` : ""}`;
          return {
            content: [{ type: "text" as const, text }],
            isError: !result.success,
          };
        }

        case "push": {
          if (!message) {
            return {
              content: [{ type: "text" as const, text: "Error: 'push' requires a commit message" }],
              isError: true,
            };
          }
          const result = await gitSync.commitAndPush(message, config.author || "unknown");
          const text = result.success
            ? `Pushed: ${result.message}`
            : `Push failed: ${result.message}${result.error ? `\n${result.error}` : ""}`;
          return {
            content: [{ type: "text" as const, text }],
            isError: !result.success,
          };
        }
      }
    }
  );

  // --- team_search ---
  server.tool(
    "team_search",
    "Search across personal and team vaults. Results are labeled by source vault.",
    {
      query: z.string().describe("Search query"),
      mode: z
        .enum(["content", "filename"])
        .optional()
        .default("content")
        .describe("Search mode"),
      limit: z
        .number()
        .optional()
        .default(20)
        .describe("Max results per vault"),
      vaults: z
        .enum(["both", "personal", "team"])
        .optional()
        .default("both")
        .describe("Which vaults to search"),
    },
    async ({ query, mode, limit, vaults: scope }) => {
      const searchFn = mode === "filename" ? searchFilename : searchContent;
      const results: Array<SearchResult & { source: string }> = [];

      const searches: Array<Promise<SearchResult[]>> = [];
      const labels: string[] = [];

      if (scope === "both" || scope === "personal") {
        searches.push(searchFn(ctx.personal, query, { limit }));
        labels.push("personal");
      }
      if ((scope === "both" || scope === "team") && ctx.team) {
        searches.push(searchFn(ctx.team, query, { limit }));
        labels.push("team");
      }

      const allResults = await Promise.all(searches);

      for (let i = 0; i < allResults.length; i++) {
        for (const r of allResults[i]) {
          results.push({ ...r, source: labels[i] });
        }
      }

      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No results found for "${query}" in ${scope} vault(s)` }],
        };
      }

      // Group by source
      const personal = results.filter((r) => r.source === "personal");
      const team = results.filter((r) => r.source === "team");

      const sections: string[] = [];
      if (personal.length > 0) {
        sections.push(
          `[personal] ${personal.length} result(s):\n` +
            personal.map((r) => `  ${r.path}${r.snippet ? ` — ${r.snippet}` : ""}`).join("\n")
        );
      }
      if (team.length > 0) {
        sections.push(
          `[team] ${team.length} result(s):\n` +
            team.map((r) => `  ${r.path}${r.snippet ? ` — ${r.snippet}` : ""}`).join("\n")
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Cross-vault search for "${query}":\n\n${sections.join("\n\n")}`,
          },
        ],
      };
    }
  );

  // --- team_promote ---
  server.tool(
    "team_promote",
    "Promote a personal note to the team knowledge base. Creates or updates a canonical team note with proper attribution.",
    {
      sourcePath: z.string().describe("Path of the note in the personal vault to promote"),
      topicId: z
        .string()
        .optional()
        .describe("Canonical topic identifier (auto-generated from title if omitted)"),
      targetPath: z
        .string()
        .optional()
        .describe("Override target path in team vault (defaults to Knowledge/<topic_id>.md)"),
      mode: z
        .enum(["create", "update", "auto"])
        .optional()
        .default("auto")
        .describe("'create' for new topic, 'update' to merge into existing, 'auto' to detect"),
      summary: z
        .string()
        .optional()
        .describe("One-line summary of what this contributes"),
    },
    async ({ sourcePath, topicId, targetPath, mode, summary }) => {
      const teamVault = ctx.getVault("team");
      const teamConfig = config.team!;
      const author = config.author || "unknown";

      // Read source note from personal vault
      let sourceContent: string;
      try {
        sourceContent = await ctx.personal.readFile(sourcePath);
      } catch {
        return {
          content: [{ type: "text" as const, text: `Error: Source not found in personal vault: ${sourcePath}` }],
          isError: true,
        };
      }

      const sourceParsed = parseNote(sourceContent);
      const sourceTitle =
        fmString(sourceParsed.frontmatter, "topic") ||
        fmString(sourceParsed.frontmatter, "title") ||
        path.basename(sourcePath, ".md");

      // Generate topic_id
      const resolvedTopicId = topicId || slugify(sourceTitle);
      let resolvedTargetPath =
        targetPath || `${teamConfig.knowledgeFolder}/${resolvedTopicId}.md`;

      // Check for existing topic in team vault
      let existingNote: string | null = null;
      let existingFm: Record<string, unknown> | null = null;

      try {
        existingNote = await teamVault.readFile(resolvedTargetPath);
        const parsed = parseNote(existingNote);
        existingFm = parsed.frontmatter;
      } catch {
        // File doesn't exist — that's fine for create
      }

      // Also search by topic_id if not found at target path
      if (!existingNote) {
        const fmResults = await searchFrontmatter(
          teamVault,
          "topic_id",
          resolvedTopicId,
          "equals",
          { folder: teamConfig.knowledgeFolder, limit: 1 }
        );
        if (fmResults.length > 0) {
          // Use the actual path where the topic lives, not the computed one
          resolvedTargetPath = fmResults[0].path;
          existingNote = await teamVault.readFile(resolvedTargetPath);
          const parsed = parseNote(existingNote);
          existingFm = parsed.frontmatter;
        }
      }

      const topicExists = existingNote !== null;

      // Determine effective mode
      const effectiveMode = mode === "auto" ? (topicExists ? "update" : "create") : mode;

      if (effectiveMode === "create" && topicExists) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: Topic "${resolvedTopicId}" already exists at ${resolvedTargetPath}. Use mode="update" or mode="auto".`,
            },
          ],
          isError: true,
        };
      }

      if (effectiveMode === "update" && !topicExists) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: Topic "${resolvedTopicId}" not found in team vault. Use mode="create" or mode="auto".`,
            },
          ],
          isError: true,
        };
      }

      // Pull before writing to minimize conflicts
      const pullResult = await gitSync.pull();
      if (!pullResult.success) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: Cannot sync team vault before writing.\n${pullResult.message}${pullResult.error ? `\n${pullResult.error}` : ""}`,
            },
          ],
          isError: true,
        };
      }

      const today = localDate();

      if (effectiveMode === "create") {
        // Create new team knowledge note
        const teamFrontmatter: Record<string, unknown> = {
          type: "team-knowledge",
          topic_id: resolvedTopicId,
          title: sourceTitle,
          author,
          contributors: [author],
          owners: [author],
          tags: fmStringArray(sourceParsed.frontmatter, "tags"),
          created: today,
          lastUpdated: today,
          lastContributor: author,
          sessionCount: 1,
        };

        const body = sourceParsed.body || sourceContent;
        const fullContent = serializeNote(teamFrontmatter, body);
        await teamVault.writeFile(resolvedTargetPath, fullContent);
      } else {
        // Update existing — check ownership
        const owners = fmStringArray(existingFm, "owners");
        const isOwner = owners.includes(author);

        if (!isOwner && teamConfig.requireApproval) {
          // Create proposal instead of direct update
          const time = localTime().replace(":", "");
          const proposalDir = `${teamConfig.proposalFolder}/${resolvedTopicId}`;
          const proposalPath = `${proposalDir}/${today}T${time}-${slugify(author)}.md`;

          const proposalFm: Record<string, unknown> = {
            type: "team-proposal",
            topic_id: resolvedTopicId,
            target_note: resolvedTargetPath,
            author,
            status: "pending",
            summary: summary || `Contribution from ${author}`,
          };

          const proposalBody =
            `# Proposal: ${sourceTitle}\n\n` +
            `## Proposed Content\n\n` +
            (sourceParsed.body || sourceContent) +
            `\n\n## Context\n\n` +
            `Source: personal vault \`${sourcePath}\`\n` +
            `Date: ${today}\n`;

          await teamVault.writeFile(proposalPath, serializeNote(proposalFm, proposalBody));

          // Commit and push
          const commitMsg = `[obsidian-claude] proposal: ${resolvedTopicId} by ${author}`;
          const pushResult = await gitSync.commitAndPush(commitMsg, author, [proposalPath]);

          return {
            content: [
              {
                type: "text" as const,
                text: `Created proposal (you are not an owner of this topic):\n  ${proposalPath}\n\nA topic owner must approve this proposal.${!pushResult.success ? `\n\nWarning: ${pushResult.message}` : ""}`,
              },
            ],
          };
        }

        // Direct update — append with provenance
        const existingParsed = parseNote(existingNote!);
        const contributors = fmStringArray(existingFm, "contributors");
        if (!contributors.includes(author)) {
          contributors.push(author);
        }

        const updatedFm: Record<string, unknown> = {
          ...existingFm,
          lastUpdated: today,
          lastContributor: author,
          contributors,
          sessionCount: fmNumber(existingFm, "sessionCount") + 1,
        };

        const contribution =
          `\n\n<!-- contributed by ${author} on ${today} -->\n` +
          (sourceParsed.body || sourceContent);

        const updatedBody = existingParsed.body.trimEnd() + contribution + "\n";
        await teamVault.writeFile(resolvedTargetPath, serializeNote(updatedFm, updatedBody));
      }

      // Commit and push
      const action = effectiveMode === "create" ? "promote" : "update";
      const commitMsg = `[obsidian-claude] ${action}: ${sourceTitle}\n\nAuthor: ${author}\nSource: personal vault ${sourcePath}`;
      const pushResult = await gitSync.commitAndPush(commitMsg, author, [resolvedTargetPath]);

      if (!pushResult.success) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Note written to team vault but push failed:\n${pushResult.message}${pushResult.error ? `\n${pushResult.error}` : ""}\n\nUse team_sync push to retry.`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Promoted to team vault:\n  ${resolvedTargetPath}\n  topic_id: ${resolvedTopicId}\n  action: ${effectiveMode}\n  ${pushResult.message}`,
          },
        ],
      };
    }
  );

  // --- team_proposals ---
  server.tool(
    "team_proposals",
    "List, view, approve, or reject pending proposals for the team knowledge base.",
    {
      action: z
        .enum(["list", "view", "approve", "reject"])
        .describe("What to do with proposals"),
      proposalPath: z
        .string()
        .optional()
        .describe("Path to a specific proposal file (required for view/approve/reject)"),
      message: z
        .string()
        .optional()
        .describe("Optional message for approve/reject"),
    },
    async ({ action, proposalPath, message: actionMessage }) => {
      const teamVault = ctx.getVault("team");
      const teamConfig = config.team!;
      const author = config.author || "unknown";

      switch (action) {
        case "list": {
          const proposalFolder = teamConfig.proposalFolder;
          let files;
          try {
            files = await teamVault.listMarkdownFiles(proposalFolder, true, 100);
          } catch {
            return {
              content: [{ type: "text" as const, text: "No proposals found (folder does not exist)" }],
            };
          }

          // Filter to pending proposals
          const pending: Array<{ path: string; topicId: string; author: string; summary: string }> = [];
          for (const file of files) {
            try {
              const content = await teamVault.readFile(file.path);
              const parsed = parseNote(content);
              const proposal = parseTeamProposalFm(parsed.frontmatter);
              if (proposal && proposal.status === "pending") {
                pending.push({
                  path: file.path,
                  topicId: proposal.topic_id,
                  author: proposal.author,
                  summary: proposal.summary || "",
                });
              }
            } catch {
              // Skip unreadable
            }
          }

          if (pending.length === 0) {
            return {
              content: [{ type: "text" as const, text: "No pending proposals" }],
            };
          }

          const lines = pending.map(
            (p) => `- ${p.path}\n  topic: ${p.topicId} | author: ${p.author}\n  ${p.summary}`
          );
          return {
            content: [
              {
                type: "text" as const,
                text: `${pending.length} pending proposal(s):\n\n${lines.join("\n\n")}`,
              },
            ],
          };
        }

        case "view": {
          if (!proposalPath) {
            return {
              content: [{ type: "text" as const, text: "Error: 'view' requires proposalPath" }],
              isError: true,
            };
          }
          const content = await teamVault.readFile(proposalPath);
          return {
            content: [{ type: "text" as const, text: content }],
          };
        }

        case "approve": {
          if (!proposalPath) {
            return {
              content: [{ type: "text" as const, text: "Error: 'approve' requires proposalPath" }],
              isError: true,
            };
          }

          // Pull first — abort if it fails
          const pullResult = await gitSync.pull();
          if (!pullResult.success) {
            return {
              content: [{ type: "text" as const, text: `Error: Cannot sync before approve.\n${pullResult.message}${pullResult.error ? `\n${pullResult.error}` : ""}` }],
              isError: true,
            };
          }

          const proposalContent = await teamVault.readFile(proposalPath);
          const proposalParsed = parseNote(proposalContent);
          const proposal = parseTeamProposalFm(proposalParsed.frontmatter);

          if (!proposal || proposal.status !== "pending") {
            return {
              content: [{ type: "text" as const, text: "Error: Proposal is not in 'pending' status or invalid format" }],
              isError: true,
            };
          }

          const targetNotePath = proposal.target_note;
          const proposalAuthor = proposal.author;
          const topicId = proposal.topic_id;
          const today = localDate();

          // Read target note
          let targetContent: string;
          try {
            targetContent = await teamVault.readFile(targetNotePath);
          } catch {
            return {
              content: [{ type: "text" as const, text: `Error: Target note not found: ${targetNotePath}` }],
              isError: true,
            };
          }

          const targetParsed = parseNote(targetContent);
          const targetFm = targetParsed.frontmatter || {};

          // Verify caller is an owner of the target topic
          const owners = fmStringArray(targetFm, "owners");
          if (owners.length > 0 && !owners.includes(author)) {
            return {
              content: [{ type: "text" as const, text: `Error: Only topic owners can approve proposals. Owners: ${owners.join(", ")}` }],
              isError: true,
            };
          }

          // Update target note — append with provenance
          const contributors = fmStringArray(targetFm, "contributors");
          if (!contributors.includes(proposalAuthor)) {
            contributors.push(proposalAuthor);
          }

          const updatedFm: Record<string, unknown> = {
            ...targetFm,
            lastUpdated: today,
            lastContributor: proposalAuthor,
            contributors,
            sessionCount: fmNumber(targetFm, "sessionCount") + 1,
          };

          // Extract proposed content (body minus the "# Proposal" header and "## Context" section)
          let proposedContent = proposalParsed.body;
          const proposedMatch = proposedContent.match(/## Proposed Content\n\n([\s\S]*?)(\n## Context|\n*$)/);
          if (proposedMatch) {
            proposedContent = proposedMatch[1].trim();
          }

          const contribution =
            `\n\n<!-- contributed by ${proposalAuthor} on ${today} -->\n` +
            proposedContent;

          const updatedBody = targetParsed.body.trimEnd() + contribution + "\n";
          await teamVault.writeFile(targetNotePath, serializeNote(updatedFm, updatedBody));

          // Mark proposal as approved
          const updatedProposalFm: Record<string, unknown> = {
            ...proposalParsed.frontmatter,
            status: "approved",
            approved_by: author,
            approved_on: today,
            message: actionMessage || undefined,
          };
          await teamVault.writeFile(
            proposalPath,
            serializeNote(updatedProposalFm, proposalParsed.body)
          );

          // Commit and push both changed files
          const commitMsg = `[obsidian-claude] approve proposal: ${topicId} by ${proposalAuthor}`;
          const pushResult = await gitSync.commitAndPush(commitMsg, author, [targetNotePath, proposalPath]);

          return {
            content: [
              {
                type: "text" as const,
                text: `Approved proposal from ${proposalAuthor}:\n  Merged into: ${targetNotePath}\n  ${pushResult.success ? pushResult.message : `(push failed: ${pushResult.message})`}`,
              },
            ],
          };
        }

        case "reject": {
          if (!proposalPath) {
            return {
              content: [{ type: "text" as const, text: "Error: 'reject' requires proposalPath" }],
              isError: true,
            };
          }

          const proposalContent = await teamVault.readFile(proposalPath);
          const proposalParsed = parseNote(proposalContent);
          const proposal = parseTeamProposalFm(proposalParsed.frontmatter);

          if (!proposal || proposal.status !== "pending") {
            return {
              content: [{ type: "text" as const, text: "Error: Proposal is not in 'pending' status or invalid format" }],
              isError: true,
            };
          }

          // Verify caller is an owner of the target topic
          try {
            const targetContent = await teamVault.readFile(proposal.target_note);
            const targetParsed = parseNote(targetContent);
            const owners = fmStringArray(targetParsed.frontmatter, "owners");
            if (owners.length > 0 && !owners.includes(author)) {
              return {
                content: [{ type: "text" as const, text: `Error: Only topic owners can reject proposals. Owners: ${owners.join(", ")}` }],
                isError: true,
              };
            }
          } catch {
            // Target note not found — allow rejection anyway
          }

          const today = localDate();
          const updatedFm: Record<string, unknown> = {
            ...proposalParsed.frontmatter,
            status: "rejected",
            rejected_by: author,
            rejected_on: today,
            message: actionMessage || undefined,
          };
          await teamVault.writeFile(
            proposalPath,
            serializeNote(updatedFm, proposalParsed.body)
          );

          const topicId = proposal.topic_id;
          const proposalAuthor = proposal.author;
          const commitMsg = `[obsidian-claude] reject proposal: ${topicId} by ${proposalAuthor}`;
          const pushResult = await gitSync.commitAndPush(commitMsg, author, [proposalPath]);

          return {
            content: [
              {
                type: "text" as const,
                text: `Rejected proposal: ${proposalPath}${actionMessage ? `\nReason: ${actionMessage}` : ""}${!pushResult.success ? `\n\nWarning: ${pushResult.message}` : ""}`,
              },
            ],
          };
        }
      }
    }
  );
}

/** Convert a string to a URL-safe kebab-case slug. */
function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
