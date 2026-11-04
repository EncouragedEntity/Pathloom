//! Operations shared by the CLI and the MCP server. Everything returns JSON values and `ApiError`.

use pathloom_core::{
    ApplyOptions, ApplySpec, Error, Project, Stage, StageView, Status, Who, compute_statuses, stage_views,
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
    serde_json::from_value(json!(s)).map_err(|_| ApiError::new("INVALID_SPEC", format!("unknown who `{s}` (me|ai|both)")))
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
        .filter(|v| f.who.is_none_or(|w| w == v.stage.who))
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
    if let Some(o) = v.as_object_mut() {
        o.insert("hash".into(), json!(hash));
    }
    Ok(v)
}

pub fn project_info(p: &Project, read_only: bool) -> ApiResult<Value> {
    let stages = p.load_stages()?;
    let statuses = compute_statuses(&stages);
    let count = |s: Status| statuses.values().filter(|x| **x == s).count();
    Ok(json!({
        "name": p.config.name, "root": p.root.to_string_lossy(), "plan_dir": p.config.plan_dir,
        "agent_changes": to_v(&p.config.agent_changes), "read_only": read_only,
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

pub fn set_task(p: &Project, task_id: &str, done: bool) -> ApiResult<Value> {
    let s = p.set_task_done(task_id, done)?;
    Ok(json!({"task_id": task_id, "done": done, "stage": brief(&s, p)?}))
}

pub fn add_comment(p: &Project, key: &str, author: &str, text: &str) -> ApiResult<Value> {
    let s = p.add_comment(key, author, text)?;
    Ok(json!({"stage": s.key, "comments": s.comments.len(), "author": author}))
}

fn brief(s: &Stage, p: &Project) -> ApiResult<Value> {
    let all = p.load_stages()?;
    let v = stage_views(&all).into_iter().find(|v| v.stage.key == s.key);
    Ok(v.map(|v| row(&v)).unwrap_or(Value::Null))
}

pub fn layout(p: &Project, board: &str, only_new: &[String]) -> ApiResult<Value> {
    let b = p.layout_board(board, only_new)?;
    let cards: Vec<Value> = b
        .elements
        .iter()
        .filter(|e| e.get("type").and_then(Value::as_str) == Some("card"))
        .map(|e| json!({"key": e.get("ref"), "x": e.get("x"), "y": e.get("y")}))
        .collect();
    Ok(json!({"board": board, "cards": cards}))
}

pub fn validate(p: &Project, fix: bool) -> ApiResult<Value> {
    let fixed = if fix { p.validate_fix()? } else { vec![] };
    let issues = p.validate()?;
    Ok(json!({"ok": issues.is_empty(), "issues": issues, "fixed": fixed}))
}
