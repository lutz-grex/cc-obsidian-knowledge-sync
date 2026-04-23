# cc-obsidian-knowledge-sync

Obsidian vault integration for Claude Code — session capture, knowledge synthesis, vault search, link management, and team knowledge sharing.

An MCP server plugin that gives Claude Code full read/write access to your Obsidian vault, with tools for note CRUD, search, frontmatter management, wikilink graph traversal, daily note automation, and a git-backed team knowledge base with promotion/proposal workflows.

## Setup

Run `/obsidian setup` in Claude Code — it walks you through everything interactively: prerequisites, vault config, plugin install, team vault, and autonomous knowledge lookup.

Or follow the manual steps below.

### Prerequisites

- [Bun](https://bun.sh) >= 1.0
- [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) — for content search
- Git — for team vault features
- An Obsidian vault (any folder with `.md` files works)

### 1. Build the server

```bash
git clone https://github.com/lutz-grex/cc-obsidian-knowledge-sync.git
cd cc-obsidian-knowledge-sync/server
bun run setup              # install + build
```

### 2. Configure your vault

```bash
mkdir -p ~/.config/obsidian-claude
cp config.example.json ~/.config/obsidian-claude/config.json
```

Edit `~/.config/obsidian-claude/config.json`:
```json
{
  "vaults": [{ "name": "main", "path": "/path/to/your/obsidian/vault" }],
  "activeVault": "main",
  "author": "your-name",
  "transport": "stdio"
}
```

### 3. Connect to Claude Code

**Option A: Install as a plugin (recommended)**

```bash
cd cc-obsidian-knowledge-sync
claude plugin add .
```

This registers the MCP server and skill automatically.

**Option B: Manual MCP server registration**

Add to your Claude Code MCP settings (`~/.claude/settings.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "obsidian-vault": {
      "command": "bun",
      "args": ["/absolute/path/to/cc-obsidian-knowledge-sync/server/dist/index.js"]
    }
  }
}
```

### 4. Verify

```
/obsidian config
```

You should see your resolved configuration with vault path and folders.

### 5. Team vault (optional)

Add `teamVault` to `~/.config/obsidian-claude/config.json`:

```json
{
  "teamVault": {
    "path": "~/Obsidian/team-knowledge",
    "name": "team",
    "remote": "origin",
    "branch": "main",
    "knowledgeFolder": "Knowledge",
    "proposalFolder": ".proposals",
    "requireApproval": true
  }
}
```

The team vault must be a git repository with a configured remote. All team members clone the same repo.

**How it works:**
- Personal vault stays private — all writes default there
- Promote knowledge to team via `/obsidian promote`
- Non-owners create proposals that topic owners approve/reject
- Sync via git (pull before write, commit+push after)

### 6. Autonomous knowledge lookup (recommended)

Add this line to your `~/.claude/CLAUDE.md` so Claude automatically searches your vault before planning or investigating unfamiliar areas:

```
# Knowledge Lookup
Before planning or investigating unfamiliar areas, search both Obsidian vaults in parallel (personal + team, single message, two tool calls). Read relevant hits. Cite them. Skip for trivial tasks.
```

With this, Claude will proactively check your personal and team knowledge base during planning, architecture decisions, and debugging — no explicit `/obsidian search` needed. Both vaults are searched in parallel so it doesn't slow you down.

## Configuration

Three-layer configuration hierarchy (highest priority first):

1. **Environment variable:** `OBSIDIAN_VAULT_PATH`
2. **User config:** `~/.config/obsidian-claude/config.json` — vault list, active vault, author
3. **Vault-local config:** `.obsidian-claude.json` in vault root — folder locations, conventions

### Defaults

| Setting | Default |
|---------|---------|
| `sessionFolder` | `Claude Sessions` |
| `dailyNotesFolder` | `Daily Notes` |
| `knowledgeFolder` | `Knowledge` |
| `dailyNoteFormat` | `YYYY-MM-DD` |
| `trashFolder` | `.trash` |
| `linkToDailyNote` | `true` |
| `knowledgeMaxLines` | `400` |
| `knowledgeMaxHeadings` | `10` |

## Usage

### Personal Commands

| Command | Description |
|---------|-------------|
| `/obsidian setup` | Interactive onboarding — checks prerequisites, configures vault, installs plugin |
| `/obsidian import [id\|latest\|project]` | Import Claude Code session transcripts into vault |
| `/obsidian save [title]` | Capture full session as a structured note |
| `/obsidian specialize` | Synthesize session insights into curated knowledge notes |
| `/obsidian log <message>` | Quick append to today's daily note |
| `/obsidian search <query>` | Search vault contents and filenames |
| `/obsidian context <path>` | Load a vault note into session context |
| `/obsidian config` | View resolved plugin configuration |

### Analysis Commands

| Command | Description |
|---------|-------------|
| `/obsidian lint [checks]` | Run quality checks (broken links, missing frontmatter, etc.) |
| `/obsidian daily [dates]` | Query daily notes across a date range |
| `/obsidian graph <path>` | Explore the link graph around a note |
| `/obsidian changelog` | Show recent git-tracked changes |

### Team Commands

| Command | Description |
|---------|-------------|
| `/obsidian promote [path]` | Share personal knowledge with the team |
| `/obsidian team status` | Show team vault sync status |
| `/obsidian team search <q>` | Search across personal + team vaults |
| `/obsidian team proposals` | View/manage pending proposals |
| `/obsidian team sync` | Pull latest from team remote |
| `/obsidian team push` | Commit and push local team changes |

**Recommended workflow:** `/obsidian import` -> `/obsidian specialize` -> `/obsidian promote` (or `/obsidian save` -> `/obsidian specialize` -> `/obsidian promote`)

## MCP Tools

The server registers 19 tools:

### File Operations

- **read_note** — Read note content with optional frontmatter parsing
- **create_note** — Create note with YAML frontmatter
- **edit_note** — Replace, append, or prepend content
- **delete_note** — Delete or soft-delete (moves to trash)
- **move_note** — Move/rename with automatic wikilink rewriting

### Metadata

- **manage_frontmatter** — Get, set, or merge frontmatter fields and tags
- **vault_tags** — List tags with counts or rename tags vault-wide

### Search

- **search** — Multi-mode search: content (via ripgrep), filename (glob), or frontmatter field filtering

### Vault Information

- **vault_info** — Vault stats, directory tree, file lists, recent files, or resolved config

### Link Management

- **get_links** — Retrieve backlinks, outgoing links, or both
- **resolve_note** — Resolve ambiguous note names to full paths

### Import

- **import_session** — List, import, or import latest Claude Code session transcripts from `~/.claude/projects/`

### Automation

- **daily_capture** — Append to daily notes under optional headings (creates note if missing)
- **apply_template** — Apply templates with variable substitution
- **preview_edit** — Preview edits before applying (diff-style output)

### Team (registered when team vault is configured)

- **team_sync** — Pull/push/status for the team vault git repo
- **team_search** — Cross-vault search with results labeled by source
- **team_promote** — Promote personal knowledge to team with conflict detection
- **team_proposals** — List/view/approve/reject pending team proposals

## Architecture

```
cc-obsidian-knowledge-sync/
├── .claude-plugin/
│   ├── plugin.json          # Plugin metadata
│   └── marketplace.json     # Marketplace config
├── .mcp.json                # MCP server registration
├── config.example.json      # Example user config
├── server/
│   └── src/
│       ├── index.ts         # Entry point — multi-vault bootstrap
│       ├── server.ts        # MCP server setup & tool registration
│       ├── config.ts        # Three-layer config + deferred team validation
│       ├── vault.ts         # Filesystem operations with path safety
│       ├── vault-context.ts # Multi-vault routing (personal + team)
│       ├── frontmatter.ts   # YAML frontmatter via `yaml` package
│       ├── search.ts        # Ripgrep + filename + metadata search
│       ├── git-sync.ts      # Git operations for team vault
│       ├── wikilinks.ts     # Link parsing & rewriting
│       └── tools/
│           ├── file-ops.ts  # CRUD operations
│           ├── metadata.ts  # Frontmatter & tags
│           ├── search.ts    # Search tool
│           ├── vault-info.ts# Vault introspection
│           ├── links.ts     # Link graph
│           ├── automation.ts# Daily capture, templates
│           └── team.ts      # Team sync, search, promote, proposals
└── skills/
    └── obsidian/
        └── SKILL.md         # Skill definition & subcommand routing
```

## Development

```bash
cd server
bun run dev       # Watch mode (tsc --watch)
bun run build     # Production build
bun run check     # Typecheck + tests
bun test          # Tests only
bun start         # Run server directly
```

## License

MIT
