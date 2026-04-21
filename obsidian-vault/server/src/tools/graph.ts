import * as path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VaultContext } from "../vault-context.js";
import type { ResolvedConfig } from "../config.js";
import { buildVaultIndex } from "../vault-index.js";
import { resolveTarget } from "../wikilinks.js";
import { parseNote } from "../frontmatter.js";

interface GraphNode {
  path: string;
  title: string;
  depth: number;
  content?: string;
}

interface GraphEdge {
  source: string;
  target: string;
  status: "resolved" | "missing" | "ambiguous";
}

const MAX_NODES = 200;

export function registerGraphTools(server: McpServer, ctx: VaultContext, _config: ResolvedConfig): void {
  server.tool(
    "get_graph",
    "Explore the local link graph around a note. Returns nodes and edges via BFS up to a given depth.",
    {
      path: z.string().describe("Starting note path"),
      depth: z.number().min(1).max(5).optional().default(2).describe("BFS depth (1-5, default 2)"),
      direction: z
        .enum(["outgoing", "backlinks", "both"])
        .optional()
        .default("both")
        .describe("Edge direction to follow"),
      includeContent: z.boolean().optional().default(false).describe("Include note body in each node"),
      vault: z
        .enum(["personal", "team"])
        .optional()
        .default("personal")
        .describe("Which vault to graph"),
    },
    async ({ path: startPath, depth, direction, includeContent, vault: vaultTarget }) => {
      const vault = ctx.getVault(vaultTarget);
      const index = await buildVaultIndex(vault);

      // Build adjacency: outgoing and incoming edges in one pass
      const outgoing = new Map<string, string[]>(); // path → resolved target paths
      const incoming = new Map<string, string[]>(); // path → source paths that link here
      const edgeStatus = new Map<string, "resolved" | "missing" | "ambiguous">(); // "source→target" → status

      const fileList = [...index.keys()].map((p) => ({ path: p }));

      for (const [filePath, entry] of index) {
        const sourceDir = path.dirname(filePath);
        const resolvedTargets: string[] = [];

        for (const target of entry.outgoingTargets) {
          const res = await resolveTarget(vault, target, sourceDir, fileList);
          const edgeKey = `${filePath}→${target}`;
          if (res.status === "resolved" && res.path) {
            resolvedTargets.push(res.path);
            edgeStatus.set(edgeKey, "resolved");
            const inc = incoming.get(res.path) || [];
            inc.push(filePath);
            incoming.set(res.path, inc);
          } else {
            edgeStatus.set(edgeKey, res.status as "missing" | "ambiguous");
          }
        }
        outgoing.set(filePath, resolvedTargets);
      }

      if (!index.has(startPath)) {
        return {
          content: [{ type: "text" as const, text: `Error: Note not found in index: ${startPath}` }],
          isError: true,
        };
      }

      // BFS
      const visited = new Set<string>();
      const nodes: GraphNode[] = [];
      const edges: GraphEdge[] = [];
      const queue: Array<{ nodePath: string; d: number }> = [{ nodePath: startPath, d: 0 }];
      visited.add(startPath);

      while (queue.length > 0 && nodes.length < MAX_NODES) {
        const { nodePath, d } = queue.shift()!;
        const entry = index.get(nodePath);
        const node: GraphNode = {
          path: nodePath,
          title: entry?.title || path.basename(nodePath, ".md"),
          depth: d,
        };
        if (includeContent && entry) {
          try {
            const raw = await vault.readFile(nodePath);
            const { body } = parseNote(raw);
            node.content = body.slice(0, 500);
          } catch {
            // skip
          }
        }
        nodes.push(node);

        if (d >= depth) continue;

        const neighbors: string[] = [];

        if (direction === "outgoing" || direction === "both") {
          const out = outgoing.get(nodePath) || [];
          for (const t of out) {
            neighbors.push(t);
            edges.push({ source: nodePath, target: t, status: "resolved" });
          }
          // Also add missing/ambiguous edges for the start entry's targets
          if (entry) {
            const sourceDir = path.dirname(nodePath);
            for (const target of entry.outgoingTargets) {
              const key = `${nodePath}→${target}`;
              const status = edgeStatus.get(key);
              if (status === "missing" || status === "ambiguous") {
                edges.push({ source: nodePath, target, status });
              }
            }
          }
        }

        if (direction === "backlinks" || direction === "both") {
          const inc = incoming.get(nodePath) || [];
          for (const s of inc) {
            neighbors.push(s);
            edges.push({ source: s, target: nodePath, status: "resolved" });
          }
        }

        for (const neighbor of neighbors) {
          if (!visited.has(neighbor) && index.has(neighbor) && nodes.length + queue.length < MAX_NODES) {
            visited.add(neighbor);
            queue.push({ nodePath: neighbor, d: d + 1 });
          }
        }
      }

      // Deduplicate edges
      const edgeSet = new Set<string>();
      const uniqueEdges = edges.filter((e) => {
        const key = `${e.source}→${e.target}|${e.status}`;
        if (edgeSet.has(key)) return false;
        edgeSet.add(key);
        return true;
      });

      const result = {
        root: startPath,
        depth,
        direction,
        nodes: nodes.length,
        edges: uniqueEdges.length,
        graph: {
          nodes: includeContent
            ? nodes
            : nodes.map(({ content: _, ...rest }) => rest),
          edges: uniqueEdges,
        },
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
