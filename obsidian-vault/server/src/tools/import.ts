import * as fs from "node:fs/promises";
import * as path from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VaultContext } from "../vault-context.js";
import type { ResolvedConfig } from "../config.js";
import { parseNote, serializeNote } from "../frontmatter.js";
import { localDate, localTime, slugify } from "../utils.js";

// ─── Types ──────────────────────────────────────────────────────────────────

interface SessionInfo {
  sessionId: string;
  cwd: string;
  project: string;
  gitBranch: string;
  timestamp: string;
  messageCount: number;
  name?: string;
  jsonlPath: string;
}

export interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
  tools?: string[];
  timestamp?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function projectFromCwd(cwd: string): string {
  return path.basename(cwd);
}

// slugify imported from utils.ts — session paths use maxLen=50

function summarizeToolInput(name: string, input: Record<string, unknown>): string {
  const MAX = 80;
  let summary: string;
  switch (name) {
    case "Bash":
      summary = String(input.command || "");
      break;
    case "Read":
      summary = String(input.file_path || "");
      break;
    case "Write":
    case "Edit":
      summary = String(input.file_path || "");
      break;
    case "Grep":
      summary = String(input.pattern || "");
      break;
    case "Glob":
      summary = String(input.pattern || "");
      break;
    case "Agent":
      summary = String(input.description || input.prompt || "").slice(0, MAX);
      break;
    default:
      summary = JSON.stringify(input).slice(0, MAX);
  }
  return summary.length > MAX ? summary.slice(0, MAX) + "..." : summary;
}

/** Load session name index from ~/.claude/sessions/*.json */
async function loadSessionNames(claudeDir: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const sessionsDir = path.join(claudeDir, "sessions");
  if (!existsSync(sessionsDir)) return names;

  try {
    const files = await fs.readdir(sessionsDir);
    const jsonFiles = files.filter((f) => f.endsWith(".json")).slice(0, 200);
    const BATCH = 30;
    for (let i = 0; i < jsonFiles.length; i += BATCH) {
      const batch = jsonFiles.slice(i, i + BATCH);
      const results = await Promise.all(
        batch.map(async (f) => {
          try {
            const raw = await fs.readFile(path.join(sessionsDir, f), "utf-8");
            const data = JSON.parse(raw);
            if (data.sessionId && data.name) return { id: data.sessionId, name: data.name };
          } catch { /* skip */ }
          return null;
        })
      );
      for (const r of results) {
        if (r) names.set(r.id, r.name);
      }
    }
  } catch { /* skip */ }
  return names;
}

/** Discover sessions across all project dirs under ~/.claude/projects/ */
async function discoverSessions(
  claudeDir: string,
  projectFilter?: string,
  limit: number = 30
): Promise<SessionInfo[]> {
  const projectsDir = path.join(claudeDir, "projects");
  if (!existsSync(projectsDir)) return [];

  const projectDirs = await fs.readdir(projectsDir);
  const sessions: SessionInfo[] = [];
  const names = await loadSessionNames(claudeDir);

  for (const dir of projectDirs) {
    const dirPath = path.join(projectsDir, dir);
    let entries;
    try {
      entries = await fs.readdir(dirPath);
    } catch { continue; }

    const jsonlFiles = entries.filter((f) => f.endsWith(".jsonl"));
    for (const file of jsonlFiles) {
      const jsonlPath = path.join(dirPath, file);
      const sessionId = file.replace(".jsonl", "");

      try {
        const content = await fs.readFile(jsonlPath, "utf-8");
        const lines = content.split("\n").filter(Boolean);

        // Find first user message for metadata
        let cwd = "";
        let gitBranch = "";
        let timestamp = "";
        let msgCount = 0;

        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.type === "user" || obj.type === "assistant") msgCount++;
            if (!cwd && obj.type === "user" && obj.cwd) {
              cwd = obj.cwd;
              gitBranch = obj.gitBranch || "";
              timestamp = obj.timestamp || "";
            }
          } catch { /* skip malformed */ }
        }

        if (!cwd || msgCount < 2) continue;

        const project = projectFromCwd(cwd);
        if (projectFilter && !cwd.toLowerCase().includes(projectFilter.toLowerCase())) continue;

        sessions.push({
          sessionId,
          cwd,
          project,
          gitBranch,
          timestamp,
          messageCount: msgCount,
          name: names.get(sessionId),
          jsonlPath,
        });
      } catch { continue; }
    }
  }

  sessions.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
  return sessions.slice(0, limit);
}

/** Parse a full session JSONL into conversation turns */
async function parseSession(jsonlPath: string): Promise<{ meta: SessionInfo; turns: ConversationTurn[] }> {
  const content = await fs.readFile(jsonlPath, "utf-8");
  const lines = content.split("\n").filter(Boolean);

  const turns: ConversationTurn[] = [];
  let cwd = "";
  let gitBranch = "";
  let timestamp = "";
  let sessionId = "";
  let msgCount = 0;

  const MAX_TURNS = 500;

  for (const line of lines) {
    if (turns.length >= MAX_TURNS) break;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    if (obj.type === "user") {
      msgCount++;
      if (!cwd && obj.cwd) {
        cwd = obj.cwd;
        gitBranch = obj.gitBranch || "";
        timestamp = obj.timestamp || "";
        sessionId = obj.sessionId || "";
      }
      const msg = obj.message;
      if (!msg) continue;
      // Only include human text messages, skip tool_result arrays
      if (typeof msg.content === "string" && msg.content.trim()) {
        turns.push({ role: "user", text: msg.content.trim(), timestamp: obj.timestamp });
      }
    } else if (obj.type === "assistant") {
      msgCount++;
      const msg = obj.message;
      if (!msg || !Array.isArray(msg.content)) continue;

      const textParts: string[] = [];
      const tools: string[] = [];

      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          textParts.push(block.text);
        } else if (block.type === "tool_use" && block.name) {
          const summary = summarizeToolInput(block.name, block.input || {});
          tools.push(`${block.name}(\`${summary}\`)`);
        }
        // skip thinking blocks
      }

      if (textParts.length > 0 || tools.length > 0) {
        turns.push({
          role: "assistant",
          text: textParts.join("\n\n"),
          tools: tools.length > 0 ? tools : undefined,
          timestamp: obj.timestamp,
        });
      }
    }
  }

  return {
    meta: {
      sessionId,
      cwd,
      project: projectFromCwd(cwd),
      gitBranch,
      timestamp,
      messageCount: msgCount,
      jsonlPath,
    },
    turns,
  };
}

// ─── Filtering / trimming helpers ──────────────────────────────────────────

const COMMAND_RE = /^<command-|^<local-command/;
const SKIP_USER_RE = /^\/(?:clear|resume|help|exit)\b/;

/** True when a user turn is a slash-command, XML command tag, or empty. */
export function isNoiseUser(text: string): boolean {
  const t = text.trim();
  return !t || COMMAND_RE.test(t) || SKIP_USER_RE.test(t);
}

/** True when an assistant turn is tool-only with no substantive text. */
export function isToolOnlyAssistant(turn: ConversationTurn): boolean {
  return (!turn.text || turn.text.trim().length < 40) && (turn.tools?.length ?? 0) > 0;
}

/** Trim a long assistant response to ≤ maxChars, breaking at the last paragraph boundary. */
export function trimText(text: string, maxChars: number = 2000): string {
  if (text.length <= maxChars) return text;
  const cut = text.lastIndexOf("\n\n", maxChars);
  return (cut > maxChars * 0.3 ? text.slice(0, cut) : text.slice(0, maxChars)) + "\n\n*(trimmed)*";
}

/** Transform parsed session into markdown */
function transformToMarkdown(meta: SessionInfo, turns: ConversationTurn[]): { frontmatter: Record<string, unknown>; body: string } {
  const startDate = meta.timestamp ? new Date(meta.timestamp) : new Date();
  const lastTurn = [...turns].reverse().find((t) => t.timestamp);
  const endDate = lastTurn?.timestamp ? new Date(lastTurn.timestamp) : startDate;

  const durationMin = Math.round((endDate.getTime() - startDate.getTime()) / 60000);

  const frontmatter: Record<string, unknown> = {
    type: "session-note",
    date: localDate(startDate),
    time: localTime(startDate),
    project: meta.project,
    sessionId: meta.sessionId,
    gitBranch: meta.gitBranch || undefined,
    tags: ["session", "import", slugify(meta.project, 50)],
  };

  // --- Filter turns: drop noise, tool-only, and commands ---
  const filtered = turns.filter((turn) => {
    if (turn.role === "user") return !isNoiseUser(turn.text);
    return !isToolOnlyAssistant(turn);
  });

  const lines: string[] = [];
  lines.push(`# Session: ${localDate(startDate)} — ${meta.project}`);
  lines.push("");
  lines.push(`**Branch**: \`${meta.gitBranch || "n/a"}\` | **Duration**: ${durationMin}m | **Messages**: ${meta.messageCount}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  const MAX_BODY_LINES = 300;

  for (const turn of filtered) {
    if (lines.length >= MAX_BODY_LINES) {
      lines.push("*(session truncated — run `/obsidian specialize` to extract key topics)*");
      break;
    }

    if (turn.role === "user") {
      lines.push("### User");
      lines.push("");
      lines.push(trimText(turn.text, 500));
      lines.push("");
    } else {
      // Only emit substantive assistant text — drop tool references
      if (turn.text && turn.text.trim()) {
        lines.push("### Assistant");
        lines.push("");
        lines.push(trimText(turn.text));
        lines.push("");
      }
    }
  }

  return { frontmatter, body: lines.join("\n") };
}

// ─── Tool Registration ──────────────────────────────────────────────────────

export function registerImportTools(server: McpServer, ctx: VaultContext, config: ResolvedConfig): void {
  server.tool(
    "import_session",
    "Import Claude Code session transcripts into the vault. List available sessions, import by ID, or import the latest.",
    {
      action: z.enum(["list", "import", "import_latest"]).describe("list: show sessions, import: by session ID, import_latest: most recent"),
      sessionId: z.string().optional().describe("Session UUID (required for 'import')"),
      project: z.string().optional().describe("Filter by project name or path substring"),
      limit: z.number().optional().default(20).describe("Max sessions to list"),
      overwrite: z.boolean().optional().default(false).describe("Replace an existing import of the same session (matched by sessionId in frontmatter)"),
    },
    async ({ action, sessionId, project, limit, overwrite }) => {
      const claudeDir = path.join(homedir(), ".claude");

      if (action === "list") {
        const sessions = await discoverSessions(claudeDir, project, limit);
        if (sessions.length === 0) {
          return { content: [{ type: "text" as const, text: "No sessions found" + (project ? ` matching "${project}"` : "") }] };
        }
        const lines = sessions.map((s) => {
          const date = s.timestamp ? s.timestamp.slice(0, 10) : "unknown";
          const name = s.name ? ` (${s.name})` : "";
          return `${s.sessionId} | ${date} | ${s.project} | ${s.gitBranch || "-"} | ${s.messageCount} msgs${name}`;
        });
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      }

      // For import and import_latest, resolve the session
      let targetPath: string;

      if (action === "import_latest") {
        const sessions = await discoverSessions(claudeDir, project, 1);
        if (sessions.length === 0) {
          return { content: [{ type: "text" as const, text: "No sessions found" + (project ? ` matching "${project}"` : "") }], isError: true };
        }
        targetPath = sessions[0].jsonlPath;
      } else {
        if (!sessionId) {
          return { content: [{ type: "text" as const, text: "Error: 'import' requires sessionId" }], isError: true };
        }
        // Find the JSONL file
        const projectsDir = path.join(claudeDir, "projects");
        const projectDirs = await fs.readdir(projectsDir);
        let found = "";
        for (const dir of projectDirs) {
          const candidate = path.join(projectsDir, dir, `${sessionId}.jsonl`);
          if (existsSync(candidate)) { found = candidate; break; }
        }
        if (!found) {
          return { content: [{ type: "text" as const, text: `Error: Session not found: ${sessionId}` }], isError: true };
        }
        targetPath = found;
      }

      const { meta, turns } = await parseSession(targetPath);
      if (turns.length === 0) {
        return { content: [{ type: "text" as const, text: "Error: Session has no conversation content" }], isError: true };
      }

      const { frontmatter, body } = transformToMarkdown(meta, turns);
      const date = localDate(meta.timestamp ? new Date(meta.timestamp) : new Date());
      const slug = slugify(meta.name || meta.project, 50);
      let notePath = `${config.sessionFolder}/${date}-${slug}.md`;

      // Handle overwrite: find existing note by sessionId in frontmatter
      const vault = ctx.personal;
      if (overwrite) {
        const sessionFiles = await vault.listMarkdownFiles(config.sessionFolder, false, 200);
        const BATCH = 20;
        let existingPath: string | null = null;
        for (let i = 0; i < sessionFiles.length && !existingPath; i += BATCH) {
          const batch = sessionFiles.slice(i, i + BATCH);
          const results = await Promise.all(batch.map(async (f) => {
            try {
              const raw = await vault.readFile(f.path);
              const { frontmatter: fm } = parseNote(raw);
              if (fm && fm.sessionId === meta.sessionId) return f.path;
            } catch { /* skip */ }
            return null;
          }));
          existingPath = results.find((r) => r !== null) ?? null;
        }
        if (existingPath) {
          await vault.deleteFile(existingPath, false);
        }
        // Old note removed, but canonical path might be occupied by a different note — fall through to collision cascade
      }
      if (await vault.exists(notePath)) {
        // Resolve name collisions by appending session name or counter
        if (meta.name) {
          const altPath = `${config.sessionFolder}/${date}-${slug}-${slugify(meta.name, 50)}.md`;
          if (await vault.exists(altPath)) {
            const shortId = meta.sessionId.slice(0, 8);
            notePath = `${config.sessionFolder}/${date}-${slug}-${shortId}.md`;
          } else {
            notePath = altPath;
          }
        } else {
          const shortId = meta.sessionId.slice(0, 8);
          notePath = `${config.sessionFolder}/${date}-${slug}-${shortId}.md`;
        }
        if (await vault.exists(notePath)) {
          return { content: [{ type: "text" as const, text: `Error: Note already exists: ${notePath}. Use overwrite=true to replace.` }], isError: true };
        }
      }

      const fullContent = serializeNote(frontmatter, body);
      await vault.writeFile(notePath, fullContent);

      return {
        content: [{
          type: "text" as const,
          text: `Imported: ${notePath} (${turns.length} turns, ${meta.messageCount} messages)\nRun /obsidian specialize to extract knowledge topics.`,
        }],
      };
    }
  );
}
