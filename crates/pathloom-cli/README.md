# pathloom-cli

The `pathloom` binary: command line for humans and scripts, plus an MCP server (`pathloom mcp`) for AI agents.
Built on `pathloom-core`; the plan stays in plain files (`plan/stages/*.md`, `plan/boards/*.board.json`).

## Install

```
cargo install --path crates/pathloom-cli      # puts `pathloom` on your PATH
```

Project root: `--project <path>`, otherwise the nearest parent folder that has `.pathloom/`.
Global flags: `--json` (stable machine output; errors as `{code,message,details}` JSON on stderr, exit code 1),
`--author <name>` (comments, claims and the activity log; default `agent`; a leading `agent:` is ignored and the name is
lowercased with anything outside `[a-z0-9._-]` turned into `-`).

## Commands

```
pathloom init [--plan-dir plan] [--name N] [--agents-skill]
pathloom info                             # protocol, version, capabilities, counts, agent profiles
pathloom board create <name> | list
pathloom stage add <KEY> "<title>" [--after KEY] [--who ai] [--board roadmap] | show <KEY> | list [--status ready] [--who] [--board] [--query]
pathloom task add <KEY> "<title>" | done <TASK-ID> | undo <TASK-ID>
pathloom task claim <TASK-ID> [--ttl 30m] [--note "..."] [--session-client C --session-id I [--session-url U] [--session-title T]] | release <TASK-ID> [--force]
pathloom claims                           # live claims
pathloom log [--limit 20] [--stage KEY]   # agent activity, newest first
pathloom link <FROM> <TO> [--soft]  |  unlink <FROM> <TO>
pathloom comment <KEY> "<text>"
pathloom next [--limit 10]               # your claimed tasks first, tasks claimed by others hidden
pathloom apply <spec.yaml|-> [--dry-run] [--direct]
pathloom layout <board> [--only-new KEY...]
pathloom validate [--fix]                 # exit 1 while problems remain
pathloom schema stage|board|spec          # JSON Schema
pathloom proposals list | accept <id> | reject <id>
pathloom agent set <id> [--name N] [--color #rrggbb] [--avatar 🤖|assets/f.png] [--kind K] | list | remove <id>
pathloom watch [--since RFC3339]         # event stream (NDJSON with --json)
pathloom skill install [--dir .agents/skills] [--force]
pathloom mcp [--read-only]
```

`validate --fix` does safe fixes only: drops `depends` on missing stages and cards of missing stages.

### Claims and activity log

`task claim` marks a task as "being worked on" by `--author` for `--ttl` (`90s`, `30m`, `2h`, bare number = minutes; default 30m, max 8h);
claiming again renews. Someone else's live claim fails with `CLAIMED` (`details: {task_id, by, expires_at}`); `task release --force`
takes it over. `task done` (and `apply` with `tasks_done`) releases the claim. State lives in `.pathloom/claims.json` (git-ignored).
`--json`: `claims` -> `{"claims":[{task_id,agent,at,expires_at,note,session}]}`, `log` -> `{"entries":[{at,author,source,action,summary,stages,tasks,files,session?}]}`.

Every command that changes something writes a line to `.pathloom/log/agent.jsonl` with `source: "cli"` and `author` = `--author`
(`apply`, `stage add`, `task add/done/undo/claim/release`, `link`, `unlink`, `comment`, `layout`, `validate --fix`, `proposals accept/reject`;
review mode logs `propose`). A log write that fails never fails the command: the result carries `log_warning` and stderr gets `warning: ...`.

### External clients (protocol `pathloom/1`)

`pathloom info --json` (and MCP `project_info`) report `protocol`, `version`, `capabilities`, `agent_changes` and the `agents` profiles. A `--read-only` server
advertises only `read, activity, events, validate`.

**Agent profiles** (`plan/agents.json`, committed): `agent set <id> --name Claude --color "#d97757" --avatar 🤖` creates or updates (unset flags keep the current value),
`agent list`, `agent remove <id>`. MCP: `register_agent {name?, color?, avatar?, kind?}` registers the caller itself (id = caller identity), `list_agents`.

**Sessions**: `task claim --session-client maestro --session-id sess_8f2 [--session-url maestro://session/sess_8f2] [--session-title "Implement auth"]` stores the
session on the claim, adds it to the stage frontmatter `sessions` and keeps it in the log entry. MCP: every mutating tool accepts `session: {client, id, url?, title?}`;
`apply` specs take `stages[].sessions_add`. Invalid sessions (bad client, `javascript:`/`data:`/`file:` urls) are `INVALID_SPEC`.

**`pathloom watch`** runs until killed and prints one event per line (flushed). It starts the watcher, prints `hello`, then (with `--since 2026-11-05T10:00:00Z`) the log entries
newer than that time as `activity` events, then live events (200 ms debounce). Without `--json` a short human line is printed instead. Example (`--json`):

```
{"type":"hello","protocol":"pathloom/1","version":"0.1.0","at":"2026-11-05T10:00:00Z"}
{"type":"stage","key":"AUTH","change":"created","at":"2026-11-05T10:00:03Z"}
{"type":"board","name":"roadmap","change":"updated","at":"2026-11-05T10:00:03Z"}
{"type":"claims","claims":[{"task_id":"AUTH-01","agent":"maestro","at":"...","expires_at":"...","note":"","session":null}],"at":"2026-11-05T10:00:09Z"}
{"type":"activity","entry":{"at":"...","author":"maestro","source":"mcp","action":"claim_task","summary":"claimed AUTH-01","stages":["AUTH"],"tasks":["AUTH-01"],"files":[]}}
{"type":"proposal","id":"01J...","change":"created","at":"..."}
{"type":"agents","at":"..."}
```

`stage`/`board` `change` is `created|updated|deleted` (compared with a snapshot taken at start); `claims` carries all live claims; `proposal` is `created|deleted`.

**Agent Skills**: `pathloom skill install` writes `.agents/skills/pathloom/SKILL.md` (the text of `plugin/skills/pathloom/SKILL.md`, embedded at compile time) into the
project root, `init --agents-skill` does it right after init. An existing file is kept unless `--force` (`ALREADY_EXISTS`).

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

Tools: `project_info`, `list_stages`, `get_stage` (returns a `hash` and live `claims`), `next` (`agent?`; defaults to the caller, returns
`claimed_by`), `search`, `apply`, `set_task`, `add_comment`, `layout_board`, `validate`, `claim_task` (`task_id`, `ttl_minutes?`, `note?`, `session?`),
`release_task` (`task_id`, `force?`), `activity` (`limit?`, `stage?`), `register_agent`, `list_agents`.
The caller identity is the MCP `clientInfo.name` normalized to `[a-z0-9._-]` (`Claude Code` -> `claude-code`) or `--author`; it owns claims
and is the `author` of log entries (`source: "mcp"`) written by every mutating tool. Log failures add `log_warning` to the tool result. Resources: `pathloom://guide/workflow`, `pathloom://schema/{stage,board,spec}`.
Errors are `{code, message, details}` with codes `NOT_FOUND`, `CYCLE`, `DUPLICATE_KEY`, `CONFLICT`, `CLAIMED`, `INVALID_SPEC`,
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
    who: ai                         # me | ai | both | ai:<name> | human:<name>
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
session over stdio (initialize, tools/list, tools/call, resources), including two agents with different `clientInfo`
names claiming the same task.
