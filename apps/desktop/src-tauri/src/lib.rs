//! Tauri shell: thin commands over `pathloom-core`. All file access goes through the core;
//! the WebView has no filesystem permissions.

mod recent;

use std::path::Path;
use std::sync::Mutex;

use pathloom_core::{Board, Project, StageView, Task};
use serde::Serialize;
use tauri::{AppHandle, State};

#[derive(Default)]
struct AppState {
    project: Mutex<Option<Project>>,
}

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
            stage_link,
            stage_unlink,
        ])
        .run(tauri::generate_context!());
    if let Err(err) = result {
        eprintln!("Pathloom failed to start: {err}");
        std::process::exit(1);
    }
}
