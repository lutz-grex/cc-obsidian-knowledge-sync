import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VaultContext } from "../vault-context.js";
import type { ResolvedConfig } from "../config.js";
import { formatDate, parseDateString } from "../utils.js";
import { parseNote } from "../frontmatter.js";
import { findSectionRange } from "../sections.js";

export function registerDailyQueryTools(server: McpServer, ctx: VaultContext, config: ResolvedConfig): void {
  server.tool(
    "query_daily_notes",
    "Query daily notes across a date range. Filter by heading, search text, and choose output format.",
    {
      startDate: z.string().describe("Start date YYYY-MM-DD (inclusive)"),
      endDate: z.string().optional().describe("End date YYYY-MM-DD (inclusive, defaults to startDate)"),
      heading: z.string().optional().describe("Only return content under this heading"),
      search: z.string().optional().describe("Filter entries containing this text (case-insensitive)"),
      format: z
        .enum(["entries", "summary", "timeline"])
        .optional()
        .default("entries")
        .describe("Output format: entries (full sections), summary (first line per day), timeline (date + heading pairs)"),
    },
    async ({ startDate, endDate, heading, search, format }) => {
      const vault = ctx.personal;
      const start = parseDateString(startDate);
      const end = endDate ? parseDateString(endDate) : start;

      if (end < start) {
        return {
          content: [{ type: "text" as const, text: "Error: endDate must be >= startDate" }],
          isError: true,
        };
      }

      const results: Array<{ date: string; path: string; content: string }> = [];
      const current = new Date(start);

      while (current <= end) {
        const formattedName = formatDate(current, config.dailyNoteFormat);
        const dailyPath = `${config.dailyNotesFolder}/${formattedName}.md`;
        const dateStr = formatDate(current, "YYYY-MM-DD");

        try {
          if (await vault.exists(dailyPath)) {
            const raw = await vault.readFile(dailyPath);
            const parsed = parseNote(raw);
            let body = parsed.body;

            if (heading) {
              const section = findSectionRange(body, heading);
              if (!section) {
                current.setDate(current.getDate() + 1);
                continue;
              }
              body = section.content;
            }

            if (search && !body.toLowerCase().includes(search.toLowerCase())) {
              current.setDate(current.getDate() + 1);
              continue;
            }

            results.push({ date: dateStr, path: dailyPath, content: body });
          }
        } catch {
          // skip unreadable
        }

        current.setDate(current.getDate() + 1);
      }

      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No daily notes found between ${startDate} and ${endDate || startDate}` }],
        };
      }

      let output: string;
      switch (format) {
        case "entries":
          output = results
            .map((r) => `## ${r.date}\n\n${r.content.trim()}`)
            .join("\n\n---\n\n");
          break;
        case "summary":
          output = results
            .map((r) => {
              const firstLine = r.content.trim().split("\n").find((l) => l.trim().length > 0) || "(empty)";
              return `${r.date}: ${firstLine.replace(/^#+\s*/, "")}`;
            })
            .join("\n");
          break;
        case "timeline":
          output = results
            .map((r) => {
              const headings = r.content.match(/^#{1,6}\s+.+$/gm) || [];
              const labels = headings.map((h) => h.replace(/^#+\s+/, "")).join(", ");
              return `${r.date} [${r.path}]${labels ? `: ${labels}` : ""}`;
            })
            .join("\n");
          break;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `${results.length} daily note(s) matched:\n\n${output}`,
          },
        ],
      };
    }
  );
}
