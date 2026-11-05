# Architecture

Pathloom is a local desktop app plus a CLI and an MCP server. All three work on the same plain files in the user's project,
through one Rust library.

```text
                 user's project folder
          plan/stages/*.md   plan/boards/*.board.json
          plan/agents.json   .pathloom/ (settings, claims, log)
                          ▲
                          │ read / atomic write
                 ┌────────┴─────────┐
                 │  pathloom-core   │  model, file formats, dependency graph,
                 │   (Rust crate)   │  statuses, apply, layout, claims, log, events
                 └──┬──────┬─────┬──┘
        ┌───────────┘      │     └──────────────┐
  pathloom CLI       pathloom mcp         desktop app (Tauri 2)
  (scripts, humans)  (AI agents, stdio)   src-tauri: commands + file watcher
                                          src: React UI ── @pathloom/canvas
```

## Repository layout

| Path | What it is |
|---|---|
| `crates/pathloom-core` | The library. Everything about the plan lives here. |
| `crates/pathloom-cli` | The `pathloom` binary: CLI commands (`cli.rs`, `main.rs`), MCP server (`mcp.rs`, rmcp over stdio), shared operations (`ops.rs`), agent guide (`guide.md`). |
| `apps/desktop/src-tauri` | Tauri shell: commands the UI calls (`lib.rs`), file watcher and undo of agent changes (`watch.rs`), recent projects, the `plasset://` image scheme. Bundles the CLI as a sidecar. |
| `apps/desktop/src` | React UI: workspace, sidebar, inspector, list and overview views, settings, command palette, themes, i18n (`locales/en.json`, `uk.json`). State in zustand (`store.ts`). |
| `packages/canvas` | The board: Canvas2D renderer and editor without React (shapes, cards, arrows, frames, hit testing, undo, keymap, minimap, arrow views). |
| `plugin/` | Claude Code plugin: MCP config and the agent skill (`skills/pathloom/SKILL.md`). |
| `scripts/` | `build-cli.mjs` (sidecar build), `licenses.mjs` (license check and notices). |
| `docs/` | Specification, contracts, decisions; see [README.md](README.md). |

## pathloom-core modules

| Module | Responsibility |
|---|---|
| `model.rs` | `Stage`, `Task`, `Board`, `Who`, `ProjectConfig`, `StageView`. |
| `stagefile.rs` | Parse / render `plan/stages/<KEY>.md` (YAML frontmatter + `## Tasks` + `## Comments`), keeping unknown text intact. |
| `board.rs` | Canonical `*.board.json` writer (one element per line, merge friendly). |
| `project.rs` | Open/init a project, load/save stages and boards, task and link edits. |
| `status.rs` | Computed statuses and cycle detection. |
| `apply.rs` | Transactional batch changes from a YAML/JSON spec (agents' main tool). |
| `layout.rs` | Card height estimate, incremental placement, full layout by phases, auto-layout. |
| `proposals.rs` | Review mode: agent changes stored as proposals until a human accepts them. |
| `claims.rs`, `agents.rs`, `log.rs`, `session.rs` | Multi-agent work: task claims with heartbeat, agent profiles, activity log, links to client sessions. |
| `evidence.rs`, `import.rs` | Proof that a task is done; Spec Kit import. |
| `events.rs` | Event stream for `pathloom watch --json`. |
| `validate.rs` | Integrity checks, safe fixes, readability hints. |
| `fsutil.rs`, `writes.rs` | Atomic writes, file locks, registry of own writes (so the app ignores its own echoes). |

## How a change flows

1. An agent calls an MCP tool, for example `apply`. `pathloom-cli/src/mcp.rs` forwards it to `ops.rs`, which calls
   `Project::apply` in core.
2. Core validates the whole change in memory, then writes every file atomically (or nothing on error), and appends an entry to
   `.pathloom/log/agent.jsonl`. In review mode it stores a proposal instead.
3. The desktop app's watcher (`watch.rs`) sees the files change, skips writes made by the app itself, and emits `plan-changed`.
4. The UI (`agentSync.ts`) reloads the board and stages, highlights the changed cards and offers *Undo*.

The app's own edits go the other way: the canvas emits a new board, the store saves it through `board_save` after a short debounce,
and stage edits call Tauri commands that use the same core functions.

## Contracts

The file formats, the MCP tools and the event stream are versioned as `pathloom/1` and described in:
[m1](m1-contracts.md) (core, files, canvas basics), [m2](m2-contracts.md) (roadmap UI), [m3](m3-contracts.md) (CLI, MCP, live reload),
[m6](m6-agents-contracts.md) (multi-agent), [m7](m7-clients-contracts.md) (external clients),
[m8](m8-proof-contracts.md) (evidence, gates, readable boards). The approved specification is [spec.md](spec.md).
