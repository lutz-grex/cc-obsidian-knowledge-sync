# obsidian-vault

Obsidian vault integration for Claude Code — session capture, knowledge synthesis, vault search, link management, and team knowledge sharing.

An MCP server plugin that gives Claude Code full read/write access to your Obsidian vault, with tools for note CRUD, search, frontmatter management, wikilink graph traversal, daily note automation, and a git-backed team knowledge base with promotion/proposal workflows.

## Quick Start

### 1. Build the server

```bash
git clone <this-repo>
cd claude-code-plugins/obsidian-vault/server
bun run setup              # install + build
```

### 2. Configure your vault

```bash
mkdir -p ~/.config/obsidian-claude
cp ../config.example.json ~/.config/obsidian-claude/config.json
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
cd claude-code-plugins/obsidian-vault
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
      "args": ["/absolute/path/to/claude-code-plugins/obsidian-vault/server/dist/index.js"]
    }
  }
}
```

### 4. Verify

In Claude Code, run:
```
/obsidian config
```

You should see your resolved configuration with vault path and folders.

## Prerequisites

- [Bun](https://bun.sh) >= 1.0
- [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) — for content search
- Git — for team vault features
- An Obsidian vault (any folder with `.md` files works)

## Configuration

Three-layer configuration hierarchy (highest priority first):

1. **Environment variable:** `OBSIDIAN_VAULT_PATH`
2. **User config:** `~/.config/obsidian-claude/config.json` — vault list, active vault, author
3. **Vault-local config:** `.obsidian-claude.json` in vault root — folder locations, conventions

### Minimal Config

```json
{
  "vaults": [{ "name": "main", "path": "~/Obsidian/my-vault" }],
  "activeVault": "main",
  "author": "your-name",
  "transport": "stdio"
}
```

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

Use `/obsidian config` within Claude Code to view or modify settings.

### Team Vault Setup

To enable team knowledge sharing, add `teamVault` to your config:

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

## Usage

### Personal Commands

| Command | Description |
|---------|-------------|
| `/obsidian save [title]` | Capture full session as a structured note |
| `/obsidian specialize` | Synthesize session insights into curated knowledge notes |
| `/obsidian log <message>` | Quick append to today's daily note |
| `/obsidian search <query>` | Search vault contents and filenames |
| `/obsidian context <path>` | Load a vault note into session context |
| `/obsidian config [key val]` | View or set plugin configuration |

### Team Commands

| Command | Description |
|---------|-------------|
| `/obsidian promote [path]` | Share personal knowledge with the team |
| `/obsidian team status` | Show team vault sync status |
| `/obsidian team search <q>` | Search across personal + team vaults |
| `/obsidian team proposals` | View/manage pending proposals |
| `/obsidian team sync` | Pull latest from team remote |
| `/obsidian team push` | Commit and push local team changes |

**Recommended workflow:** `/obsidian save` → `/obsidian specialize` → `/obsidian promote`

## MCP Tools

The server registers 18 tools:

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
obsidian-vault/
├── .claude-plugin/
│   ├── plugin.json          # Plugin metadata
│   └── marketplace.json     # Marketplace config
├── .mcp.json                # MCP server registration
├── config.example.json      # Example user config
├── server/
│   └── src/
│       ├── index.ts         # Entry point — multi-vault bootstrap
│       ├── server.ts        # MCP server setup & tool registration
│       ├── config.ts        # Three-layer config + team vault validation
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
cd obsidian-vault/server
bun run dev    # Watch mode (tsc --watch)
bun run build  # Production build
bun start      # Run server directly
```

## License

MIT
