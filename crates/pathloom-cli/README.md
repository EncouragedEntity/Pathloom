# pathloom-cli

The `pathloom` binary: command line for humans and scripts, plus an MCP server (`pathloom mcp`) for AI agents.
Built on `pathloom-core`; the plan stays in plain files (`plan/stages/*.md`, `plan/boards/*.board.json`).

## Install

```
cargo install --path crates/pathloom-cli      # puts `pathloom` on your PATH
```

Project root: `--project <path>`, otherwise the nearest parent folder that has `.pathloom/`.
Global flags: `--json` (stable machine output; errors as `{code,message,details}` JSON on stderr, exit code 1),
`--author <name>` (comments, default `agent`).

## Commands

```
pathloom init [--plan-dir plan] [--name N]
pathloom board create <name> | list
pathloom stage add <KEY> "<title>" [--after KEY] [--who ai] [--board roadmap] | show <KEY> | list [--status ready] [--who] [--board] [--query]
pathloom task add <KEY> "<title>" | done <TASK-ID> | undo <TASK-ID>
pathloom link <FROM> <TO> [--soft]  |  unlink <FROM> <TO>
pathloom comment <KEY> "<text>"
pathloom next [--limit 10]
pathloom apply <spec.yaml|-> [--dry-run] [--direct]
pathloom layout <board> [--only-new KEY...]
pathloom validate [--fix]                 # exit 1 while problems remain
pathloom schema stage|board|spec          # JSON Schema
pathloom proposals list | accept <id> | reject <id>
pathloom mcp [--read-only]
```

`validate --fix` does safe fixes only: drops `depends` on missing stages and cards of missing stages.

### Review mode

With `agent_changes = "review"` in `.pathloom/project.toml`, commands that change the plan structure
(`apply`, `stage add`, `task add`, `link`, `unlink`) store a proposal in `.pathloom/proposals/` instead of writing;
a human accepts it (`pathloom proposals accept <id>` or in the app). `--direct` bypasses review.
`task done/undo` and `comment` always write directly.

## MCP server

```
claude mcp add pathloom -- pathloom mcp
claude mcp add pathloom -- pathloom --project /path/to/project mcp --read-only
```

Tools: `project_info`, `list_stages`, `get_stage` (returns a `hash`), `next`, `search`, `apply`, `set_task`,
`add_comment`, `layout_board`, `validate`. Resources: `pathloom://guide/workflow`, `pathloom://schema/{stage,board,spec}`.
Errors are `{code, message, details}` with codes `NOT_FOUND`, `CYCLE`, `DUPLICATE_KEY`, `CONFLICT`, `INVALID_SPEC`,
`READ_ONLY`, `OUT_OF_PROJECT`. With `--read-only`, tools that write return `READ_ONLY` (`apply` with `dry_run` still works).
Comments are authored `agent:<MCP client name>` unless `--author` is given. rmcp is pinned to `=3.8.0`.

## Spec format (`apply`)

YAML or JSON (JSON when the first character is `{`). All or nothing: any error writes nothing.
Re-applying the same spec is a no-op (tasks matched by title, links/cards/frames by identity).

```yaml
board: roadmap                      # created if missing
stages:
  - id: AUTH                        # existing or new key; omitted -> generated from title (or matched by same title)
    title: Authentication           # required for a new stage
    kind: stage                     # stage | milestone
    who: ai                         # me | ai | both
    priority: high                  # low | med | high
    due: 2026-12-01                 # "" clears
    branch: feat/auth               # "" clears
    depends: [M0, {id: M2, soft: true}]   # replaces the whole list when present
    tasks: [Login, Sign up]         # appended; same-title tasks are skipped
    tasks_done: [AUTH-01]
    tasks_undone: []
    place: {after: M0}              # or {x: 100, y: 200}; omitted -> auto-layout of the new card
links: [{from: AUTH, to: RELEASE, soft: false}]
unlinks: [{from: X, to: Y}]
frames: [{name: "Phase 2", members: [AUTH, M1]}]   # frame with 40px padding around the member cards
comments: [{stage: AUTH, text: "Started with OAuth"}]
expected: {AUTH: "<hash from get_stage / stage show>"}   # mismatch -> CONFLICT, nothing written
```

## Tests

`cargo test -p pathloom-cli` runs the built binary against temp projects (CLI flow, review mode, errors) and an MCP
session over stdio (initialize, tools/list, tools/call, resources).
