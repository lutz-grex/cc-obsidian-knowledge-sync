---
name: obsidian
description: Obsidian vault integration — save session knowledge, synthesize into curated notes, search vault, capture quick logs, team knowledge sharing. Use when user wants to persist session learnings, search their knowledge base, manage vault notes, or share knowledge with team.
argument-hint: <setup|import|specialize|save|log|search|context|config|promote|team> [args...]
allowed-tools:
  - mcp__obsidian-vault__read_note
  - mcp__obsidian-vault__create_note
  - mcp__obsidian-vault__edit_note
  - mcp__obsidian-vault__delete_note
  - mcp__obsidian-vault__move_note
  - mcp__obsidian-vault__search
  - mcp__obsidian-vault__vault_info
  - mcp__obsidian-vault__manage_frontmatter
  - mcp__obsidian-vault__vault_tags
  - mcp__obsidian-vault__get_links
  - mcp__obsidian-vault__resolve_note
  - mcp__obsidian-vault__daily_capture
  - mcp__obsidian-vault__apply_template
  - mcp__obsidian-vault__preview_edit
  - mcp__obsidian-vault__team_sync
  - mcp__obsidian-vault__team_search
  - mcp__obsidian-vault__team_promote
  - mcp__obsidian-vault__team_proposals
  - mcp__obsidian-vault__vault_lint
  - mcp__obsidian-vault__query_daily_notes
  - mcp__obsidian-vault__get_graph
  - mcp__obsidian-vault__recent_changes
  - mcp__obsidian-vault__import_session
  - Bash(git log:*)
  - Bash(git diff:*)
  - Bash(git status:*)
  - Bash(bun --version:*)
  - Bash(which rg:*)
  - Bash(which git:*)
  - Bash(mkdir:*)
  - Bash(cp:*)
  - Bash(claude plugin add:*)
  - Read
  - Write
  - Edit
---

# Obsidian Vault Integration

The user invoked: `/obsidian $ARGUMENTS`

Parse the first word of `$ARGUMENTS` as the subcommand. Route to the matching section below.

---

## setup

Interactive onboarding. Walk the user through each step, checking and fixing as you go.

**Step 1 — Prerequisites.** Check in parallel: `bun --version`, `which rg`, `which git`. Report status for each. If any missing, tell the user how to install (bun: `curl -fsSL https://bun.sh/install | bash`, rg: `brew install ripgrep`, git: `brew install git`). Wait for user to confirm before continuing.

**Step 2 — Build.** Locate the plugin server directory (this plugin's `server/` folder). Run `bun run setup` (install + build). Report success/failure.

**Step 3 — Vault config.** Ask the user for their Obsidian vault path. Check if `~/.config/obsidian-claude/config.json` exists. If not, create it:
```json
{"vaults":[{"name":"main","path":"<user-provided-path>"}],"activeVault":"main","author":"<git user.name or ask>","transport":"stdio"}
```
If it exists, show current config and ask if they want to update it.

**Step 4 — Install plugin.** Run `claude plugin add <plugin-root-dir>`. Report result. Then verify with `vault_info(action="config")`.

**Step 5 — Team vault (optional).** Ask: "Do you have a shared team knowledge repo? (y/n)". If yes, ask for path, verify it's a git repo with a remote, then add `teamVault` section to the config file.

**Step 6 — Autonomous lookup (recommended).** Read `~/.claude/CLAUDE.md`. If it doesn't already contain a "Knowledge Lookup" section, ask: "Want Claude to automatically search your vault during planning? (y/n)". If yes, append:
```
# Knowledge Lookup
Before planning or investigating unfamiliar areas, search both Obsidian vaults in parallel (personal + team, single message, two tool calls). Read relevant hits. Cite them. Skip for trivial tasks.
```

**Step 7 — Done.** Summarize what was configured. Suggest: "Try `/obsidian save` after your next session, then `/obsidian specialize` to build your knowledge base."

---

## import

Import Claude Code session transcripts into the vault as structured notes.

- `/obsidian import` → `import_session(action="list")`. Show sessions table. Ask which to import.
- `/obsidian import <sessionId>` → `import_session(action="import", sessionId="<id>")`. Report path. Offer `/obsidian specialize`.
- `/obsidian import latest [project]` → `import_session(action="import_latest", project="<project>")`.
- `/obsidian import <non-uuid>` → treat as project filter: `import_session(action="list", project="<filter>")`.

---

## specialize

Two-phase knowledge synthesis. Phase 1 is READ-ONLY — propose only.

**Phase 1 — Propose:** Extract 1-3 topic candidates from conversation history (skip trivial topics). For each, search vault (`search` content + filename in knowledgeFolder), then propose ONE action: UPDATE existing note (show target path + heading + preview via `preview_edit`), CREATE new note (show proposed path + section outline), or SKIP. Max 2 notes per run. Present structured proposal and STOP — wait for user approval.

**Phase 2 — Execute (after approval):** For UPDATEs: read note, SYNTHESIZE (don't just append), use `edit_note`, update frontmatter (`lastUpdated`, increment `sessionCount`). If note exceeds `knowledgeMaxLines`/`knowledgeMaxHeadings`, propose splitting. For CREATEs: use `create_note` with frontmatter `{type: knowledge, topic, tags, created, lastUpdated, sessionCount: 1, lastSession}`. Write synthesized content with clear headings + "## Recent Contributions" (capped at 10 entries). After writes: if `linkToDailyNote`, use `daily_capture`. Report paths.

**Phase 3 — Team suggestion (optional):** If team vault configured, evaluate if notes are team-suitable (broad applicability, high quality, stable). Suggest `/obsidian promote <path>` — never auto-promote.

---

## save

Raw session snapshot. Analyze conversation: extract summary, decisions, files changed (verify via git), problems/solutions, learnings, action items, tags. Create note in `sessionFolder` as `YYYY-MM-DD-<slug>.md` with frontmatter `{date, time, type: session-note, project, tags}` and structured body (Summary, Decisions, Files Changed, Problems & Solutions, Learnings, Action Items). Cross-link via `daily_capture` if `linkToDailyNote`. Report path.

---

## log

`/obsidian log <message>` → `daily_capture(content="- HH:MM — <message>", heading="Log")`. Confirm.

---

## search

`/obsidian search <query>` → run `search(mode="content")` + `search(mode="filename")`. Present combined results (path, snippet, modified date). If team vault configured, also `team_search(vaults="team")` in separate section. Offer to load results as context.

---

## context

`/obsidian context <path>` → `resolve_note` if ambiguous, then `read_note(parseFrontmatter=true)`. Show frontmatter summary + content. Check `get_links(direction="outgoing")` and offer related notes.

---

## config

`/obsidian config` (no args) → `vault_info(action="config")`, display resolved config. Configuration changes should be made by editing `~/.config/obsidian-claude/config.json` (user-level) or `.obsidian-claude.json` in the vault root (vault-level) directly.

---

## promote

Two-phase team promotion. **Phase 1:** Read source note (or extract from conversation), search team vault for existing topics, present structured proposal (source, topic ID, target path, action: CREATE/UPDATE/PROPOSAL). STOP — wait for approval. **Phase 2:** Call `team_promote` with approved params. Report result.

---

## team

Route `/obsidian team <action>`:
- **status** → `team_sync(action="status")` — show branch, clean/dirty, ahead/behind
- **search `<query>`** → `team_search(query, vaults="both")` — grouped by vault
- **proposals** → `team_proposals(action="list")` — show pending, offer approve/reject
- **sync** → `team_sync(action="pull")` — report result
- **push** → `team_sync(action="push")` — report result

---

## lint

`/obsidian lint [checks...] [--folder <path>]` → default all checks: `broken_links`, `ambiguous_links`, `missing_frontmatter`, `duplicate_titles`. Call `vault_lint`, display grouped diagnostics. Offer to fix broken links.

---

## daily

`/obsidian daily [startDate] [endDate] [--heading <h>] [--search <q>] [--format entries|summary|timeline]` → call `query_daily_notes`. Default: today. Display per format.

---

## graph

`/obsidian graph <path> [--depth N] [--direction outgoing|backlinks|both]` → resolve path, call `get_graph(depth default 2)`. Display tree-like structure, highlight broken/ambiguous edges. Offer exploration.

---

## changelog

`/obsidian changelog [--days N] [--author <name>] [--path <filter>]` → `recent_changes(days default 7)`. Display commits.

---

## No Subcommand / Help

```
Obsidian: setup | import | specialize | save | log | search | context | config
         lint | daily | graph | changelog
         promote | team [status|search|proposals|sync|push]
Start:    /obsidian setup
Workflow: import → specialize → promote (or: save → specialize → promote)
```
