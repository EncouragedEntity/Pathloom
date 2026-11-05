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

## Multi-agent API (M6, `docs/m6-agents-contracts.md`)
- `Who` is a validated string newtype, serialized as a plain string: `me`, `ai`, `both`, `ai:<name>` (`[a-z0-9._-]{1,32}`),
  `human:<name>` (letters/digits/space/`._-`, up to 32). `Who::{me, ai, both, parse}`, `is_agent()`, `agent_name()`, `display()`,
  `Default` = `ai`. Invalid values in files or specs are parse errors (`bad who ...`). Old `me|ai|both` files are unchanged byte for byte.
- Claims (`.pathloom/claims.json`, git-ignored; `init` adds it to `.pathloom/.gitignore`, older projects get the line on the first claim):
  `claim_task(task_id, agent, ttl_secs, note)` (0 = 30 min, max 8 h; the same agent renews), `release_task(task_id, agent, force)`,
  `claims()` (live only; expired ones are dropped on the next write). Another agent's live claim -> `Error::Claimed{task_id, by, expires_at}`;
  a claim on a parent task covers its subtasks (and the reverse); unknown task -> `NotFound`, done task -> `InvalidSpec`.
  `set_task_done(.., true)` and `apply` with `tasks_done` release claims of tasks that became done. Read-modify-write of claims is
  serialized across processes by `.pathloom/claims.lock` (`create_new`, waits up to ~2 s, a lock older than 10 s is stale and removed).
  `claim_task_with(task_id, agent, ttl, note, Some(&SessionRef))` also stores the session on the claim and in the stage's `sessions`.
- `next_tasks_for(limit, agent)`: drops tasks claimed by other agents, own claims first; `NextTask.claimed_by`. `next_tasks(limit)` = no identity (claimed tasks hidden).
- `stage_views_live()` = `stage_views` + `StageView.claims` (`[{taskId, agent, expiresAt}]`); `stage_views(&[Stage])` leaves it empty.
- Activity log (`.pathloom/log/agent.jsonl`, append-only JSON lines): `log_action(&LogEntry)` (empty `at` = now), `read_log(limit, stage)` newest first
  (0 = all; broken lines skipped; also reads `agent.1.jsonl`). Rotates to `agent.1.jsonl` past 5 MB (one old copy). Callers must treat
  a log error as a warning, never as a failed action.
- `now_rfc3339()` -> `2026-11-05T01:02:03Z` (UTC, fixed width, sorts as text).

## External clients (M7, `docs/m7-clients-contracts.md`)
- `PROTOCOL` (`"pathloom/1"`) and `capabilities(read_only) -> Vec<&'static str>` (read-only: `read, activity, events, validate`).
- Agent profiles in `plan/agents.json` (pretty JSON, sorted by id, atomic): `AgentProfile {id, name, color, avatar, kind}` (all strings; empty `color`/`avatar` = unset),
  `Project::{agents, upsert_agent, remove_agent}`. Validation: id `[a-z0-9._-]{1,32}`, name <= 40 chars (empty = id), color `#rgb`/`#rrggbb`,
  avatar up to 2 characters or `assets/<file>.png|jpg|jpeg|webp|svg` (no `..`), kind defaults to `agent`. Invalid input is `Error::InvalidSpec`.
- Sessions: `SessionRef {client, id, url?, title?}` (`normalize()` trims and validates: client `[a-z0-9._-]{1,32}`, id <= 128 printable, url `http(s)://` or a custom
  `scheme://` but never `javascript:`/`data:`/`file:`, title <= 120). Stage frontmatter `sessions: [{client: maestro, id: s1, url: "maestro://session/s1", title: ...}]`
  (optional; oldest first, newest 20 kept, dedup by client+id). `apply` spec: `stages[].sessions_add`. `Stage.sessions` (so `StageView` JSON has `sessions`),
  `Claim.session` / `ClaimView.session`, `LogEntry.session`.
- `events::{Event, Change, EventWatcher}`: `EventWatcher::start(&project)` watches `plan/stages`, `plan/boards`, `plan/agents.json`, `.pathloom/proposals`,
  `.pathloom/claims.json` and `.pathloom/log/agent.jsonl` (debounce 200 ms) and yields events via `recv_timeout` / `try_recv`. Changes are detected by content hash against a
  snapshot taken at start (identical rewrites give no event); the log is tailed by byte offset (complete lines only; a shrunk file = rotation, the unread rest of `agent.1.jsonl` is read first).
  `Event` is serde-tagged by `type`: `hello`, `stage {key, change}`, `board {name, change}`, `claims {claims}`, `activity {entry}`, `proposal {id, change}`, `agents`; `change` is `created|updated|deleted`.
  `Event::hello()`, `to_json_line()`, `Display` (human format).

## File format notes
- All writes are atomic (temp file in the same dir, fsync, rename; retried on Windows `PermissionDenied`).
- Stage file: frontmatter fields are written in fixed order (id, title, kind, who, due, priority, branch,
  pr, tags, depends, sessions, then unknown keys in original order). Frontmatter comments are not kept.
- Only frontmatter, `## Tasks` and `## Comments` are managed. Everything else (description, other
  headings, text between/after the managed sections) is kept byte-for-byte. A repeated managed
  heading or a non-list line inside a managed section is kept as plain text.
- Input may use CRLF; output is always LF. A file Pathloom wrote and re-saved unchanged is byte-identical.
- Board: canonical JSON, one element per line, key order `id,type,ref,x,y,w,h,angle,index`, then the rest A-Z.
  Unknown element keys survive; unknown top-level board keys do not.
- Statuses: done > blocked > active > ready. Empty `stage` is never done; a milestone with no known
  hard deps is `ready`; soft and unknown deps never block.
