<div align="center">

<img src="apps/desktop/src-tauri/icons/128x128@2x.png" width="96" alt="Pathloom icon">

# Pathloom

**A local whiteboard and roadmap for projects you build with AI agents.**

Draw freely, plan with stage cards and dependencies, and let your AI agent (Claude Code, Codex, Cursor, Gemini CLI or any MCP client) build and update the plan while you watch it change live.

[![CI](https://github.com/XxArDy/Pathloom/actions/workflows/ci.yml/badge.svg)](https://github.com/XxArDy/Pathloom/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/XxArDy/Pathloom?include_prereleases&label=release)](https://github.com/XxArDy/Pathloom/releases)
[![License: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)](#license)

[Download](https://github.com/XxArDy/Pathloom/releases) · [Українською](README.uk.md) · [Changelog](CHANGELOG.md) · [Docs](docs/README.md)

<img src="docs/images/en/board.png" alt="Pathloom board with phases, stage cards and dependencies" width="900">

</div>

## Why

AI agents are great at writing code but bad at keeping a shared picture of *where the project is*. Task trackers are too heavy, a TODO file is too flat. Pathloom is the middle ground:

- **A real whiteboard** — shapes, arrows, pencil, sticky notes, images, frames. Clean or hand-drawn style.
- **A real roadmap** — stage cards with task checklists, dependencies drawn as arrows, statuses computed from the graph (*ready*, *in progress*, *blocked*, *done*), phases, milestones.
- **Plain files** — the plan lives in your repo as Markdown + JSON, so it diffs, merges and reviews like code.
- **Agent-native** — a CLI and an MCP server let agents read the plan, add stages, tick tasks and leave notes. The app shows their changes instantly, highlights them, and lets you undo — or review them first.

Everything is local. No account, no cloud.

## Features

| | |
|---|---|
| **Board** | Infinite canvas, pan/zoom, rectangles, ellipses, diamonds, arrows that stick to shapes, lines, pencil, text, sticky notes, images (paste or drop), eraser, frames, groups, align & distribute, snap to grid, smart guides, minimap. |
| **Roadmap** | Stage cards with task IDs (`AUTH-03`) and subtasks, dependencies (hard or soft), cycle protection, computed statuses, phases with progress, milestones. |
| **Readable plans** | Auto-arrange keeps the board tidy after every agent change: phases become column blocks left to right, arrows cross as little as possible, cards you move by hand stay pinned. Hover a card to see only its chain. Implied arrows are hidden and arrows between phases are grouped into one with a count. Growing cards push the ones below them down. |
| **Focus mode** | `E` hides finished work and highlights what you can do right now. |
| **Views** | Board, List (all tasks with filters), Overview (progress, what's next, blockers, deadlines, latest notes). |
| **Agents** | `pathloom` CLI and `pathloom mcp` server, live reload, change highlights, one-click undo of agent changes, review mode with proposals shown as dashed cards. |
| **Comfort** | `Ctrl+K` command palette, rebindable shortcuts that work on any keyboard layout, Graphite / Light / Warm paper themes plus your own theme files, English and Ukrainian UI. |

<table>
<tr>
<td><img src="docs/images/en/focus.png" alt="Focus mode"><br><sub>Focus mode</sub></td>
<td><img src="docs/images/en/overview.png" alt="Overview"><br><sub>Overview</sub></td>
</tr>
<tr>
<td><img src="docs/images/en/proposal.png" alt="Agent proposal in review mode"><br><sub>An agent's proposal waiting for review</sub></td>
<td><img src="docs/images/en/paper.png" alt="Warm paper theme with sketch style"><br><sub>Warm paper theme, hand-drawn style</sub></td>
</tr>
<tr>
<td><img src="docs/images/en/list.png" alt="All tasks as a list"><br><sub>All tasks as a list</sub></td>
<td><img src="docs/images/en/palette.png" alt="Command palette (Ctrl+K)"><br><sub>Command palette (Ctrl+K)</sub></td>
</tr>
</table>

## Install

Download the installer for your system from [Releases](https://github.com/XxArDy/Pathloom/releases) (Windows `.exe` / `.msi`, macOS `.dmg`, Linux `.AppImage` / `.deb` / `.tar.gz`).

On Linux without installing: unpack the `.tar.gz` (the `pathloom` CLI and the `pathloom-desktop` app) and run it from that folder:

```bash
tar -xzf pathloom-v0.1.0-x86_64-unknown-linux-gnu.tar.gz && ./pathloom --help
```

The archive brings no dependencies. The `pathloom` CLI needs only glibc 2.35 or newer (built on Ubuntu 22.04). `pathloom-desktop` from the archive needs the system WebKitGTK libraries; on Debian/Ubuntu:

```bash
sudo apt install libwebkit2gtk-4.1-0 libgtk-3-0
```

For the desktop app the `.deb` or `.AppImage` is the recommended choice. Check the download with `sha256sum -c pathloom-<tag>-x86_64-unknown-linux-gnu.tar.gz.sha256`.

To update, run the new installer over the old one. On Windows prefer the `.exe`: AI agent sessions that are using Pathloom keep working during the update and pick up the new version when they restart.

> Builds are not code-signed yet, so Windows SmartScreen and macOS Gatekeeper will warn on first launch.

The `pathloom` command-line tool is installed next to the app. **Settings → AI agents** shows its path and ready-to-copy commands.

## Connect your AI agent

Pathloom works with **Claude Code, Codex, Gemini CLI, Cursor, VS Code Copilot, Claude Desktop** and any other agent that supports MCP. Several agents can share one plan.

Every agent starts the same [MCP](https://modelcontextprotocol.io) server: `pathloom mcp`, run inside your project folder.

`pathloom` is installed next to the app and is not on your `PATH`. Use the full path from **Settings → AI agents**, for example
`C:\Users\you\AppData\Local\Pathloom\pathloom.exe` on Windows. In the snippets below, replace `pathloom` with that path.

### Claude Code

Give Claude Code the Pathloom tools once:

```bash
claude mcp add pathloom -- pathloom mcp
```

Or install the plugin (MCP server + a planning skill that teaches the agent the workflow):

```
/plugin marketplace add XxArDy/Pathloom
/plugin install pathloom@pathloom
```

Then just ask, inside your project:

> Plan the MVP in Pathloom: stages for backend, frontend and release, with dependencies.

> What can I work on next?

> Mark the login tasks as done and leave a note about what changed.

### Codex, Gemini CLI, Cursor, Copilot and others

**Codex CLI**

```bash
codex mcp add pathloom -- pathloom mcp
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.pathloom]
command = "pathloom"
args = ["mcp"]
```

**Gemini CLI** (`~/.gemini/settings.json` or `.gemini/settings.json` in the project)

```json
{ "mcpServers": { "pathloom": { "command": "pathloom", "args": ["mcp"] } } }
```

**Cursor** (`.cursor/mcp.json` in the project, or `~/.cursor/mcp.json`)

```json
{ "mcpServers": { "pathloom": { "command": "pathloom", "args": ["mcp"] } } }
```

**VS Code with GitHub Copilot** (agent mode, `.vscode/mcp.json` in the project)

```json
{ "servers": { "pathloom": { "type": "stdio", "command": "pathloom", "args": ["mcp"] } } }
```

**Claude Desktop** (Settings → Developer → Edit Config): the same `mcpServers` block as for Cursor. Claude Desktop does not start
the server in your project folder, so add the project path: `"args": ["--project", "D:/code/my-app", "mcp"]`.

**Teach the agent the workflow.** Claude Code gets it from the plugin. For other agents, run this once in your project:

```bash
pathloom skill install
```

It writes `.agents/skills/pathloom/SKILL.md` (the open Agent Skills format that Codex, Gemini CLI, Cursor, Copilot and others read).
You can also point the agent at it in `AGENTS.md`: *"Plan and track work with the Pathloom MCP tools; see .agents/skills/pathloom/SKILL.md."*

Several agents can work on one plan at once: each one claims a task before starting, and the board shows who is on what.

### What the agent can do

| Tool | |
|---|---|
| `project_info`, `list_stages`, `get_stage`, `search` | Read the plan without dumping whole boards. |
| `next` | Tasks that can be done right now, by priority and due date. |
| `apply` | Create or update many stages, tasks, dependencies, frames and comments in one transactional call. |
| `set_task`, `add_comment` | Track progress and leave notes for you. |
| `claim_task`, `release_task` | Take a task so other agents don't work on the same thing (expires after 30 min unless renewed). |
| `activity` | What other agents and you did recently. |
| `heartbeat` | "Still working" during long steps; after 10 silent minutes the card shows the agent as possibly stuck. |
| `set_gate`, `report_usage` | Report a gate's check result; optionally report tokens and cost. |
| `import_tasks` | Turn a GitHub Spec Kit `tasks.md` into stages, tasks and dependencies. |
| `layout_board`, `validate` | Tidy the board, check the plan for problems. |

**Keeping the board readable.** Turn on *Auto-arrange* (bottom bar) and the board re-arranges itself whenever an agent changes the plan; the wand button arranges it once. Hover or select a card to light up what it waits for and what waits for it. In Settings you can switch off hiding implied arrows and grouping arrows between phases. Agents get rules for readable plans (phases in time order, a one-line description per stage, 3-8 tasks, only direct dependencies), and `validate` lists `hints` when a plan breaks them.

**Done means proven.** An agent closes a task with the check it ran (`set_task` with `evidence`, or `pathloom task done AUTH-02 --run "cargo test"`): the task shows as verified, and a failing check never closes it. Turn on *Agents must prove a task is done* in Settings to require it. **Gate** stages (`kind: gate`, `check: npm test`) are done only when their check passes. Stages can list hand-off files (spec, plan) as **artifacts**, and Overview shows the **spending** agents report.

**Several agents at once.** Stages can be assigned to a named agent (`who: ai:claude`, `ai:codex`) or person (`human:olia`) — each gets its own colour. An agent claims a task before working on it; the card shows who is on it, and other agents skip it. **Overview** shows who is working right now and a feed of agent activity (`.pathloom/log/agent.jsonl`).

Prefer to approve changes first? Switch **Settings → AI agents → Ask me first**. Agent changes then arrive as proposals you accept or reject.

## The files

```
my-project/
  .pathloom/project.toml          settings (e.g. agent_changes = "review")
  plan/
    stages/AUTH.md                one stage: frontmatter + task checklist + comments
    boards/roadmap.board.json     card positions, drawings, frames (one element per line)
    assets/                       pasted images
```

```markdown
---
id: AUTH
title: Authentication
kind: stage
who: ai
priority: high
depends: [CORE]
---
## Tasks
- [x] AUTH-01 Login form
- [ ] AUTH-02 Session storage
  - [ ] AUTH-02a Refresh tokens
```

Edit them by hand, with an agent, or in the app — all three stay in sync.

## CLI

```bash
pathloom init
pathloom stage add AUTH "Authentication" --after CORE
pathloom task add AUTH "Login form"
pathloom task done AUTH-01
pathloom next
pathloom apply plan.yaml --dry-run
pathloom validate --fix
```

Every command supports `--json`. See [crates/pathloom-cli/README.md](crates/pathloom-cli/README.md).

## Build from source

Requirements: Rust (stable), Node.js 20+, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```bash
npm install
npm run build:cli -w @pathloom/desktop
npm run tauri dev -w @pathloom/desktop
```

Installers: `npm run tauri build -w @pathloom/desktop`.

| Part | Path | Stack |
|---|---|---|
| Core (files, graph, statuses, apply, layout) | `crates/pathloom-core` | Rust |
| CLI + MCP server | `crates/pathloom-cli` | Rust, `rmcp` |
| Canvas editor | `packages/canvas` | TypeScript, Canvas2D |
| Desktop app | `apps/desktop` | Tauri 2, React |
| Claude Code plugin | `plugin/` | MCP + skill |

Tests: `cargo test --workspace` and `npm run test -w @pathloom/canvas`.

## Status

Early but usable (0.1). Tested on Windows. Linux and macOS builds are produced by the release workflow but have not been tried on real machines yet. See [docs/ideas.md](docs/ideas.md) for what's next.

## Support the project

Pathloom is free and open source. If it saves you time, you can support its development in crypto.

**USDT on the TRON network (TRC20)**:

```text
TReYVcTGY9PRW9XCSFj95JJwJ6BSxsP74W
```

**Monero (XMR)**:

```text
4ADwo8HNhcCVxSjMRzau7j3PnyF5TzMd2aBaLKJTNkqa9CRLGh9AjqALWepe5Twoe3EVypeP2euBtUVxoJgpsQtBNdjAwoJ
```

Send only USDT via TRC20 to the first address and only XMR to the second; other tokens or networks may be lost. The same addresses are listed on the author's GitHub profile ([@XxArDy](https://github.com/XxArDy)), so check that they match. Thank you!

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks and project rules, and [docs/architecture.md](docs/architecture.md) for how the code is organised. Security issues: [SECURITY.md](SECURITY.md).

## License

Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option. Unless you state otherwise, any contribution you submit is licensed the same way.

Third-party packages and their licenses: [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md) (also in the app: Settings → Licenses).
