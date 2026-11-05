//! Tauri shell: thin commands over `pathloom-core`. All file access goes through the core;
//! the WebView has no filesystem permissions.

mod recent;
mod watch;

use std::path::Path;
use std::sync::{LazyLock, Mutex};

use pathloom_core::{AgentChanges, AgentProfile, ApplyReport, Board, Claim, LogEntry, Project, Proposal, StageMeta, StageView, Task};
use tauri_plugin_opener::OpenerExt;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

#[derive(Default)]
struct AppState {
    project: Mutex<Option<Project>>,
    watcher: Mutex<Option<watch::ProjectWatcher>>,
}

/// Last known plan file contents, for "undo agent changes". One project is open at a time.
static SNAPSHOT: LazyLock<Mutex<watch::Snapshot>> = LazyLock::new(Default::default);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectSnapshot {
    root: String,
    name: String,
    boards: Vec<String>,
    stages: Vec<StageView>,
}

type CmdResult<T> = Result<T, String>;

fn with_project<T>(
    state: &State<'_, AppState>,
    f: impl FnOnce(&Project) -> pathloom_core::Result<T>,
) -> CmdResult<T> {
    let guard = state.project.lock().map_err(|_| "internal state poisoned".to_string())?;
    let project = guard.as_ref().ok_or_else(|| "no project is open".to_string())?;
    f(project).map_err(|e| e.to_string())
}

fn views(p: &Project) -> pathloom_core::Result<Vec<StageView>> {
    p.stage_views_live()
}

fn snapshot(p: &Project) -> pathloom_core::Result<ProjectSnapshot> {
    Ok(ProjectSnapshot {
        root: p.root.display().to_string(),
        name: p.config.name.clone(),
        boards: p.list_boards()?,
        stages: views(p)?,
    })
}

fn activate(app: &AppHandle, state: &State<'_, AppState>, project: Project) -> CmdResult<ProjectSnapshot> {
    let snap = snapshot(&project).map_err(|e| e.to_string())?;
    // Recent list is a convenience; failing to write it must not block opening the project.
    let _ = recent::remember(app, &snap.root, &snap.name);
    let plan_dir = project.plan_dir();
    if let Ok(mut s) = SNAPSHOT.lock() {
        *s = watch::Snapshot::capture(&plan_dir);
    }
    // Live reload is best effort: the app still works without it.
    let watcher = watch::start(app.clone(), project.root.clone(), plan_dir, &SNAPSHOT).ok();
    *state.watcher.lock().map_err(|_| "internal state poisoned".to_string())? = watcher;
    *state.project.lock().map_err(|_| "internal state poisoned".to_string())? = Some(project);
    Ok(snap)
}

#[tauri::command]
fn project_create(app: AppHandle, state: State<'_, AppState>, path: String, name: String) -> CmdResult<ProjectSnapshot> {
    let project = Project::init(Path::new(&path), &name).map_err(|e| e.to_string())?;
    activate(&app, &state, project)
}

#[tauri::command]
fn project_open(app: AppHandle, state: State<'_, AppState>, path: String) -> CmdResult<ProjectSnapshot> {
    let project = Project::open(Path::new(&path)).map_err(|e| e.to_string())?;
    activate(&app, &state, project)
}

/// Creates (or reopens) a sample project in the app data folder, in the UI language.
#[tauri::command]
fn demo_open(app: AppHandle, state: State<'_, AppState>, lang: String) -> CmdResult<ProjectSnapshot> {
    let uk = lang.starts_with("uk");
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join(if uk { "demo-uk" } else { "demo-en" });
    let project = match Project::open(&dir) {
        Ok(p) => p,
        Err(_) => {
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let p = Project::init(&dir, if uk { "Демо: мій перший застосунок" } else { "Demo: my first app" }).map_err(|e| e.to_string())?;
            let text = if uk { include_str!("../demo/demo.uk.yaml") } else { include_str!("../demo/demo.en.yaml") };
            let spec = Project::parse_spec(text).map_err(|e| e.to_string())?;
            let opts = pathloom_core::ApplyOptions { dry_run: false, author: "agent:claude".into() };
            p.apply(&spec, &opts).map_err(|e| e.to_string())?;
            p
        }
    };
    activate(&app, &state, project)
}

#[tauri::command]
fn recent_projects(app: AppHandle) -> Vec<recent::RecentProject> {
    recent::load(&app)
}

#[tauri::command]
fn board_load(state: State<'_, AppState>, name: String) -> CmdResult<Board> {
    with_project(&state, |p| p.load_board(&name))
}

#[tauri::command]
fn board_save(state: State<'_, AppState>, name: String, board: Board) -> CmdResult<()> {
    with_project(&state, |p| p.save_board(&name, &board))
}

#[tauri::command]
fn board_create(state: State<'_, AppState>, name: String, title: String) -> CmdResult<Board> {
    with_project(&state, |p| p.create_board(&name, &title))
}

#[tauri::command]
fn boards_list(state: State<'_, AppState>) -> CmdResult<Vec<String>> {
    with_project(&state, |p| p.list_boards())
}

#[tauri::command]
fn stages_list(state: State<'_, AppState>) -> CmdResult<Vec<StageView>> {
    with_project(&state, views)
}

#[tauri::command]
fn stage_create(state: State<'_, AppState>, title: String) -> CmdResult<StageView> {
    with_project(&state, |p| {
        let stage = p.create_stage(&title, None)?;
        let all = views(p)?;
        Ok(all.into_iter().find(|v| v.stage.key == stage.key))
    })?
    .ok_or_else(|| "created stage not found".to_string())
}

fn find_done(tasks: &[Task], id: &str) -> Option<bool> {
    tasks.iter().find_map(|t| {
        if t.id == id {
            Some(if t.sub.is_empty() { t.done } else { t.sub.iter().all(|s| s.done) })
        } else {
            find_done(&t.sub, id)
        }
    })
}

#[tauri::command]
fn task_toggle(state: State<'_, AppState>, task_id: String) -> CmdResult<Vec<StageView>> {
    with_project(&state, |p| {
        let done = p
            .load_stages()?
            .iter()
            .find_map(|s| find_done(&s.tasks, &task_id))
            .ok_or_else(|| pathloom_core::Error::NotFound(task_id.clone()))?;
        p.set_task_done(&task_id, !done)?;
        views(p)
    })
}

#[tauri::command]
fn task_add(state: State<'_, AppState>, key: String, title: String) -> CmdResult<Vec<StageView>> {
    with_project(&state, |p| {
        p.add_task(&key, &title)?;
        views(p)
    })
}

#[tauri::command]
fn stage_rename(state: State<'_, AppState>, key: String, title: String) -> CmdResult<Vec<StageView>> {
    with_project(&state, |p| {
        p.set_title(&key, &title)?;
        views(p)
    })
}

#[tauri::command]
fn stage_update(state: State<'_, AppState>, key: String, meta: StageMeta) -> CmdResult<Vec<StageView>> {
    with_project(&state, |p| {
        p.update_meta(&key, meta)?;
        views(p)
    })
}

#[tauri::command]
fn stage_source(state: State<'_, AppState>, key: String) -> CmdResult<String> {
    with_project(&state, |p| p.stage_source(&key))
}

#[tauri::command]
fn stage_delete(state: State<'_, AppState>, key: String) -> CmdResult<Vec<StageView>> {
    with_project(&state, |p| {
        p.delete_stage(&key)?;
        views(p)
    })
}

#[tauri::command]
fn task_rename(state: State<'_, AppState>, task_id: String, title: String) -> CmdResult<Vec<StageView>> {
    with_project(&state, |p| {
        p.rename_task(&task_id, &title)?;
        views(p)
    })
}

#[tauri::command]
fn task_remove(state: State<'_, AppState>, task_id: String) -> CmdResult<Vec<StageView>> {
    with_project(&state, |p| {
        p.remove_task(&task_id)?;
        views(p)
    })
}

#[tauri::command]
fn subtask_add(state: State<'_, AppState>, task_id: String, title: String) -> CmdResult<Vec<StageView>> {
    with_project(&state, |p| {
        p.add_subtask(&task_id, &title)?;
        views(p)
    })
}

/// Reverts one group of external (agent) changes reported by `plan-changed`.
#[tauri::command]
fn agent_undo(state: State<'_, AppState>, group: u64) -> CmdResult<Vec<StageView>> {
    let touched = SNAPSHOT.lock().map_err(|_| "internal state poisoned".to_string())?.revert(group).map_err(|e| e.to_string())?;
    with_project(&state, |p| {
        let files = touched.iter().filter_map(|f| f.strip_prefix(&p.root).ok()).map(|f| f.to_string_lossy().replace('\\', "/")).collect();
        log_app(p, "undo", "undid external changes", vec![], files);
        views(p)
    })
}

/// Records an action done in the app in the activity log. Logging never fails the action.
fn log_app(p: &Project, action: &str, summary: &str, stages: Vec<String>, files: Vec<String>) {
    let entry = LogEntry {
        at: pathloom_core::now_rfc3339(),
        author: "me".into(),
        source: "app".into(),
        action: action.into(),
        summary: summary.into(),
        stages,
        tasks: vec![],
        files,
        ..Default::default()
    };
    let _ = p.log_action(&entry);
}

#[tauri::command]
fn activity(state: State<'_, AppState>, limit: usize, stage: Option<String>) -> CmdResult<Vec<LogEntry>> {
    with_project(&state, |p| p.read_log(limit.min(500), stage.as_deref()))
}

#[tauri::command]
fn agents_list(state: State<'_, AppState>) -> CmdResult<Vec<AgentProfile>> {
    with_project(&state, |p| p.agents())
}

/// Opens an external session link (http/https or an app's own scheme) after the UI asked the user.
/// Never opens javascript:, data:, file: or anything without a scheme.
#[tauri::command]
fn open_url(app: AppHandle, url: String) -> CmdResult<()> {
    let scheme = url.split_once("://").map(|(s, _)| s.to_ascii_lowercase()).ok_or("not a URL")?;
    let valid_scheme = !scheme.is_empty()
        && scheme.chars().next().is_some_and(|c| c.is_ascii_lowercase())
        && scheme.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '+' | '.' | '-'));
    if !valid_scheme || matches!(scheme.as_str(), "javascript" | "data" | "file" | "vbscript") || url.len() > 2048 {
        return Err("this link type can't be opened".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// Open a project-relative artifact file with the system's default app (paths outside the project fail).
#[tauri::command]
fn artifact_open(app: AppHandle, state: State<'_, AppState>, path: String) -> CmdResult<()> {
    let full = with_project(&state, |p| p.artifact_path(&path))?;
    app.opener().open_path(full.display().to_string(), None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn usage_summary(state: State<'_, AppState>) -> CmdResult<pathloom_core::UsageSummary> {
    with_project(&state, |p| p.usage_summary())
}

/// Run a gate's `check` in the project folder (after the user confirmed it in the UI) and record the result.
#[tauri::command]
async fn gate_run(state: State<'_, AppState>, key: String) -> CmdResult<Vec<StageView>> {
    let p = with_project(&state, |p| Ok(p.clone()))?;
    let check = p.load_stage(&key).map_err(|e| e.to_string())?.check.ok_or("this gate has no check command")?;
    let (root, cmd) = (p.root.clone(), check.clone());
    let (code, ms) = tauri::async_runtime::spawn_blocking(move || {
        let mut c = if cfg!(windows) {
            let mut c = std::process::Command::new("cmd");
            c.args(["/C", &cmd]);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
            }
            c
        } else {
            let mut c = std::process::Command::new("sh");
            c.args(["-c", &cmd]);
            c
        };
        let start = std::time::Instant::now();
        let out = c.current_dir(root).output();
        (out.map(|o| o.status.code().unwrap_or(-1)), u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX))
    })
    .await
    .map_err(|e| e.to_string())?;
    let code = code.map_err(|e| format!("cannot run `{check}`: {e}"))?;
    let ev = pathloom_core::Evidence {
        command: check.clone(),
        exit_code: code,
        duration_ms: Some(ms),
        summary: None,
        log: None,
        at: String::new(),
        by: "me".into(),
    };
    let (_, passed) = p.set_gate_result(&key, ev).map_err(|e| e.to_string())?;
    let summary = if passed { format!("gate {key} passed: {check}") } else { format!("gate {key} failed ({code}): {check}") };
    log_app(&p, "set_gate", &summary, vec![key], vec![]);
    if !passed {
        return Err(format!("`{check}` exited with {code}: the gate stays open"));
    }
    views(&p).map_err(|e| e.to_string())
}

#[tauri::command]
fn claims_list(state: State<'_, AppState>) -> CmdResult<Vec<Claim>> {
    with_project(&state, |p| p.claims())
}

/// The owner frees a task an agent has claimed (always forced: the human decides).
#[tauri::command]
fn claim_release(state: State<'_, AppState>, task_id: String) -> CmdResult<Vec<StageView>> {
    with_project(&state, |p| {
        p.release_task(&task_id, "me", true)?;
        let key = task_id.split('-').next().unwrap_or_default().to_string();
        log_app(p, "release_task", &format!("released {task_id}"), vec![key], vec![]);
        views(p)
    })
}

/// Max size of one pasted/dropped image.
const MAX_ASSET_BYTES: usize = 25 * 1024 * 1024;

/// Stores an image in plan/assets/<hash>.<ext> and returns "assets/<file>" (path relative to plan/).
#[tauri::command]
fn asset_save(state: State<'_, AppState>, name: String, bytes: Vec<u8>) -> CmdResult<String> {
    if bytes.len() > MAX_ASSET_BYTES {
        return Err("image is larger than 25 MB".into());
    }
    let ext = Path::new(&name)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|e| matches!(e.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp"))
        .unwrap_or_else(|| "png".into());
    let hash = pathloom_core::hash_bytes(&bytes);
    let file = format!("{}.{ext}", &hash[..16]);
    with_project(&state, |p| {
        let dir = p.plan_dir().join("assets");
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(&file);
        if !path.exists() {
            pathloom_core::write_file_atomic(&path, &bytes)?;
        }
        Ok(format!("assets/{file}"))
    })
}

/// Serves plan/assets/* of the open project for <img> (custom `plasset` scheme). Nothing outside it.
fn serve_asset(app: &AppHandle, uri_path: &str) -> tauri::http::Response<Vec<u8>> {
    let not_found = || tauri::http::Response::builder().status(404).body(Vec::new()).unwrap_or_default();
    let state = app.state::<AppState>();
    let Ok(guard) = state.project.lock() else { return not_found() };
    let Some(project) = guard.as_ref() else { return not_found() };
    let assets = project.plan_dir().join("assets");
    let rel: String = uri_path.trim_start_matches('/').split('/').map(percent_decode).collect::<Vec<_>>().join("/");
    let Some(rel) = rel.strip_prefix("assets/") else { return not_found() };
    let (Ok(base), Ok(full)) = (assets.canonicalize(), assets.join(rel).canonicalize()) else { return not_found() };
    if !full.starts_with(&base) {
        return not_found();
    }
    let Ok(body) = std::fs::read(&full) else { return not_found() };
    let mime = match full.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("bmp") => "image/bmp",
        _ => "application/octet-stream",
    };
    tauri::http::Response::builder()
        .header("Content-Type", mime)
        .header("Cache-Control", "max-age=31536000, immutable")
        .body(body)
        .unwrap_or_default()
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len()
            && let Some(v) = std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Custom themes: every *.json in <project>/.pathloom/themes and <app config>/themes (raw JSON, validated in the UI).
#[tauri::command]
fn themes_list(app: AppHandle, state: State<'_, AppState>) -> Vec<serde_json::Value> {
    let mut dirs = Vec::new();
    if let Ok(guard) = state.project.lock()
        && let Some(p) = guard.as_ref() {
            dirs.push(p.root.join(".pathloom").join("themes"));
        }
    if let Ok(dir) = app.path().app_config_dir() {
        dirs.push(dir.join("themes"));
    }
    let mut out = Vec::new();
    for dir in dirs {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let path = e.path();
            if path.extension().is_some_and(|x| x == "json") {
                // A theme file is small; ignore anything large or unreadable.
                let ok_size = e.metadata().map(|m| m.len() < 64 * 1024).unwrap_or(false);
                if let (true, Ok(text)) = (ok_size, std::fs::read_to_string(&path))
                    && let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                        out.push(v);
                    }
            }
        }
    }
    out
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentSetup {
    /// Absolute path of the bundled `pathloom` CLI (next to the app executable), if present.
    cli_path: Option<String>,
    /// "auto" or "review" for the open project.
    agent_changes: String,
    /// Agents must attach passing evidence to close tasks.
    require_evidence: bool,
}

#[tauri::command]
fn agent_setup(state: State<'_, AppState>) -> AgentSetup {
    let exe = if cfg!(windows) { "pathloom.exe" } else { "pathloom" };
    let cli_path = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join(exe)))
        .filter(|p| p.is_file())
        .map(|p| p.display().to_string());
    let agent_changes = state
        .project
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|p| p.config.agent_changes))
        .map_or("auto", |m| if m == AgentChanges::Review { "review" } else { "auto" })
        .to_string();
    let require_evidence =
        state.project.lock().ok().and_then(|g| g.as_ref().map(|p| p.config.require_evidence)).unwrap_or(false);
    AgentSetup { cli_path, agent_changes, require_evidence }
}

#[tauri::command]
fn set_agent_changes(state: State<'_, AppState>, review: bool) -> CmdResult<()> {
    let mut guard = state.project.lock().map_err(|_| "internal state poisoned".to_string())?;
    let project = guard.as_mut().ok_or_else(|| "no project is open".to_string())?;
    project
        .set_agent_changes(if review { AgentChanges::Review } else { AgentChanges::Auto })
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_require_evidence(state: State<'_, AppState>, on: bool) -> CmdResult<()> {
    let mut guard = state.project.lock().map_err(|_| "internal state poisoned".to_string())?;
    let project = guard.as_mut().ok_or_else(|| "no project is open".to_string())?;
    project.set_require_evidence(on).map_err(|e| e.to_string())
}

#[tauri::command]
fn proposals_list(state: State<'_, AppState>) -> CmdResult<Vec<Proposal>> {
    with_project(&state, |p| p.list_proposals())
}

#[tauri::command]
fn proposal_accept(state: State<'_, AppState>, id: String) -> CmdResult<ApplyReport> {
    with_project(&state, |p| {
        let report = p.accept_proposal(&id)?;
        let stages = report.created.iter().chain(&report.updated).cloned().collect();
        log_app(p, "accept_proposal", &format!("accepted proposal {id}"), stages, report.files.clone());
        Ok(report)
    })
}

#[tauri::command]
fn proposal_reject(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    with_project(&state, |p| {
        p.reject_proposal(&id)?;
        log_app(p, "reject_proposal", &format!("rejected proposal {id}"), vec![], vec![]);
        Ok(())
    })
}

#[tauri::command]
fn stage_link(state: State<'_, AppState>, from: String, to: String) -> CmdResult<Vec<StageView>> {
    with_project(&state, |p| {
        p.link(&from, &to, false)?;
        views(p)
    })
}

#[tauri::command]
fn stage_unlink(state: State<'_, AppState>, from: String, to: String) -> CmdResult<Vec<StageView>> {
    with_project(&state, |p| {
        p.unlink(&from, &to)?;
        views(p)
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .register_uri_scheme_protocol("plasset", |ctx, request| serve_asset(ctx.app_handle(), request.uri().path()))
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            project_create,
            project_open,
            recent_projects,
            demo_open,
            board_load,
            board_save,
            board_create,
            boards_list,
            stages_list,
            stage_create,
            task_toggle,
            task_add,
            stage_rename,
            agent_undo,
            activity,
            claims_list,
            agents_list,
            open_url,
            claim_release,
            asset_save,
            themes_list,
            agent_setup,
            set_agent_changes,
            set_require_evidence,
            artifact_open,
            usage_summary,
            gate_run,
            proposals_list,
            proposal_accept,
            proposal_reject,
            stage_update,
            stage_source,
            stage_delete,
            task_rename,
            task_remove,
            subtask_add,
            stage_link,
            stage_unlink,
        ])
        .run(tauri::generate_context!());
    if let Err(err) = result {
        eprintln!("Pathloom failed to start: {err}");
        std::process::exit(1);
    }
}
