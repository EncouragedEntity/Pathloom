//! Recently opened projects, stored in the app config dir (not in any project).

use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const MAX_RECENT: usize = 12;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub path: String,
    pub name: String,
    pub opened_at: u64,
}

fn file(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("recent.json"))
}

pub fn load(app: &AppHandle) -> Vec<RecentProject> {
    file(app)
        .and_then(|f| fs::read_to_string(f).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Drop `path` from the list (the project folder itself is not touched).
pub fn forget(app: &AppHandle, path: &str) -> std::io::Result<()> {
    let Some(f) = file(app) else { return Ok(()) };
    let mut list = load(app);
    list.retain(|r| r.path != path);
    fs::write(f, serde_json::to_string_pretty(&list).unwrap_or_default())
}

pub fn remember(app: &AppHandle, path: &str, name: &str) -> std::io::Result<()> {
    let Some(f) = file(app) else { return Ok(()) };
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let mut list = load(app);
    list.retain(|r| r.path != path);
    list.insert(0, RecentProject { path: path.to_string(), name: name.to_string(), opened_at: now });
    list.truncate(MAX_RECENT);
    if let Some(dir) = f.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(f, serde_json::to_string_pretty(&list).unwrap_or_default())
}
