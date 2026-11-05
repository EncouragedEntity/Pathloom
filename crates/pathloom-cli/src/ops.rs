//! Operations shared by the CLI and the MCP server. Everything returns JSON values and `ApiError`.

use pathloom_core::{
    AgentProfile, ApplyOptions, ApplySpec, Error, Evidence, LogEntry, Project, SessionRef, Stage, StageView, Status, Who,
    capabilities, compute_statuses, stage_views,
};
use serde::Serialize;
use serde_json::{Value, json};
use std::path::{Component, Path, PathBuf};

/// Structured error: `{code, message, details}` (spec §7.2).
#[derive(Debug, Clone)]
pub struct ApiError {
    pub code: &'static str,
    pub message: String,
    pub details: Value,
}

pub type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        ApiError { code, message: message.into(), details: Value::Null }
    }

    pub fn read_only() -> Self {
        Self::new("READ_ONLY", "server runs with --read-only; this tool changes files")
    }

    pub fn to_json(&self) -> Value {
        json!({"code": self.code, "message": self.message, "details": self.details})
    }
}

impl From<Error> for ApiError {
    fn from(e: Error) -> Self {
        let message = e.to_string();
        let (code, details) = match &e {
            Error::NotFound(w) => ("NOT_FOUND", json!({"what": w})),
            Error::NotAProject => ("NOT_FOUND", Value::Null),
            Error::Cycle(nodes) => ("CYCLE", json!({"nodes": nodes})),
            Error::DuplicateKey(k) => ("DUPLICATE_KEY", json!({"key": k})),
            Error::Conflict { key } => ("CONFLICT", json!({"key": key})),
            Error::Claimed { task_id, by, expires_at } => {
                ("CLAIMED", json!({"task_id": task_id, "by": by, "expires_at": expires_at}))
            }
            Error::InvalidName(n) if looks_like_path_escape(n) => ("OUT_OF_PROJECT", json!({"name": n})),
            Error::InvalidName(_)
            | Error::InvalidKey(_)
            | Error::InvalidSpec(_)
            | Error::Parse { .. }
            | Error::AlreadyInitialized(_) => ("INVALID_SPEC", Value::Null),
            Error::Io(_) => ("IO_ERROR", Value::Null),
        };
        ApiError { code, message, details }
    }
}

fn looks_like_path_escape(n: &str) -> bool {
    n.contains("..") || n.contains(['\\', ':']) || n.starts_with('/')
}

fn to_v<T: Serialize>(v: &T) -> Value {
    serde_json::to_value(v).unwrap_or(Value::Null)
}

/// Absolute project root: `--project` or the current dir, then search upwards for `.pathloom/`.
pub fn locate_root(project: Option<&Path>) -> ApiResult<PathBuf> {
    let start = match project {
        Some(p) => std::path::absolute(p),
        None => std::env::current_dir(),
    }
    .map_err(|e| ApiError::new("IO_ERROR", e.to_string()))?;
    Ok(Project::find(&start)?.root)
}

/// Open the project and refuse a `plan_dir` that points outside the root.
pub fn open_project(root: &Path) -> ApiResult<Project> {
    let p = Project::open(root)?;
    let pd = Path::new(&p.config.plan_dir);
    if pd.is_absolute() || pd.components().any(|c| matches!(c, Component::ParentDir | Component::Prefix(_))) {
        return Err(ApiError::new("OUT_OF_PROJECT", format!("plan_dir `{}` is outside the project", p.config.plan_dir)));
    }
    Ok(p)
}

pub fn parse_status(s: &str) -> ApiResult<Status> {
    serde_json::from_value(json!(s))
        .map_err(|_| ApiError::new("INVALID_SPEC", format!("unknown status `{s}` (done|active|ready|blocked)")))
}

pub fn parse_who(s: &str) -> ApiResult<Who> {
    Who::parse(s).map_err(|m| ApiError::new("INVALID_SPEC", m))
}

fn row(v: &StageView) -> Value {
    let s = &v.stage;
    json!({
        "key": s.key, "title": s.title, "kind": to_v(&s.kind), "status": to_v(&v.status),
        "progress": {"done": v.progress.0, "total": v.progress.1},
        "who": to_v(&s.who), "priority": to_v(&s.priority), "due": s.due,
    })
}

#[derive(Default)]
pub struct StageFilter {
    pub status: Option<Status>,
    pub who: Option<Who>,
    pub board: Option<String>,
    pub query: Option<String>,
}

/// Compact stage rows with offset pagination (`cursor` = offset). `limit` 0 = default 50, max 500.
pub fn list_stages(p: &Project, f: &StageFilter, limit: usize, cursor: Option<&str>) -> ApiResult<Value> {
    let on_board: Option<Vec<String>> = match &f.board {
        Some(b) => Some(
            p.load_board(b)?
                .elements
                .iter()
                .filter_map(|e| e.get("ref").and_then(Value::as_str).map(String::from))
                .collect(),
        ),
        None => None,
    };
    let q = f.query.as_deref().map(str::to_lowercase);
    let views: Vec<StageView> = stage_views(&p.load_stages()?)
        .into_iter()
        .filter(|v| f.status.is_none_or(|s| s == v.status))
        .filter(|v| f.who.as_ref().is_none_or(|w| *w == v.stage.who))
        .filter(|v| on_board.as_ref().is_none_or(|b| b.contains(&v.stage.key)))
        .filter(|v| q.as_ref().is_none_or(|q| v.stage.key.to_lowercase().contains(q) || v.stage.title.to_lowercase().contains(q)))
        .collect();
    let limit = if limit == 0 { 50 } else { limit.min(500) };
    let start = match cursor {
        None | Some("") => 0,
        Some(c) => c.parse::<usize>().map_err(|_| ApiError::new("INVALID_SPEC", format!("bad cursor `{c}`")))?,
    };
    let page: Vec<Value> = views.iter().skip(start).take(limit).map(row).collect();
    let end = start + page.len();
    Ok(json!({
        "stages": page, "total": views.len(),
        "next_cursor": (end < views.len()).then(|| end.to_string()),
    }))
}

pub fn get_stage(p: &Project, key: &str) -> ApiResult<Value> {
    let stage = p.load_stage(key)?;
    let hash = p.stage_hash(key)?;
    let all = p.load_stages()?;
    let view = stage_views(&all).into_iter().find(|v| v.stage.key == key);
    let mut v = to_v(&stage);
    if let (Some(view), Some(o)) = (view, v.as_object_mut()) {
        o.insert("status".into(), to_v(&view.status));
        o.insert("progress".into(), json!({"done": view.progress.0, "total": view.progress.1}));
    }
    let claims: Vec<_> = p.claims()?.into_iter().filter(|c| stage_key(&c.task_id) == key).collect();
    if let Some(o) = v.as_object_mut() {
        o.insert("hash".into(), json!(hash));
        o.insert("claims".into(), to_v(&claims));
    }
    Ok(v)
}

pub fn project_info(p: &Project, read_only: bool) -> ApiResult<Value> {
    let stages = p.load_stages()?;
    let statuses = compute_statuses(&stages);
    let count = |s: Status| statuses.values().filter(|x| **x == s).count();
    Ok(json!({
        "name": p.config.name, "root": p.root.to_string_lossy(), "plan_dir": p.config.plan_dir,
        "protocol": pathloom_core::PROTOCOL, "version": env!("CARGO_PKG_VERSION"),
        "capabilities": capabilities(read_only),
        "agent_changes": to_v(&p.config.agent_changes), "require_evidence": p.config.require_evidence,
        "read_only": read_only,
        "agents": p.agents()?,
        "boards": p.list_boards()?,
        "stages": {"total": stages.len(), "done": count(Status::Done), "active": count(Status::Active),
                   "ready": count(Status::Ready), "blocked": count(Status::Blocked)},
        "next": p.next_tasks(5)?,
        "pending_proposals": p.list_proposals()?.len(),
    }))
}

pub fn search(p: &Project, query: &str, limit: usize) -> ApiResult<Value> {
    let q = query.to_lowercase();
    if q.trim().is_empty() {
        return Err(ApiError::new("INVALID_SPEC", "query must not be empty"));
    }
    let limit = if limit == 0 { 20 } else { limit.min(200) };
    let mut hits: Vec<Value> = Vec::new();
    let has = |s: &str| s.to_lowercase().contains(&q);
    'outer: for s in p.load_stages()? {
        let mut push = |kind: &str, id: &str, text: &str| hits.push(json!({"stage": s.key, "kind": kind, "id": id, "text": text}));
        if has(&s.key) || has(&s.title) {
            push("stage", &s.key, &s.title);
        } else if has(&s.description) {
            push("description", &s.key, &s.title);
        }
        for t in s.tasks.iter().flat_map(|t| std::iter::once(t).chain(t.sub.iter())) {
            if has(&t.title) {
                push("task", &t.id, &t.title);
            }
        }
        if hits.len() >= limit {
            break 'outer;
        }
    }
    hits.truncate(limit);
    Ok(json!({"query": query, "results": hits}))
}

/// Run an apply spec honoring `agent_changes`: review mode stores a proposal unless `direct`.
pub fn submit(p: &Project, spec: &ApplySpec, author: &str, dry_run: bool, direct: bool) -> ApiResult<Value> {
    use pathloom_core::AgentChanges;
    if dry_run {
        let r = p.apply(spec, &ApplyOptions { dry_run: true, author: author.into() })?;
        return Ok(json!({"mode": "dry_run", "report": r}));
    }
    if p.config.agent_changes == AgentChanges::Review && !direct {
        let prop = p.propose(spec, author)?;
        return Ok(json!({"mode": "proposed", "proposal_id": prop.id, "report": prop.preview,
                         "note": "agent_changes=review: the plan is unchanged until a human accepts this proposal"}));
    }
    let r = p.apply(spec, &ApplyOptions { dry_run: false, author: author.into() })?;
    Ok(json!({"mode": "applied", "report": r}))
}

pub fn parse_spec_value(v: &Value) -> ApiResult<ApplySpec> {
    match v {
        Value::String(s) => Ok(Project::parse_spec(s)?),
        other => serde_json::from_value(other.clone()).map_err(|e| ApiError::new("INVALID_SPEC", e.to_string())),
    }
}

/// Mark a task done/undone, optionally with evidence (its `by` defaults to the actor).
/// `enforce`: apply the project's `require_evidence` policy (agents via MCP).
pub fn set_task(
    p: &Project,
    a: &Actor,
    action: &str,
    task_id: &str,
    done: bool,
    evidence: Option<Evidence>,
    enforce: bool,
) -> ApiResult<Value> {
    if enforce && done && evidence.is_none() {
        require_no_evidence_policy(p, &[task_id.to_string()])?;
    }
    let evidence = evidence.map(|mut e| {
        if e.by.trim().is_empty() {
            e.by.clone_from(&a.name);
        }
        e
    });
    let verified = evidence.as_ref().map(|e| e.command.clone());
    let s = p.set_task_done_with(task_id, done, evidence)?;
    let v = json!({"task_id": task_id, "done": done, "verified": verified.is_some(), "stage": brief(&s, p)?});
    let summary = match (done, verified) {
        (true, Some(cmd)) => format!("{task_id} done, verified: {}", cmd.chars().take(60).collect::<String>()),
        (true, None) => format!("{task_id} done"),
        (false, _) => format!("{task_id} reopened"),
    };
    let e = entry(action, summary, vec![s.key.clone()], vec![task_id.into()], vec![stage_file(p, &s.key)]);
    Ok(log(p, a, e, v))
}

/// With `require_evidence` on, refuse closing these tasks (of `kind: stage` stages) without evidence.
pub fn require_no_evidence_policy(p: &Project, task_ids: &[String]) -> ApiResult<()> {
    if !p.config.require_evidence {
        return Ok(());
    }
    for id in task_ids {
        let st = p.load_stage(&stage_key(id))?;
        if st.kind == pathloom_core::StageKind::Stage {
            return Err(ApiError {
                code: "EVIDENCE_REQUIRED",
                message: format!(
                    "this project requires evidence to close tasks: run the check, then set_task {{task_id: {id}, done: true, evidence: {{command, exit_code: 0}}}}"
                ),
                details: json!({"task_id": id}),
            });
        }
    }
    Ok(())
}

pub fn add_comment(p: &Project, a: &Actor, key: &str, author: &str, text: &str) -> ApiResult<Value> {
    let s = p.add_comment(key, author, text)?;
    let v = json!({"stage": s.key, "comments": s.comments.len(), "author": author});
    let e = entry("add_comment", format!("comment on {key}"), vec![s.key.clone()], vec![], vec![stage_file(p, &s.key)]);
    Ok(log(p, a, e, v))
}

fn brief(s: &Stage, p: &Project) -> ApiResult<Value> {
    let all = p.load_stages()?;
    let v = stage_views(&all).into_iter().find(|v| v.stage.key == s.key);
    Ok(v.map(|v| row(&v)).unwrap_or(Value::Null))
}

pub fn layout(p: &Project, a: &Actor, board: &str, only_new: &[String]) -> ApiResult<Value> {
    let b = p.layout_board(board, only_new)?;
    let cards: Vec<Value> = b
        .elements
        .iter()
        .filter(|e| e.get("type").and_then(Value::as_str) == Some("card"))
        .map(|e| json!({"key": e.get("ref"), "x": e.get("x"), "y": e.get("y")}))
        .collect();
    let file = format!("{}/boards/{board}.board.json", p.config.plan_dir.trim_end_matches('/'));
    let e = entry("layout_board", format!("laid out {} cards on {board}", cards.len()), vec![], vec![], vec![file]);
    Ok(log(p, a, e, json!({"board": board, "cards": cards})))
}

pub fn validate(p: &Project, a: &Actor, fix: bool) -> ApiResult<Value> {
    let fixed = if fix { p.validate_fix()? } else { vec![] };
    let issues = p.validate()?;
    let v = json!({"ok": issues.is_empty(), "issues": issues, "fixed": fixed});
    if fixed.is_empty() {
        return Ok(v);
    }
    Ok(log(p, a, entry("validate --fix", format!("fixed {} problem(s)", fixed.len()), vec![], vec![], vec![]), v))
}

// ---- activity log, claims ----

/// Who performs a mutation and through which door (`cli` | `mcp`); `name` is a normalized agent name.
#[derive(Debug, Clone)]
pub struct Actor {
    pub name: String,
    pub source: &'static str,
    /// External client session the actions are done from; recorded in the log and on claims.
    pub session: Option<SessionRef>,
}

impl Actor {
    pub fn new(author: &str, source: &'static str) -> Self {
        Actor { name: normalize_agent(author), source, session: None }
    }

    /// Attach a (validated) external session.
    pub fn with_session(mut self, session: Option<SessionRef>) -> ApiResult<Actor> {
        self.session = session.map(SessionRef::normalize).transpose()?;
        Ok(self)
    }
}

/// `agent:Claude Code` -> `claude-code`: prefix stripped, lowercase, anything but `[a-z0-9._-]` becomes `-`,
/// at most 32 chars; empty -> `agent`.
pub fn normalize_agent(s: &str) -> String {
    let s = s.trim();
    let s = s.strip_prefix("agent:").unwrap_or(s);
    let n: String = s
        .to_lowercase()
        .chars()
        .map(|c| if matches!(c, 'a'..='z' | '0'..='9' | '.' | '_' | '-') { c } else { '-' })
        .take(32)
        .collect();
    if n.trim_matches('-').is_empty() { "agent".into() } else { n }
}

fn stage_key(task_id: &str) -> String {
    task_id.split('-').next().unwrap_or("").to_string()
}

fn stage_file(p: &Project, key: &str) -> String {
    format!("{}/stages/{key}.md", p.config.plan_dir.trim_end_matches('/'))
}

/// Write a log entry for a successful mutation. A failing log never fails the action:
/// the problem is returned as `log_warning` inside `v`.
pub fn log(p: &Project, a: &Actor, mut e: LogEntry, mut v: Value) -> Value {
    // Any action is a sign of life for the actor's claims.
    p.touch_claims(&a.name);
    e.author.clone_from(&a.name);
    e.source = a.source.into();
    if e.session.is_none() {
        e.session.clone_from(&a.session);
    }
    if let Err(err) = p.log_action(&e)
        && let Some(o) = v.as_object_mut()
    {
        o.insert("log_warning".into(), json!(format!("activity log not written: {err}")));
    }
    v
}

pub fn entry(action: &str, summary: impl Into<String>, stages: Vec<String>, tasks: Vec<String>, files: Vec<String>) -> LogEntry {
    LogEntry { action: action.into(), summary: summary.into(), stages, tasks, files, ..Default::default() }
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
}

/// Log the result of [`submit`] (nothing for a dry run; `propose` for review mode, else `action`).
pub fn log_submit(p: &Project, a: &Actor, action: &str, spec: &ApplySpec, v: Value) -> Value {
    let mode = v["mode"].as_str().unwrap_or("");
    if mode == "dry_run" {
        return v;
    }
    let r = &v["report"];
    let (created, updated) = (strings(&r["created"]), strings(&r["updated"]));
    let mut parts = Vec::new();
    if !created.is_empty() {
        parts.push(format!("created {}", created.join(", ")));
    }
    if !updated.is_empty() {
        parts.push(format!("updated {}", updated.join(", ")));
    }
    let tasks: Vec<String> = spec.stages.iter().flat_map(|s| s.tasks_done.iter().cloned()).collect();
    for (n, what) in [
        (tasks.len(), "task(s) done"),
        (spec.links.len(), "link(s)"),
        (spec.unlinks.len(), "unlink(s)"),
        (spec.comments.len(), "comment(s)"),
    ] {
        if n > 0 {
            parts.push(format!("{n} {what}"));
        }
    }
    let mut summary = if parts.is_empty() { "no changes".to_string() } else { parts.join("; ") };
    let action = if mode == "proposed" {
        summary = format!("proposed: {summary}");
        "propose"
    } else {
        action
    };
    let stages = created.into_iter().chain(updated).collect();
    log(p, a, entry(action, summary, stages, tasks, strings(&r["files"])), v)
}

pub fn claim_task(p: &Project, a: &Actor, task_id: &str, ttl_secs: u64, note: &str) -> ApiResult<Value> {
    let c = p.claim_task_with(task_id, &a.name, ttl_secs, note, a.session.as_ref())?;
    let e = entry("claim_task", format!("claimed {task_id}"), vec![stage_key(task_id)], vec![task_id.into()], vec![]);
    Ok(log(p, a, e, to_v(&c)))
}

pub fn release_task(p: &Project, a: &Actor, task_id: &str, force: bool) -> ApiResult<Value> {
    p.release_task(task_id, &a.name, force)?;
    let e = entry("release_task", format!("released {task_id}"), vec![stage_key(task_id)], vec![task_id.into()], vec![]);
    Ok(log(p, a, e, json!({"released": task_id})))
}

/// Live claims; `silent` = no sign of life for 10 minutes.
pub fn claims(p: &Project) -> ApiResult<Value> {
    let now = unix_now();
    let list: Vec<Value> = p
        .claims()?
        .iter()
        .map(|c| {
            let mut v = to_v(c);
            v["heartbeat_at"] = json!(c.last_seen());
            v["silent"] = json!(c.is_silent(now));
            v
        })
        .collect();
    Ok(json!({"claims": list}))
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(0))
}

/// "Still working": refresh the actor's claims (one task or all) and keep them alive. Not logged.
pub fn heartbeat(p: &Project, a: &Actor, task_id: Option<&str>, note: Option<&str>) -> ApiResult<Value> {
    let touched = p.heartbeat(&a.name, task_id, note)?;
    Ok(json!({"agent": a.name, "claims": touched}))
}

/// Record a gate's check result (`kind: gate`). A failing result reopens the gate; it is still logged.
pub fn set_gate(p: &Project, a: &Actor, key: &str, mut evidence: Evidence) -> ApiResult<Value> {
    if evidence.by.trim().is_empty() {
        evidence.by.clone_from(&a.name);
    }
    let cmd: String = evidence.command.chars().take(60).collect();
    let code = evidence.exit_code;
    let (s, passed) = p.set_gate_result(key, evidence)?;
    let v = json!({"stage": key, "passed": passed, "status": brief(&s, p)?});
    let summary = if passed { format!("gate {key} passed: {cmd}") } else { format!("gate {key} failed ({code}): {cmd}") };
    let e = entry("set_gate", summary, vec![key.into()], vec![], vec![stage_file(p, key)]);
    Ok(log(p, a, e, v))
}

/// An agent reports the tokens / cost of its work (optionally for a stage). Pathloom only stores and sums it.
pub fn report_usage(p: &Project, a: &Actor, usage: pathloom_core::Usage, stage: Option<&str>, note: &str) -> ApiResult<Value> {
    usage.validate()?;
    if let Some(k) = stage {
        p.load_stage(k)?;
    }
    let note = note.replace(['\r', '\n'], " ");
    let mut summary = format!("used {} in / {} out tokens", usage.tokens_in, usage.tokens_out);
    if let Some(c) = usage.cost_usd {
        summary.push_str(&format!(", ${c:.2}"));
    }
    if !note.trim().is_empty() {
        summary.push_str(&format!(" ({})", note.trim()));
    }
    let mut e = entry("usage", summary, stage.map(|k| vec![k.to_string()]).unwrap_or_default(), vec![], vec![]);
    e.usage = Some(usage);
    Ok(log(p, a, e, json!({"recorded": true})))
}

pub fn usage_summary(p: &Project) -> ApiResult<Value> {
    Ok(to_v(&p.usage_summary()?))
}

/// Import another tool's task list (`spec-kit`) through the normal apply path (review mode respected).
pub fn import(
    p: &Project,
    a: &Actor,
    text: &str,
    prefix: Option<&str>,
    board: Option<&str>,
    dry_run: bool,
    direct: bool,
) -> ApiResult<Value> {
    let (mut spec, report) = p.import_spec_kit(text, prefix)?;
    spec.board = board.map(String::from);
    let mut v = submit(p, &spec, &a.name, dry_run, direct)?;
    v["import"] = to_v(&report);
    Ok(log_submit(p, a, "import", &spec, v))
}

/// Latest log entries, newest first. `limit` 0 = 20, max 200.
pub fn activity(p: &Project, limit: usize, stage: Option<&str>) -> ApiResult<Value> {
    let limit = if limit == 0 { 20 } else { limit.min(200) };
    Ok(json!({"entries": p.read_log(limit, stage)?}))
}

/// `90s`, `30m`, `2h`, or a bare number of minutes -> seconds.
pub fn parse_ttl(s: &str) -> ApiResult<u64> {
    let s = s.trim();
    let (num, mult) = match s.chars().last() {
        Some('s') => (&s[..s.len() - 1], 1),
        Some('m') => (&s[..s.len() - 1], 60),
        Some('h') => (&s[..s.len() - 1], 3600),
        _ => (s, 60),
    };
    num.trim()
        .parse::<u64>()
        .ok()
        .filter(|n| *n > 0)
        .map(|n| n.saturating_mul(mult))
        .ok_or_else(|| ApiError::new("INVALID_SPEC", format!("bad ttl `{s}` (use 90s, 30m or 2h)")))
}

// ---- agent profiles, watch, skill ----

/// Fields of a profile to change; `None` keeps the current value (a new profile starts empty).
#[derive(Default)]
pub struct ProfilePatch {
    pub name: Option<String>,
    pub color: Option<String>,
    pub avatar: Option<String>,
    pub kind: Option<String>,
}

/// Create or update the profile `id`, merging `patch` into the existing one. Logged as `action`.
pub fn set_agent(p: &Project, a: &Actor, action: &str, id: &str, patch: ProfilePatch) -> ApiResult<Value> {
    let mut prof = p.agents()?.into_iter().find(|x| x.id == id).unwrap_or_else(|| AgentProfile { id: id.into(), ..Default::default() });
    if let Some(v) = patch.name {
        prof.name = v;
    }
    if let Some(v) = patch.color {
        prof.color = v;
    }
    if let Some(v) = patch.avatar {
        prof.avatar = v;
    }
    if let Some(v) = patch.kind {
        prof.kind = v;
    }
    let saved = p.upsert_agent(prof)?;
    let file = format!("{}/agents.json", p.config.plan_dir.trim_end_matches('/'));
    let e = entry(action, format!("profile of {}", saved.id), vec![], vec![], vec![file]);
    Ok(log(p, a, e, json!({"agent": saved})))
}

pub fn remove_agent(p: &Project, a: &Actor, id: &str) -> ApiResult<Value> {
    p.remove_agent(id)?;
    let file = format!("{}/agents.json", p.config.plan_dir.trim_end_matches('/'));
    let e = entry("agent remove", format!("removed profile of {id}"), vec![], vec![], vec![file]);
    Ok(log(p, a, e, json!({"removed": id})))
}

pub fn list_agents(p: &Project) -> ApiResult<Value> {
    Ok(json!({"agents": p.agents()?}))
}

/// `--since` value: `YYYY-MM-DDTHH:MM:SSZ` (or `...THH:MMZ`) -> the fixed-width 20-char form.
pub fn parse_since(s: &str) -> ApiResult<String> {
    let t = s.trim();
    let full = match t.len() {
        20 => t.to_string(),
        17 => format!("{}:00Z", &t[..16]),
        _ => String::new(),
    };
    let shape = "dddd-dd-ddTdd:dd:ddZ";
    let ok = full.len() == shape.len()
        && full.chars().zip(shape.chars()).all(|(c, m)| if m == 'd' { c.is_ascii_digit() } else { c == m });
    if ok { Ok(full) } else { Err(ApiError::new("INVALID_SPEC", format!("bad --since `{s}` (use 2026-11-05T10:00:00Z)"))) }
}

/// Log entries strictly newer than `since`, oldest first.
pub fn entries_since(p: &Project, since: &str) -> ApiResult<Vec<LogEntry>> {
    let mut v: Vec<LogEntry> = p.read_log(0, None)?.into_iter().filter(|e| e.at.as_str() > since).collect();
    v.reverse();
    Ok(v)
}

const SKILL_MD: &str = include_str!("../../../plugin/skills/pathloom/SKILL.md");

/// Write the Agent Skills file `<root>/<dir>/pathloom/SKILL.md`. An existing file is kept unless `force`.
pub fn install_skill(root: &Path, dir: &Path, force: bool) -> ApiResult<PathBuf> {
    if dir.is_absolute() || dir.components().any(|c| matches!(c, Component::ParentDir | Component::Prefix(_))) {
        return Err(ApiError::new("OUT_OF_PROJECT", format!("skill dir `{}` is outside the project", dir.display())));
    }
    let path = root.join(dir).join("pathloom").join("SKILL.md");
    if path.exists() && !force {
        return Err(ApiError::new("ALREADY_EXISTS", format!("{} exists (use --force to overwrite)", path.display())));
    }
    pathloom_core::write_file_atomic(&path, SKILL_MD.as_bytes()).map_err(|e| ApiError::new("IO_ERROR", e.to_string()))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn since_formats() {
        assert_eq!(parse_since("2026-11-05T10:00:00Z").unwrap(), "2026-11-05T10:00:00Z");
        assert_eq!(parse_since("2026-11-05T10:00Z").unwrap(), "2026-11-05T10:00:00Z");
        for bad in ["", "yesterday", "2026-11-05", "2026-11-05T10:00:00+02:00", "2026-11-05 10:00:00Z"] {
            assert!(parse_since(bad).is_err(), "{bad}");
        }
    }
}
