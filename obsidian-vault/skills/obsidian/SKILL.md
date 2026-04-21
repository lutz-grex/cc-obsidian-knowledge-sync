---
name: obsidian
description: Obsidian vault integration — save session knowledge, synthesize into curated notes, search vault, capture quick logs, team knowledge sharing. Use when user wants to persist session learnings, search their knowledge base, manage vault notes, or share knowledge with team.
argument-hint: <specialize|save|log|search|context|config|promote|team> [args...]
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
  - Bash(git log:*)
  - Bash(git diff:*)
  - Bash(git status:*)
---

# Obsidian Vault Integration

The user invoked: `/obsidian $ARGUMENTS`

Parse the first word of `$ARGUMENTS` as the subcommand. Route to the matching section below.

---

## Subcommand: specialize

**Two-phase knowledge synthesis. DO NOT WRITE during Phase 1.**

### Phase 1: Propose (READ-ONLY)

#### Step 1: Extract Topic Candidates

Analyze the FULL conversation history above this skill invocation. Extract 1-3 topic candidates. For each candidate identify:

- **Topic name**: concise label (e.g., "Docker bridge networking", "TypeScript discriminated unions")
- **Key insights**: non-obvious discoveries, patterns, gotchas
- **Relevant snippets**: commands, code patterns, configurations worth preserving
- **Mental model shifts**: understanding that changed during the session

Skip topics that are trivial or purely mechanical (e.g., "fixed a typo").

#### Step 2: Search Vault for Existing Notes

For each candidate:

1. `search(query=<topic keywords>, mode="content", folder=<knowledgeFolder from config>)`
2. `search(query=<topic name>, mode="filename")`

Score existing notes:
- **Exact title match** → strong candidate for update
- **Tag overlap** → moderate candidate
- **Content mention only** → weak candidate, may be tangential

#### Step 3: Generate Proposals

For each candidate topic, propose ONE action:

- **UPDATE existing**: Specify target note path + heading (new or existing). Use `preview_edit` to show what would change.
- **CREATE new**: Show proposed path in Knowledge folder + outline of sections.
- **SKIP**: If the topic has insufficient substance for durable knowledge.

**Maximum 2 notes per specialize run.**

#### Step 4: Present to User

Output a structured proposal:

```
Knowledge Capture Proposal
===========================

1. [Topic A] → UPDATE [[Knowledge/Existing Note.md]]
   Section: "## New Heading" (new section)
   Content preview:
   > [3-5 line preview of synthesized content]

2. [Topic B] → CREATE [[Knowledge/New Topic.md]]
   Structure:
   > # New Topic
   > ## Overview (insights from this session)
   > ## Patterns (code patterns discovered)

Approve? Reply: yes / change [number] to [new path] / skip [number]
```

**STOP. Wait for user response before proceeding to Phase 2.**

### Phase 2: Execute (after user approval)

For each approved proposal:

**If UPDATING an existing note:**
1. Read the current note with `read_note(path, parseFrontmatter=true)`
2. SYNTHESIZE — do not just append. Integrate new knowledge into the existing section structure. Deduplicate. Rewrite for clarity.
3. Use `edit_note` to apply changes (prefer `append` under a heading for new sections, `replace` for updating existing content)
4. Use `manage_frontmatter` to update: `lastUpdated` → today, increment `sessionCount`
5. Check note size: if body exceeds config `knowledgeMaxLines` or has more than `knowledgeMaxHeadings` headings, propose splitting into child notes

**If CREATING a new note:**
1. Use `create_note` with this frontmatter structure:
   ```yaml
   type: knowledge
   topic: <topic name>
   tags: [<relevant-tags>]
   created: <today YYYY-MM-DD>
   lastUpdated: <today YYYY-MM-DD>
   sessionCount: 1
   lastSession: "[[Claude Sessions/<today-slug>.md]]"
   ```
2. Write synthesized content (not raw session dump). Structure with clear headings.
3. Add a "## Recent Contributions" section with one entry for this session.

**After all writes:**
- If config `linkToDailyNote` is true, use `daily_capture` to add a line: `- HH:MM [[Knowledge/Note.md]] — <one-line summary of what was added>`
- Report what was created/updated with paths.

#### Quality Rules
- SYNTHESIZE over append: rewrite sections to integrate knowledge coherently
- Size threshold: propose splitting if note exceeds `knowledgeMaxLines`
- Recent Contributions section: capped to 10 entries
- Max 2 knowledge notes updated per run

### Phase 3: Team Promotion Suggestion (optional)

After Phase 2 completes, if a team vault is configured (`vault_info action=config` shows `team` section):

- Evaluate whether any of the just-created/updated knowledge notes are suitable for the team vault
- Criteria: broad applicability (not project-specific), high quality (not raw notes), stable topic
- If suitable, suggest: "This looks like it could benefit the team. Run `/obsidian promote <path>` to share it."
- **Never auto-promote.** Always suggest and wait for user action.

---

## Subcommand: save

**Raw session capture — snapshot, not curated knowledge.**

Recommended: run `save` first for the record, then `specialize` for synthesis.

### Step 1: Gather Session Context

Analyze the FULL conversation history. Extract:

1. **Summary**: 1-3 sentences
2. **Decisions Made**: with rationale
3. **Files Changed**: verify with `git status` and `git diff --stat` if in a git repo
4. **Problems & Solutions**: each problem encountered and its fix
5. **Key Learnings**: non-obvious discoveries
6. **Action Items**: anything deferred or flagged
7. **Tags**: 3-7 relevant tags (lowercase kebab-case)

### Step 2: Determine Note Path

- Folder: configured `sessionFolder` (get from `vault_info action=config`)
- Filename: `YYYY-MM-DD-<slug>.md` where slug is 3-5 word kebab-case summary
- If user provided a title after "save", use that as the slug

### Step 3: Create the Note

Use `create_note` with:

```yaml
---
date: <YYYY-MM-DD>
time: <HH:MM>
type: session-note
project: <project name from cwd>
tags:
  - <tag1>
  - <tag2>
---
```

Body template:
```markdown
# <Descriptive Title>

## Summary
<1-3 sentences>

## Decisions
- **<Decision>**: <Rationale>

## Files Changed
- `path/to/file.ts` — <what changed>

## Problems & Solutions

### <Problem Title>
**Problem**: <description>
**Solution**: <what fixed it>
**Key Insight**: <non-obvious thing>

## Learnings
- <Learning 1>

## Action Items
- [ ] <TODO 1>
```

### Step 4: Cross-link

If config `linkToDailyNote` is true:
- `daily_capture(content="- HH:MM [[<session note path>]] — <summary>", heading="Claude Sessions")`

### Step 5: Report

Tell the user the file path and a brief summary of what was captured.

---

## Subcommand: log

Triggered by: `/obsidian log <message>`

1. Use `daily_capture(content="- HH:MM — <message>", heading="Log")`
2. Confirm to user.

---

## Subcommand: search

Triggered by: `/obsidian search <query>`

1. Use `search(query=<query>, mode="content")` for full-text results
2. Also run `search(query=<query>, mode="filename")` for path matches
3. Present combined results:
   - Path (as wikilink reference)
   - Snippet or match context
   - Last modified date
4. If team vault is configured, also run `team_search(query=<query>, vaults="team")` and display results in a separate "**Team Knowledge Base:**" section
5. If no results, suggest broader terms or alternative spelling.
6. Offer: "Load any of these as context? Reply with the number."

---

## Subcommand: context

Triggered by: `/obsidian context <path>`

1. Use `resolve_note(<path>)` if the path is ambiguous (no .md extension, partial)
2. Use `read_note(path, parseFrontmatter=true)` to load the note
3. Present:
   - Frontmatter summary (type, tags, last updated)
   - Full note content
4. Check for outgoing links with `get_links(path, direction="outgoing")`
5. If relevant linked notes exist, offer: "Related notes found: [[X]], [[Y]]. Load any?"

---

## Subcommand: config

Triggered by: `/obsidian config [key] [value]`

**No args — show config:**
- Use `vault_info(action="config")` and display the resolved config

**With key and value — set config:**

Supported keys:
- `vault <path>` — set vault path (saves to user config)
- `author <name>` — set author name
- `session-folder <name>` — set session notes folder
- `daily-folder <name>` — set daily notes folder
- `knowledge-folder <name>` — set knowledge folder
- `tags <tag1,tag2>` — set default tags
- `team-vault <path>` — set team vault path (must be a git repo)
- `team-remote <name>` — set git remote for team vault (default: origin)
- `team-branch <name>` — set git branch for team vault (default: main)
- `team-require-approval <true|false>` — require proposals for non-owner updates

For vault path changes, write to user config at `~/.config/obsidian-claude/config.json`.
For folder/convention changes, write to vault-local config at `.obsidian-claude.json` in the vault root.

Report the updated configuration.

---

## Subcommand: promote

Triggered by: `/obsidian promote [path]`

**Two-phase promotion to team knowledge base.**

### Phase 1: Propose (READ-ONLY)

1. If `path` is provided, read that note from the personal vault.
   If not provided, analyze the conversation for promotable knowledge (same extraction as `specialize` Phase 1).

2. Search the team vault for existing topics:
   - `search(query=<topic keywords>, mode="content", vault="team")`
   - `search(query=<topic name>, mode="filename", vault="team")`

3. Present a structured proposal:

```
Team Promotion Proposal
========================

Source: [[Knowledge/Docker Bridge.md]]
Topic ID: docker-bridge-networking
Target: Knowledge/docker-bridge-networking.md (team vault)
Action: CREATE (new topic) / UPDATE (existing) / PROPOSAL (non-owner)

Content preview:
> [3-5 line preview of what will be promoted]

Approve? Reply: yes / change topic-id / cancel
```

**STOP. Wait for user response before Phase 2.**

### Phase 2: Execute (after approval)

1. Call `team_promote` with approved parameters:
   - `sourcePath`: the personal vault note path
   - `topicId`: the resolved topic identifier
   - `mode`: auto (detects create vs update vs proposal)
   - `summary`: one-line description

2. Report the result:
   - If created: show new team note path
   - If updated: show what was appended
   - If proposal created (non-owner): explain that a topic owner must approve

---

## Subcommand: team

Triggered by: `/obsidian team <action> [args...]`

Route `action` to the matching sub-action:

### `/obsidian team status`

1. Call `team_sync(action="status")`
2. Display: branch, clean/dirty, ahead/behind, last commit

### `/obsidian team search <query>`

1. Call `team_search(query=<query>, vaults="both")`
2. Display results grouped by vault with [personal]/[team] labels
3. Offer: "Load any of these as context? Reply with the number."

### `/obsidian team proposals`

1. Call `team_proposals(action="list")`
2. Display pending proposals with topic, author, summary
3. Offer: "Approve or reject? Reply with: approve <path> / reject <path> [reason]"

### `/obsidian team sync`

1. Call `team_sync(action="pull")`
2. Report result (pulled N commits / already up to date / error)

### `/obsidian team push`

1. Call `team_sync(action="push", message=<auto-generated or user-provided>)`
2. Report result

---

## Subcommand: lint

Triggered by: `/obsidian lint [checks...] [--folder <path>]`

1. Parse `checks` from arguments. If none specified, default to all: `broken_links`, `ambiguous_links`, `missing_frontmatter`, `duplicate_titles`.
2. Call `vault_lint(checks=<checks>, folder=<folder if provided>)`
3. Display diagnostics grouped by check type.
4. If broken or ambiguous links found, suggest: "Fix broken links? I can help update or remove them."

---

## Subcommand: daily

Triggered by: `/obsidian daily [startDate] [endDate] [--heading <h>] [--search <q>] [--format entries|summary|timeline]`

1. Parse dates from arguments. If only one date, query that single day. If no dates, default to today.
2. Call `query_daily_notes(startDate=<start>, endDate=<end>, heading=<heading>, search=<search>, format=<format>)`
3. Display the results. For `entries` format, render the full content. For `summary`, show a compact list. For `timeline`, show date + heading pairs.

---

## Subcommand: graph

Triggered by: `/obsidian graph <path> [--depth N] [--direction outgoing|backlinks|both]`

1. Resolve the note path using `resolve_note` if ambiguous.
2. Call `get_graph(path=<resolved path>, depth=<depth or 2>, direction=<direction or both>)`
3. Display the graph as a tree-like structure showing nodes and their connections.
4. Highlight broken or ambiguous edges.
5. Offer: "Explore any of these connected notes? Reply with the path."

---

## Subcommand: changelog

Triggered by: `/obsidian changelog [--days N] [--author <name>] [--path <filter>]`

1. Call `recent_changes(days=<days or 7>, author=<author>, path=<filter>)`
2. Display commits with dates, authors, and affected files.
3. If error indicates vault is not git-tracked, inform the user.

---

## No Subcommand / Help

If `$ARGUMENTS` is empty or unrecognized:

```
Obsidian Vault Commands
========================

Personal:
/obsidian specialize        Analyze session → synthesize knowledge into vault
/obsidian save [title]      Capture full session as structured note
/obsidian log <message>     Quick append to today's daily note
/obsidian search <query>    Search vault contents and filenames
/obsidian context <path>    Load a vault note into session context
/obsidian config [key val]  View or set plugin configuration

Analysis:
/obsidian lint [checks]     Run quality checks (broken links, missing frontmatter, etc.)
/obsidian daily [dates]     Query daily notes across a date range
/obsidian graph <path>      Explore the link graph around a note
/obsidian changelog         Show recent git-tracked changes in the vault

Team Knowledge Base:
/obsidian promote [path]    Share personal knowledge with the team
/obsidian team status       Show team vault sync status
/obsidian team search <q>   Search across personal + team vaults
/obsidian team proposals    View/manage pending team proposals
/obsidian team sync         Pull latest from team remote
/obsidian team push         Commit and push local team changes

Workflow: /obsidian save → /obsidian specialize → /obsidian promote
```
