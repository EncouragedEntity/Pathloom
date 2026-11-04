//! Watches the open project's plan files and tells the UI what changed outside the app
//! (AI agents, CLI, git checkout, text editors). Own writes are ignored via `pathloom_core::writes`.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify::RecursiveMode;
use notify_debouncer_full::{DebounceEventResult, Debouncer, RecommendedCache, new_debouncer};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Payload of the `plan-changed` event.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlanChanged {
    pub stages: Vec<String>,
    pub boards: Vec<String>,
    pub proposals: bool,
    /// Id of the undo group that can revert these changes, if any file content changed.
    pub group: Option<u64>,
}

/// One group of external changes that can be reverted: previous content per file (None = file didn't exist).
struct UndoGroup {
    id: u64,
    at: Instant,
    before: HashMap<PathBuf, Option<Vec<u8>>>,
}

/// Last known content of every plan file + recent groups of external changes.
#[derive(Default)]
pub struct Snapshot {
    files: HashMap<PathBuf, Vec<u8>>,
    groups: Vec<UndoGroup>,
    next_id: u64,
}

const GROUP_WINDOW: Duration = Duration::from_secs(3);
const MAX_GROUPS: usize = 20;

impl Snapshot {
    pub fn capture(plan_dir: &Path) -> Self {
        let mut s = Snapshot::default();
        collect(plan_dir, &mut s.files);
        s
    }

    /// Records the new content of `path`, returning the undo group id the change joined.
    fn observe(&mut self, path: &Path) -> Option<u64> {
        let now = std::fs::read(path).ok();
        let prev = self.files.get(path).cloned();
        if now == prev {
            return None;
        }
        let join = self.groups.last().is_some_and(|g| g.at.elapsed() < GROUP_WINDOW);
        if !join {
            self.next_id += 1;
            self.groups.push(UndoGroup { id: self.next_id, at: Instant::now(), before: HashMap::new() });
            if self.groups.len() > MAX_GROUPS {
                self.groups.remove(0);
            }
        }
        let group = self.groups.last_mut()?;
        group.at = Instant::now();
        group.before.entry(path.to_path_buf()).or_insert(prev);
        match now {
            Some(bytes) => self.files.insert(path.to_path_buf(), bytes),
            None => self.files.remove(path),
        };
        Some(group.id)
    }

    /// Restores every file of the group to its previous content. Returns the touched paths.
    pub fn revert(&mut self, id: u64) -> std::io::Result<Vec<PathBuf>> {
        let Some(pos) = self.groups.iter().position(|g| g.id == id) else { return Ok(vec![]) };
        let group = self.groups.remove(pos);
        let mut touched = Vec::new();
        for (path, before) in group.before {
            match &before {
                Some(bytes) => pathloom_core::write_file_atomic(&path, bytes)?,
                None => {
                    if path.exists() {
                        std::fs::remove_file(&path)?;
                    }
                }
            }
            match before {
                Some(bytes) => self.files.insert(path.clone(), bytes),
                None => self.files.remove(&path),
            };
            touched.push(path);
        }
        Ok(touched)
    }

    /// Our own writes: keep the snapshot current without creating undo groups.
    pub fn refresh(&mut self, path: &Path) {
        match std::fs::read(path) {
            Ok(b) => self.files.insert(path.to_path_buf(), b),
            Err(_) => self.files.remove(path),
        };
    }
}

fn collect(dir: &Path, out: &mut HashMap<PathBuf, Vec<u8>>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            collect(&p, out);
        } else if is_plan_file(&p)
            && let Ok(b) = std::fs::read(&p) {
                out.insert(p, b);
            }
    }
}

fn is_plan_file(p: &Path) -> bool {
    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
    name.ends_with(".md") || name.ends_with(".board.json")
}

pub type ProjectWatcher = Debouncer<notify::RecommendedWatcher, RecommendedCache>;

/// Starts watching `plan_dir` and `.pathloom/proposals`. Drop the returned watcher to stop.
pub fn start(app: AppHandle, root: PathBuf, plan_dir: PathBuf, snapshot: &'static Mutex<Snapshot>) -> notify::Result<ProjectWatcher> {
    let proposals = root.join(".pathloom").join("proposals");
    let proposals_dir = proposals.clone();
    let boards_dir = plan_dir.join("boards");
    let stages_dir = plan_dir.join("stages");
    let mut debouncer = new_debouncer(Duration::from_millis(200), None, move |res: DebounceEventResult| {
        let Ok(events) = res else { return };
        let mut paths = BTreeSet::new();
        for ev in events {
            for p in &ev.event.paths {
                paths.insert(p.clone());
            }
        }
        let mut out = PlanChanged::default();
        let Ok(mut snap) = snapshot.lock() else { return };
        for p in paths {
            if p.starts_with(&proposals) {
                out.proposals = true;
                continue;
            }
            if !is_plan_file(&p) {
                continue;
            }
            // Ignore writes made by this process (the app itself).
            let own = std::fs::read(&p).map(|b| pathloom_core::writes::is_own(&p, &pathloom_core::hash_bytes(&b))).unwrap_or(false);
            if own {
                snap.refresh(&p);
                continue;
            }
            let Some(group) = snap.observe(&p) else { continue };
            out.group = Some(group);
            if p.starts_with(&stages_dir) {
                if let Some(key) = p.file_stem().and_then(|s| s.to_str()) {
                    out.stages.push(key.to_string());
                }
            } else if p.starts_with(&boards_dir)
                && let Ok(rel) = p.strip_prefix(&boards_dir) {
                    let name = rel.to_string_lossy().replace('\\', "/");
                    out.boards.push(name.trim_end_matches(".board.json").to_string());
                }
        }
        drop(snap);
        if !out.stages.is_empty() || !out.boards.is_empty() || out.proposals {
            let _ = app.emit("plan-changed", out);
        }
    })?;
    debouncer.watch(&plan_dir, RecursiveMode::Recursive)?;
    if std::fs::create_dir_all(&proposals_dir).is_ok() {
        debouncer.watch(&proposals_dir, RecursiveMode::NonRecursive)?;
    }
    Ok(debouncer)
}
