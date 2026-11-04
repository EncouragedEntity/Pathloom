# pathloom-core

Project files, boards, stage files, dependency graph and computed statuses for Pathloom.
Spec: `docs/spec.md` §4-5; API contract: `docs/m1-contracts.md` §1. Tests: `cargo test -p pathloom-core`.

## Public API (crate root)
- `Project::{init, open, find, plan_dir}`; `.pathloom/project.toml` + `.pathloom/.gitignore`.
- Boards: `list_boards`, `load_board`, `save_board`, `create_board` (names use `/`, no `..`).
- Stages: `load_stages`, `load_stage`, `save_stage`, `create_stage(title, key?)`, `delete_stage`.
- Tasks: `add_task`, `set_task_done`, `rename_task`, `remove_task` (ids `M0-02`, subtask `M0-02a`).
- Graph: `link(from, to, soft)` (self/cycle -> `Error::Cycle(nodes)`, duplicate = no-op), `unlink`.
- `compute_statuses(&[Stage])`, `stage_views(&[Stage])`, `generate_key`, `is_valid_key`.
- Lower level: `Stage::from_markdown(path, text)` / `Stage::to_markdown()`, `Board::to_canonical_json()`.

## Agent API (M3)
- `Project::parse_spec(text)` (YAML, or JSON when it starts with `{`) -> `ApplySpec`; `Project::apply(&spec, &ApplyOptions{dry_run, author})` -> `ApplyReport`.
  Transactional: everything is computed in memory and validated (unknown keys, cycles, `expected` hashes -> `Error::Conflict`),
  then written; a failed write restores the files already written. Re-applying the same spec is a no-op.
  New cards go to the spec's board: `place` ({x,y} or {after}) or auto-layout right of their dependencies; `frames` get a
  `frame` element (40px padding) and members get `frame: <id>`. Ids are `e` + 10 base32 chars, z-order keys come from `indexkey.rs` (port of `index-key.ts`).
- `stage_hash(key)` / `hash_bytes` (sha256 hex), `next_tasks(limit)` (priority, due, file order), `add_comment`.
- `layout_board(board, only_new)`: longest-path layers over hard+soft depends, barycenter order, steps 320x220; shifts cards
  down past non-card obstacles (frames and arrows/lines/freedraw are ignored); refits frames of moved cards.
- `validate()` -> `Vec<Issue{code,message,path}>` (`PARSE_ERROR`, `DUPLICATE_KEY`, `BROKEN_DEPEND`, `BROKEN_CARD`, `CYCLE`, `INVALID_TASK_ID`);
  `validate_fix()` only drops broken depends and cards of missing stages.
- Proposals (`.pathloom/proposals/<ulid>.json`): `propose`, `list_proposals`, `accept_proposal`, `reject_proposal`.
- `writes::{record, is_own}`: every atomic write registers `(path, sha256)`; the desktop watcher uses `is_own` to skip its own writes
  (paths are compared as written, not canonicalized). `write_file_atomic(path, bytes)` is the public atomic write.
- New errors: `Error::Conflict{key}`, `Error::InvalidSpec(msg)`. `Project::init_with(root, name, plan_dir)`.
- Spec/board/stage types derive `schemars::JsonSchema` (used by `pathloom schema`).

## File format notes
- All writes are atomic (temp file in the same dir, fsync, rename; retried on Windows `PermissionDenied`).
- Stage file: frontmatter fields are written in fixed order (id, title, kind, who, due, priority, branch,
  pr, tags, depends, then unknown keys in original order). Frontmatter comments are not kept.
- Only frontmatter, `## Tasks` and `## Comments` are managed. Everything else (description, other
  headings, text between/after the managed sections) is kept byte-for-byte. A repeated managed
  heading or a non-list line inside a managed section is kept as plain text.
- Input may use CRLF; output is always LF. A file Pathloom wrote and re-saved unchanged is byte-identical.
- Board: canonical JSON, one element per line, key order `id,type,ref,x,y,w,h,angle,index`, then the rest A-Z.
  Unknown element keys survive; unknown top-level board keys do not.
- Statuses: done > blocked > active > ready. Empty `stage` is never done; a milestone with no known
  hard deps is `ready`; soft and unknown deps never block.
