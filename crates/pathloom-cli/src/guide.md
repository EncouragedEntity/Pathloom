# Working with Pathloom (guide for agents)

Pathloom keeps a project plan in plain files. You change it through these tools; the desktop app shows
your changes live. Files are the source of truth, so every change is a normal file edit a human can review.

## Concepts
- **Stage** = one card of the roadmap: file `plan/stages/<KEY>.md`. Key: `[A-Z][A-Z0-9]{0,7}` (`M0`, `AUTH`).
  Fields: `title`, `kind` (`stage` | `milestone`), `who` (`me` | `ai` | `both`), `priority` (`low` | `med` | `high`),
  `due`, `branch`, `depends`.
- **Task** = a checkbox in a stage. IDs are `<KEY>-<NN>` (`AUTH-02`); a subtask adds a letter (`AUTH-02a`).
  A task with subtasks is done when all of them are. Milestones have no tasks.
- **depends** = prerequisites. A hard dependency blocks until that stage is done; a soft one only draws a dashed line.
  Cycles are rejected (`CYCLE`).
- **Status is computed, never written**: `done` (all tasks done; milestone: all hard deps done), `blocked`
  (a hard dep is not done), `active` (not blocked, some task done), `ready` (not blocked, nothing done).
  A stage with no tasks is never done.
- **Board** = a canvas (`plan/boards/<name>.board.json`) with cards (one per stage), frames (phases) and drawings.

## Recommended workflow
1. `project_info` first: boards, counts per status, the top 5 next tasks, whether the project is in review mode.
2. `next` to find what to do. Do the work, then `set_task` (done=true) and `add_comment` with a short note
   (what changed, where, what is left).
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
- Errors are `{code, message, details}`: `NOT_FOUND`, `CYCLE`, `DUPLICATE_KEY`, `CONFLICT`, `INVALID_SPEC`, `READ_ONLY`, `OUT_OF_PROJECT`.
  A failed `apply` writes nothing.
