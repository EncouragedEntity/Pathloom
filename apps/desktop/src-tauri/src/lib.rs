//! Tauri shell: thin commands over `pathloom-core`. All file access goes through the core;
//! the WebView has no filesystem permissions.

mod recent;
mod watch;

use std::path::Path;
use std::sync::{LazyLock, Mutex};

use pathloom_core::{ApplyReport, Board, Project, Proposal, StageMeta, StageView, Task};
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
    Ok(pathloom_core::stage_views(&p.load_stages()?))
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
    let _ = touched;
    with_project(&state, views)
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

#[tauri::command]
fn proposals_list(state: State<'_, AppState>) -> CmdResult<Vec<Proposal>> {
    with_project(&state, |p| p.list_proposals())
}

#[tauri::command]
fn proposal_accept(state: State<'_, AppState>, id: String) -> CmdResult<ApplyReport> {
    with_project(&state, |p| p.accept_proposal(&id))
}

#[tauri::command]
fn proposal_reject(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    with_project(&state, |p| p.reject_proposal(&id))
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
        .register_uri_scheme_protocol("plasset", |ctx, request| serve_asset(ctx.app_handle(), request.uri().path()))
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            project_create,
            project_open,
            recent_projects,
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
            asset_save,
            themes_list,
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
