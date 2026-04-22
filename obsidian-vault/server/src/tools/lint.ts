import * as path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VaultContext } from "../vault-context.js";
import type { ResolvedConfig } from "../config.js";
import { buildVaultIndex } from "../vault-index.js";
import { resolveTarget } from "../wikilinks.js";

type CheckName = "broken_links" | "ambiguous_links" | "missing_frontmatter" | "duplicate_titles";

interface LintDiagnostic {
  check: CheckName;
  path: string;
  message: string;
}

export function registerLintTools(server: McpServer, ctx: VaultContext, _config: ResolvedConfig): void {
  server.tool(
    "vault_lint",
    "Run quality checks across the vault: broken links, ambiguous links, missing frontmatter fields, duplicate titles.",
    {
      checks: z
        .array(z.enum(["broken_links", "ambiguous_links", "missing_frontmatter", "duplicate_titles"]))
        .describe("Which checks to run"),
      folder: z.string().optional().describe("Restrict to a subfolder"),
      requiredFields: z
        .array(z.string())
        .optional()
        .default(["type", "tags"])
        .describe("Frontmatter fields required for missing_frontmatter check"),
      limit: z.number().optional().default(50).describe("Max diagnostics to return"),
      vault: z
        .enum(["personal", "team"])
        .optional()
        .default("personal")
        .describe("Which vault to lint"),
    },
    async ({ checks, folder, requiredFields, limit, vault: vaultTarget }) => {
      const vault = await ctx.getVault(vaultTarget);
      const { index, skipped } = await buildVaultIndex(vault, folder);
      const diagnostics: LintDiagnostic[] = [];

      const checksSet = new Set(checks);

      // Use full vault file list for link resolution (not folder-scoped index)
      // so cross-folder links don't false-positive as missing
      const allFiles = folder
        ? (await vault.listAllMarkdownFiles()).map((f) => ({ path: f.path }))
        : [...index.keys()].map((p) => ({ path: p }));
      const fileList = allFiles;

      if (checksSet.has("broken_links") || checksSet.has("ambiguous_links")) {
        for (const [filePath, entry] of index) {
          if (diagnostics.length >= limit) break;
          const sourceDir = path.dirname(filePath);
          for (const target of entry.outgoingTargets) {
            if (diagnostics.length >= limit) break;
            const res = await resolveTarget(vault, target, sourceDir, fileList);
            if (res.status === "missing" && checksSet.has("broken_links")) {
              diagnostics.push({
                check: "broken_links",
                path: filePath,
                message: `Broken link: [[${target}]]`,
              });
            }
            if (res.status === "ambiguous" && checksSet.has("ambiguous_links")) {
              diagnostics.push({
                check: "ambiguous_links",
                path: filePath,
                message: `Ambiguous link: [[${target}]] → ${res.candidates!.join(", ")}`,
              });
            }
          }
        }
      }

      // ── missing_frontmatter ─────────────────────────────────────────────
      if (checksSet.has("missing_frontmatter")) {
        for (const [filePath, entry] of index) {
          if (diagnostics.length >= limit) break;
          if (!entry.frontmatter) {
            diagnostics.push({
              check: "missing_frontmatter",
              path: filePath,
              message: `No frontmatter`,
            });
            continue;
          }
          const missing = requiredFields.filter((f) => entry.frontmatter![f] === undefined);
          if (missing.length > 0) {
            diagnostics.push({
              check: "missing_frontmatter",
              path: filePath,
              message: `Missing fields: ${missing.join(", ")}`,
            });
          }
        }
      }

      // ── duplicate_titles ────────────────────────────────────────────────
      if (checksSet.has("duplicate_titles")) {
        const titleMap = new Map<string, string[]>();
        for (const [filePath, entry] of index) {
          const lower = entry.title.toLowerCase();
          const list = titleMap.get(lower) || [];
          list.push(filePath);
          titleMap.set(lower, list);
        }
        for (const [title, paths] of titleMap) {
          if (diagnostics.length >= limit) break;
          if (paths.length > 1) {
            diagnostics.push({
              check: "duplicate_titles",
              path: paths[0],
              message: `Duplicate title "${title}": ${paths.join(", ")}`,
            });
          }
        }
      }

      const trimmed = diagnostics.slice(0, limit);
      const summary = `${trimmed.length} diagnostic(s) found` +
        (trimmed.length < diagnostics.length ? ` (showing first ${limit} of ${diagnostics.length})` : "") +
        (skipped.length > 0 ? ` (${skipped.length} file(s) skipped due to read/parse errors)` : "");

      const lines = trimmed.map((d) => `[${d.check}] ${d.path}: ${d.message}`);

      return {
        content: [
          {
            type: "text" as const,
            text: `${summary}\n\n${lines.join("\n") || "(clean)"}`,
          },
        ],
      };
    }
  );
}
