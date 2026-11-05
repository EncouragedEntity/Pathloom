---
name: pathloom
description: Plan and track project work on a Pathloom board (stages, tasks, dependencies, progress) through the pathloom MCP tools or the `pathloom` CLI. Use when the user asks to plan a project, build a roadmap, break work into stages/tasks, see what to do next, mark tasks done, or update the plan as code progresses, and the project folder has a `.pathloom/` directory (or the user wants one created).
---

# Pathloom

Pathloom keeps a project plan as plain files next to the code:

- `plan/stages/<KEY>.md` — one **stage** (a card on the board): YAML frontmatter + a `## Tasks` checklist + `## Comments`.
- `plan/boards/<name>.board.json` — positions of cards, frames (phases), drawings.
- `.pathloom/project.toml` — settings (`agent_changes = "auto" | "review"`).

The desktop app watches these files and shows every change live, highlighted, with an "Undo" button for the user.

## Model

- **Stage** = card with a short uppercase **key** (`AUTH`, `M0`). Fields: `title`, `kind` (`stage` | `milestone`), `who`, `priority` (`low` | `med` | `high`), `due` (YYYY-MM-DD), `branch`, `depends`.
- **who** = `me` (the owner), `ai`, `both`, a named agent `ai:<name>` (`ai:claude`, `ai:codex`) or another person `human:<name>`. Set `who: ai:<your-name>` on stages you own.
- **Task** = checklist line with id `<KEY>-<NN>` (`AUTH-03`); subtasks get a letter (`AUTH-03a`). A task with subtasks is done when all subtasks are done.
- **Dependencies** live on the dependent stage: `depends: [CORE, {id: DOCS, soft: true}]`. Soft deps are drawn dashed and never block. Cycles are rejected.
- **Status is computed, never set**: `done` (all tasks done), `blocked` (a hard dependency is not done), `active` (some tasks done), `ready` (nothing done yet, not blocked). Milestones are done when their hard deps are done.
- **Phases** are frames on the board around cards.

## Workflow

1. Start with `project_info` (or `pathloom info --json`). It returns `protocol` (`pathloom/1`), `capabilities`, registered `agents` and the stages. Reuse keys; never delete or rewrite stages you did not create unless the user asks.
   - Once per session, `register_agent {name, color, avatar}` so the board shows you with your own name and colour (`avatar`: one emoji, or an image path `assets/...` inside the plan).
   - Read `activity` to see what other agents and the user did recently.
2. To plan, call `apply` once with the whole structure instead of many small calls:

```yaml
board: roadmap
stages:
  - id: AUTH
    title: Authentication
    who: ai
    priority: high
    depends: [CORE]
    tasks: [Login form, Session storage, Logout]
  - id: REL
    title: Release 0.1
    kind: milestone
    depends: [AUTH]
frames:
  - name: "Phase 1"
    members: [CORE, AUTH]
```

   New cards are laid out automatically to the right of their dependencies. Re-applying the same spec is safe (tasks with the same title are not duplicated). Use `dry_run: true` to preview.
3. While working:
   - `next` lists tasks you can do right now (unblocked, by priority and due date). Tasks taken by other agents are hidden; your own come first.
   - **Claim before you start**: `claim_task {task_id}` (30 min by default, re-claim to extend). The card shows your name, and other agents won't take the task. A `CLAIMED` error means someone else is on it — pick another task; never force unless the user asks.
   - Mark progress with `set_task {task_id, done: true}` — this also releases your claim. If you stop without finishing, call `release_task`.
   - Leave short notes with `add_comment` — the user reads them on the card.
   - `activity` shows what other agents and the user did recently. Read it when you start a session.
4. Keep `branch` on a stage in sync with the git branch you work on (`apply` with `branch: feat/x`).
5. Run `validate` after larger edits.

## Sessions

If you run inside an app with its own session id (an orchestrator, an IDE chat), pass `session {client, id, url?, title?}` to `claim_task` and other mutating tools. The stage keeps the link so the user can jump back to the conversation where the work happened. `url` may be `https://…` or the app's own scheme (`maestro://…`).

## Watching for changes

`pathloom watch --json` streams NDJSON events (`hello`, `stage`, `board`, `claims`, `activity`, `proposal`, `agents`) so a client can react to edits by the user or other agents without polling. Use `--since <RFC3339>` to catch up first.

## Review mode

If the project uses `agent_changes = "review"`, `apply` creates a **proposal** instead of writing files. The user sees it as dashed "Proposed" cards and accepts or rejects it. Tell the user a proposal is waiting; do not try to bypass it.

## Concurrency

`get_stage` returns a `hash`. Pass it back in `apply` as `expected: {KEY: hash}` when you edit a stage the user may be editing; a `CONFLICT` error means re-read and retry.

## CLI equivalents

```
pathloom next --json
pathloom task done AUTH-02
pathloom comment AUTH "Login works, tests pass"
pathloom apply plan.yaml --dry-run
pathloom validate
```

Errors are structured: `NOT_FOUND`, `CYCLE`, `DUPLICATE_KEY`, `CONFLICT`, `INVALID_SPEC`, `READ_ONLY`, `OUT_OF_PROJECT`.
