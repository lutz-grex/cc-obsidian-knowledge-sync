/**
 * Zod schemas for all domain objects parsed from external sources.
 * Single source of truth for runtime validation + type inference.
 */

import { z } from "zod";

// ─── Frontmatter Schemas ─────────────────────────────────────────────────────

/** Base frontmatter — any note can have these fields. */
export const BaseFrontmatterSchema = z.object({
  type: z.string().optional(),
  tags: z.array(z.string()).optional(),
  date: z.string().optional(),
  created: z.string().optional(),
  lastUpdated: z.string().optional(),
}).passthrough();

/** Knowledge note frontmatter (personal vault). */
export const KnowledgeFrontmatterSchema = BaseFrontmatterSchema.extend({
  type: z.literal("knowledge").optional(),
  topic: z.string().optional(),
  title: z.string().optional(),
  sessionCount: z.number().optional(),
  lastSession: z.string().optional(),
});

/** Team knowledge note frontmatter. */
export const TeamKnowledgeFrontmatterSchema = BaseFrontmatterSchema.extend({
  type: z.literal("team-knowledge"),
  topic_id: z.string(),
  title: z.string().optional(),
  author: z.string(),
  contributors: z.array(z.string()).default([]),
  owners: z.array(z.string()).default([]),
  lastUpdated: z.string().optional(),
  lastContributor: z.string().optional(),
  sessionCount: z.number().default(0),
});

/** Team proposal frontmatter. */
export const TeamProposalFrontmatterSchema = BaseFrontmatterSchema.extend({
  type: z.literal("team-proposal"),
  topic_id: z.string(),
  target_note: z.string(),
  author: z.string(),
  status: z.enum(["pending", "approved", "rejected"]),
  summary: z.string().optional(),
  approved_by: z.string().optional(),
  approved_on: z.string().optional(),
  rejected_by: z.string().optional(),
  rejected_on: z.string().optional(),
  message: z.string().optional(),
});

/** Session note frontmatter. */
export const SessionFrontmatterSchema = BaseFrontmatterSchema.extend({
  type: z.literal("session-note").optional(),
  date: z.string(),
  time: z.string().optional(),
  project: z.string().optional(),
});

/** Daily note frontmatter. */
export const DailyFrontmatterSchema = BaseFrontmatterSchema.extend({
  type: z.literal("daily-note").optional(),
  date: z.string(),
});

// ─── Inferred Types ──────────────────────────────────────────────────────────

export type TeamKnowledgeFrontmatter = z.infer<typeof TeamKnowledgeFrontmatterSchema>;
export type TeamProposalFrontmatter = z.infer<typeof TeamProposalFrontmatterSchema>;
export type KnowledgeFrontmatter = z.infer<typeof KnowledgeFrontmatterSchema>;
export type SessionFrontmatter = z.infer<typeof SessionFrontmatterSchema>;
export type DailyFrontmatter = z.infer<typeof DailyFrontmatterSchema>;

// ─── Ripgrep Output Schema ───────────────────────────────────────────────────

export const RipgrepMatchSchema = z.object({
  type: z.literal("match"),
  data: z.object({
    path: z.object({ text: z.string() }),
    lines: z.object({ text: z.string() }),
    line_number: z.number(),
  }),
});

export type RipgrepMatch = z.infer<typeof RipgrepMatchSchema>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Safely parse team knowledge frontmatter. Returns null if not a valid team note. */
export function parseTeamKnowledgeFm(fm: Record<string, unknown> | null): TeamKnowledgeFrontmatter | null {
  if (!fm) return null;
  const result = TeamKnowledgeFrontmatterSchema.safeParse(fm);
  return result.success ? result.data : null;
}

/** Safely parse team proposal frontmatter. Returns null if not a valid proposal. */
export function parseTeamProposalFm(fm: Record<string, unknown> | null): TeamProposalFrontmatter | null {
  if (!fm) return null;
  const result = TeamProposalFrontmatterSchema.safeParse(fm);
  return result.success ? result.data : null;
}

/** Extract string array from frontmatter field, defaulting to empty. */
export function fmStringArray(fm: Record<string, unknown> | null, field: string): string[] {
  if (!fm || !fm[field]) return [];
  const val = fm[field];
  if (Array.isArray(val)) return val.filter((v): v is string => typeof v === "string");
  return [];
}

/** Extract string from frontmatter field. */
export function fmString(fm: Record<string, unknown> | null, field: string): string {
  if (!fm || !fm[field]) return "";
  const val = fm[field];
  return typeof val === "string" ? val : "";
}

/** Extract number from frontmatter field. */
export function fmNumber(fm: Record<string, unknown> | null, field: string): number {
  if (!fm || !fm[field]) return 0;
  const val = fm[field];
  return typeof val === "number" ? val : 0;
}
