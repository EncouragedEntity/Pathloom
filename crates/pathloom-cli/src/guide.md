# Working with Pathloom (guide for agents)

Pathloom keeps a project plan in plain files. You change it through these tools; the desktop app shows
your changes live. Files are the source of truth, so every change is a normal file edit a human can review.

## Concepts
- **Stage** = one card of the roadmap: file `plan/stages/<KEY>.md`. Key: `[A-Z][A-Z0-9]{0,7}` (`M0`, `AUTH`).
  Fields: `title`, `kind` (`stage` | `milestone`), `who` (`me` | `ai` | `both` | `ai:<name>` | `human:<name>`), `priority` (`low` | `med` | `high`),
  `due`, `branch`, `depends`.
- **Task** = a checkbox in a stage. IDs are `<KEY>-<NN>` (`AUTH-02`); a subtask adds a letter (`AUTH-02a`).
  A task with subtasks is done when all of them are. Milestones have no tasks.
- **depends** = prerequisites. A hard dependency blocks until that stage is done; a soft one only draws a dashed line.
  Cycles are rejected (`CYCLE`).
- **Status is computed, never written**: `done` (all tasks done; milestone: all hard deps done), `blocked`
  (a hard dep is not done), `active` (not blocked, some task done), `ready` (not blocked, nothing done).
  A stage with no tasks is never done.
- **Board** = a canvas (`plan/boards/<name>.board.json`) with cards (one per stage), frames (phases) and drawings.

## Who and claims
- `who: ai:<name>` assigns a stage to one named agent (`ai:claude`, `ai:codex`); plain `ai` means any agent.
  Your name is your MCP client name (shown in `claimed_by` and in `activity`). Prefer stages that are `ai` or `ai:<your name>`.
- Several agents may work on the same plan. **Claim before you work**: `claim_task {task_id}` (default 30 min,
  `ttl_minutes` up to 480; claim again to renew). `next` hides tasks claimed by others and lists yours first.
- When the work is finished, `set_task` done: that releases the claim by itself. If you stop without finishing,
  call `release_task`. A claim on a task with subtasks covers its subtasks.
- `CLAIMED` (details: `task_id`, `by`, `expires_at`) means someone else holds the task: pick another one from `next`.
  **Never steal a claim** (`release_task` with `force`) unless the user explicitly asked you to.
- Use `activity` (optionally `stage`) to see what others did lately before you touch a stage; every change of
  yours is logged there automatically.

## Proof, liveness, hand-offs
- Close tasks with proof: `set_task {task_id, done: true, evidence: {command, exit_code: 0, duration_ms?, summary?, log?}}`.
  Run the real check first. Non-zero exit codes are refused. With `require_evidence: true` (in `project_info`) closing
  a task of a normal stage without evidence fails with `EVIDENCE_REQUIRED` (also for `tasks_done` in `apply`).
- `heartbeat {task_id?, note?}` keeps your claims alive and tells the user you are still working. Any logged action
  counts as a sign of life; after 10 minutes without one the app shows your claim as silent.
- `stages[].artifacts_add` in `apply` lists hand-off files (project-relative paths or http(s) links) on a stage;
  `get_stage` returns them as `artifacts`.
- `kind: gate` stages have `check` (a command). Run it yourself and report with `set_gate {key, evidence}`:
  exit code 0 makes the gate done, anything else reopens it.
- Optional `report_usage {tokens_in, tokens_out, cost_usd?, stage?, note?}`: the app sums it per agent and stage.
- `import_tasks {format: "spec-kit", text}` turns a Spec Kit `tasks.md` into stages (phases), tasks and dependencies.

## Identity and sessions
- `register_agent {name?, color?, avatar?, kind?}` sets your own display profile (id = your caller name; `name` up to 40 chars, `color` `#rgb`/`#rrggbb`,
  `avatar` one emoji or `assets/<file>.png`). The app shows it instead of a generated color. You can only register yourself; `list_agents` shows all profiles.
- If you run inside an external client (an orchestrator, an IDE), pass `session: {client, id, url?, title?}` to `claim_task` and to any other mutating tool.
  A claim with a session also adds it to the stage's `sessions` history, and every log entry keeps it, so humans can jump back to that session.
  In `apply`, `stages[].sessions_add: [{client, id, url?, title?}]` records sessions on a stage (deduplicated by client+id, newest 20 kept).

## Recommended workflow
1. `project_info` first: `protocol` (`pathloom/1`), `version`, `capabilities` (what this server supports; a `--read-only` server has no mutating ones), boards, counts per status,
   the top 5 next tasks, `agent_changes` (review mode) and the `agents` profiles. Then `register_agent` once per session (see Identity and sessions).
2. `next` to find what to do, `claim_task` it, do the work, then `set_task` (done=true; releases the claim)
   and `add_comment` with a short note (what changed, where, what is left).
3. To plan or restructure, use `apply` with a spec (see `pathloom://schema/spec`). Try `dry_run: true` first.
   Re-applying the same spec is safe: existing tasks (same title), links, cards and frames are not duplicated.
4. Before editing a stage someone else may touch, call `get_stage` and pass its `hash` in `expected`
   (`{"AUTH": "<hash>"}`). A changed file gives `CONFLICT`: re-read and retry.
5. `layout_board` only when asked or after adding many cards; it moves cards. Use `only_new` to keep the rest still.
6. `validate` after bigger changes.

## Spec example (`apply`)
```yaml
board: roadmap
stages:
  - id: AUTH
    title: Authentication
    who: ai
    priority: high
    depends: [M0, {id: M2, soft: true}]   # replaces the whole list when present
    tasks: [Login, Sign up]                # appended; a task with the same title is skipped
    place: {after: M0}                     # or {x: 100, y: 200}; omit for auto-layout
  - id: M0
    tasks_done: [M0-04]
links: [{from: AUTH, to: RELEASE, soft: false}]
frames: [{name: "Phase 2", members: [AUTH, M1]}]
comments: [{stage: AUTH, text: "Started with OAuth"}]
expected: {M0: "<hash from get_stage>"}
```

## Rules
- **Never delete or rewrite stages you did not create** and never clear their tasks. There is no delete in `apply` on purpose.
- Do not invent task IDs: add tasks by title and read the IDs back with `get_stage`.
- Keep titles short; put detail in the stage description (edit the file) or in comments.
- Comments are authored as you (`agent:<client>`); keep them factual.
- `agent_changes = review`: `apply` returns `mode: proposed` and changes nothing until a human accepts. That is normal; do not retry.
- Errors are `{code, message, details}`: `NOT_FOUND`, `CYCLE`, `DUPLICATE_KEY`, `CONFLICT`, `CLAIMED`, `INVALID_SPEC`, `READ_ONLY`, `OUT_OF_PROJECT`.
  A failed `apply` writes nothing.
