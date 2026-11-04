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
