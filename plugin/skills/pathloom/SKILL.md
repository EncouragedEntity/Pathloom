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
   - `NOT_FOUND ... call init_project` means the folder has no plan yet: if the user wants one, call `init_project {name?}` (or `pathloom init`), then plan with `apply`. The user opens the folder in the Pathloom app to see the board.
   - Once per session, `register_agent {name, color, avatar}` so the board shows you with your own name and colour (`avatar`: one emoji, or an image path `assets/...` inside the plan).
   - Read `activity` to see what other agents and the user did recently.
2. To plan, call `apply` once with the whole structure instead of many small calls:

```yaml
board: roadmap
stages:
  - id: AUTH
    title: Authentication
    description: Users can sign up and log in; done when sessions survive a restart.
    who: ai
    priority: high
    depends: [CORE]
    tasks: [Login form, Session storage, Logout]
  - id: REL
    title: Release 0.1
    kind: milestone
    depends: [AUTH]
frames:
  - name: "1 · Foundation"
    members: [CORE, AUTH]
```

   New cards are laid out automatically to the right of their dependencies. Re-applying the same spec is safe (tasks with the same title are not duplicated). Use `dry_run: true` to preview.
3. While working:
   - `next` lists tasks you can do right now (unblocked, by priority and due date). Tasks taken by other agents are hidden; your own come first.
   - **Claim before you start**: `claim_task {task_id}` (30 min by default, re-claim to extend). The card shows your name, and other agents won't take the task. A `CLAIMED` error means someone else is on it — pick another task; never force unless the user asks.
   - Mark progress with `set_task {task_id, done: true, evidence: {command, exit_code: 0, duration_ms?, summary?}}` — run the real check (tests, build) first and attach its result: the task shows as **verified**. This also releases your claim. If you stop without finishing, call `release_task`. A failing check (exit code ≠ 0) never closes a task. Projects with `require_evidence: true` (see `project_info`) refuse `done` without evidence (`EVIDENCE_REQUIRED`).
   - During long steps call `heartbeat {note?}` every few minutes (any other action counts too). After 10 minutes without a sign of life the app marks you as "silent, maybe stuck".
   - List hand-off files of a stage (spec, plan, review notes) with `apply` → `stages: [{id, artifacts_add: [specs/auth/spec.md]}]`. A hand-off is an artifact, not a retelling: write the file, then link it.
   - Gate stages (`kind: gate`, with `check: npm test`) are done only when the check passes: run the command, then `set_gate {key, evidence}`.
   - Optional: `report_usage {tokens_in, tokens_out, cost_usd?, stage?}` so the user sees spending per stage and agent.
   - Leave short notes with `add_comment` — the user reads them on the card.
   - `activity` shows what other agents and the user did recently. Read it when you start a session.
4. Keep `branch` on a stage in sync with the git branch you work on (`apply` with `branch: feat/x`).
5. Run `validate` after larger edits.

## Make the board readable

The user reads the plan as a picture, left to right. Follow these rules whenever you create or restructure it:

- **Frames are phases in time order**, not status buckets. Name them with a number and the goal: `1 · Foundation`, `2 · MVP (Dec)`, `3 · Release`. Never make frames like "Done", "Now", "Next", "Later" or "Bugs": status is computed and shown by colour, and the app has Active/Done filters. Put bug and debt stages into the phase where they will be fixed.
- **Every stage says what it is for**: a short outcome title (up to ~40 characters, e.g. "Login with Google") and a one-sentence `description` in `apply` (why it exists, what is done when it is done).
- **3-8 tasks per stage.** More than 12: split the stage.
- **Only direct prerequisites in `depends`.** If C needs B and B needs A, C depends on B only, never also on A. Use `soft: true` for "better after, but not blocked".
- **A milestone depends on the last stages of its phase**, not on every stage of the project.
- After a bigger change run `validate` and fix every `hints` entry (`REDUNDANT_DEP`, `BIG_STAGE`, `NO_DESCRIPTION`).
- Positions: if the board has auto-layout on, the app re-arranges it after your change; otherwise call `layout_board` after restructuring many cards. Never move cards the user placed by hand.
- Finish with a 3-5 line summary for the user: the phases and what comes next.

## Importing a plan

A GitHub Spec Kit `tasks.md` (phases with `- [ ] T001 ...`) becomes stages with tasks and dependencies: `import_tasks {format: "spec-kit", text, dry_run: true}` (or `pathloom import spec-kit specs/<feature>/tasks.md`). Re-import after editing `tasks.md` adds new tasks and marks checked ones done.

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
pathloom task done AUTH-02 --run "cargo test"   # runs the check, closes only if it passes
pathloom task heartbeat --note "running tests"
pathloom gate run TESTS
pathloom import spec-kit specs/001-auth/tasks.md --dry-run
pathloom comment AUTH "Login works, tests pass"
pathloom apply plan.yaml --dry-run
pathloom validate
```

Errors are structured: `NOT_FOUND`, `CYCLE`, `DUPLICATE_KEY`, `CONFLICT`, `INVALID_SPEC`, `READ_ONLY`, `OUT_OF_PROJECT`, `EVIDENCE_REQUIRED`, `CHECK_FAILED`.
