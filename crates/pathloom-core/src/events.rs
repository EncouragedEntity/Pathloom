//! Project event stream (m7 contract §3): a file watcher that turns changes of the plan, claims, agents,
//! proposals and the activity log into typed [`Event`]s. Used by `pathloom watch`.
//!
//! Changes are detected by content hash against a snapshot taken at start, so spurious file-system
//! notifications (touch, identical rewrite) produce no event. The activity log is tailed by byte offset.

use crate::claims::Claim;
use crate::error::{Error, Result};
use crate::fsutil::now_rfc3339;
use crate::hash::hash_bytes;
use crate::log::LogEntry;
use crate::project::Project;
use notify::{EventKind, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{DebounceEventResult, Debouncer, RecommendedCache, new_debouncer};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::Duration;

/// Debounce window of the watcher.
pub const DEBOUNCE_MS: u64 = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Change {
    Created,
    Updated,
    Deleted,
}

impl Change {
    fn as_str(self) -> &'static str {
        match self {
            Change::Created => "created",
            Change::Updated => "updated",
            Change::Deleted => "deleted",
        }
    }
}

/// One event of the stream. Serialized with a `type` tag (`{"type":"stage","key":"AUTH",...}`).
#[allow(clippy::large_enum_variant)] // API shape matters more than 200 bytes per event
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Event {
    Hello { protocol: String, version: String, at: String },
    Stage { key: String, change: Change, at: String },
    Board { name: String, change: Change, at: String },
    /// The current live claims (the whole list, after a change of `claims.json`).
    Claims { claims: Vec<Claim>, at: String },
    /// A new line of the activity log.
    Activity { entry: LogEntry },
    Proposal { id: String, change: Change, at: String },
    Agents { at: String },
}

impl Event {
    /// The first event of every stream.
    pub fn hello() -> Event {
        Event::Hello { protocol: crate::PROTOCOL.into(), version: env!("CARGO_PKG_VERSION").into(), at: now_rfc3339() }
    }

    /// One JSON object, no trailing newline.
    pub fn to_json_line(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

/// Short human format (`pathloom watch` without `--json`).
impl std::fmt::Display for Event {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Event::Hello { protocol, version, at } => write!(f, "{at}  hello {protocol} (pathloom {version})"),
            Event::Stage { key, change, at } => write!(f, "{at}  stage {key} {}", change.as_str()),
            Event::Board { name, change, at } => write!(f, "{at}  board {name} {}", change.as_str()),
            Event::Claims { claims, at } => {
                let ids: Vec<String> = claims.iter().map(|c| format!("{} ({})", c.task_id, c.agent)).collect();
                write!(f, "{at}  claims: {}", if ids.is_empty() { "none".into() } else { ids.join(", ") })
            }
            Event::Activity { entry: e } => {
                write!(f, "{}  activity {} {} {}: {}", e.at, e.author, e.source, e.action, e.summary)
            }
            Event::Proposal { id, change, at } => write!(f, "{at}  proposal {id} {}", change.as_str()),
            Event::Agents { at } => write!(f, "{at}  agents changed"),
        }
    }
}

/// Watches a project and yields [`Event`]s. Dropping it stops the watcher.
pub struct EventWatcher {
    _debouncer: Debouncer<RecommendedWatcher, RecommendedCache>,
    rx: Receiver<Event>,
}

impl EventWatcher {
    /// Start watching `project`. Missing watched folders (`proposals/`, `log/`, `stages/`, `boards/`) are created.
    /// The snapshot that changes are compared with is taken here, before this returns.
    pub fn start(project: &Project) -> Result<EventWatcher> {
        let io = |e: notify::Error| Error::Io(std::io::Error::other(e));
        let dirs = Dirs::prepare(project)?;
        let (tx, rx) = channel();
        let mut tracker = Tracker::new(project.clone(), &dirs);
        let mut debouncer = new_debouncer(Duration::from_millis(DEBOUNCE_MS), None, move |res: DebounceEventResult| {
            let Ok(events) = res else { return };
            let mut paths: Vec<PathBuf> = Vec::new();
            for e in events {
                if matches!(e.event.kind, EventKind::Access(_)) {
                    continue;
                }
                for p in &e.event.paths {
                    if !paths.contains(p) {
                        paths.push(p.clone());
                    }
                }
            }
            tracker.process(&paths, &tx);
        })
        .map_err(io)?;
        for (dir, mode) in dirs.watched() {
            debouncer.watch(dir, mode).map_err(io)?;
        }
        Ok(EventWatcher { _debouncer: debouncer, rx })
    }

    /// Next event, waiting up to `timeout`. `None` on timeout.
    pub fn recv_timeout(&self, timeout: Duration) -> Option<Event> {
        self.rx.recv_timeout(timeout).ok()
    }

    /// Next event if one is ready.
    pub fn try_recv(&self) -> Option<Event> {
        self.rx.try_recv().ok()
    }
}

/// Canonical paths of everything that is watched.
struct Dirs {
    plan: PathBuf,
    stages: PathBuf,
    boards: PathBuf,
    meta: PathBuf,
    proposals: PathBuf,
    log_dir: PathBuf,
}

impl Dirs {
    fn prepare(p: &Project) -> Result<Dirs> {
        let plan = p.plan_dir();
        let meta = p.root.join(".pathloom");
        let mk = |d: PathBuf| -> Result<PathBuf> {
            std::fs::create_dir_all(&d)?;
            Ok(std::fs::canonicalize(d)?)
        };
        Ok(Dirs {
            stages: mk(plan.join("stages"))?,
            boards: mk(plan.join("boards"))?,
            proposals: mk(meta.join("proposals"))?,
            log_dir: mk(meta.join("log"))?,
            plan: mk(plan)?,
            meta: mk(meta)?,
        })
    }

    fn watched(&self) -> [(&Path, RecursiveMode); 6] {
        use RecursiveMode::{NonRecursive, Recursive};
        [
            (&self.stages, NonRecursive),
            (&self.boards, Recursive),
            (&self.plan, NonRecursive),
            (&self.proposals, NonRecursive),
            (&self.meta, NonRecursive),
            (&self.log_dir, NonRecursive),
        ]
        .map(|(p, m)| (p.as_path(), m))
    }
}

enum Kind {
    Stage(String),
    Board(String),
    Proposal(String),
    Claims,
    Agents,
    Log,
}

struct Tracker {
    project: Project,
    stages_dir: PathBuf,
    boards_dir: PathBuf,
    proposals_dir: PathBuf,
    claims_file: PathBuf,
    agents_file: PathBuf,
    log_file: PathBuf,
    old_log_file: PathBuf,
    stages: HashMap<String, String>,
    boards: HashMap<String, String>,
    proposals: HashSet<String>,
    agents_hash: Option<String>,
    claims_hash: Option<String>,
    log_offset: u64,
}

fn file_hash(path: &Path) -> Option<String> {
    std::fs::read(path).ok().map(|b| hash_bytes(&b))
}

fn board_name(boards_dir: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(boards_dir).ok()?;
    let s = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/");
    s.strip_suffix(".board.json").map(String::from)
}

fn walk_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk_files(&p, out);
        } else {
            out.push(p);
        }
    }
}

fn files_with_ext(dir: &Path, ext: &str) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(dir) else { return vec![] };
    rd.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == ext)).collect()
}

impl Tracker {
    fn new(project: Project, d: &Dirs) -> Tracker {
        let mut t = Tracker {
            stages_dir: d.stages.clone(),
            boards_dir: d.boards.clone(),
            proposals_dir: d.proposals.clone(),
            claims_file: d.meta.join("claims.json"),
            agents_file: d.plan.join("agents.json"),
            log_file: d.log_dir.join("agent.jsonl"),
            old_log_file: d.log_dir.join("agent.1.jsonl"),
            project,
            stages: HashMap::new(),
            boards: HashMap::new(),
            proposals: HashSet::new(),
            agents_hash: None,
            claims_hash: None,
            log_offset: 0,
        };
        for p in files_with_ext(&t.stages_dir, "md") {
            if let (Some(k), Some(h)) = (p.file_stem().and_then(|s| s.to_str()), file_hash(&p)) {
                t.stages.insert(k.to_string(), h);
            }
        }
        let mut files = Vec::new();
        walk_files(&t.boards_dir, &mut files);
        for p in files {
            if let (Some(n), Some(h)) = (board_name(&t.boards_dir, &p), file_hash(&p)) {
                t.boards.insert(n, h);
            }
        }
        for p in files_with_ext(&t.proposals_dir, "json") {
            if let Some(id) = p.file_stem().and_then(|s| s.to_str()) {
                t.proposals.insert(id.to_string());
            }
        }
        t.agents_hash = file_hash(&t.agents_file);
        t.claims_hash = file_hash(&t.claims_file);
        t.log_offset = std::fs::metadata(&t.log_file).map_or(0, |m| m.len());
        t
    }

    fn classify(&self, p: &Path) -> Option<Kind> {
        let stem = || p.file_stem().and_then(|s| s.to_str()).map(String::from);
        let ext = p.extension().and_then(|e| e.to_str());
        if p.parent() == Some(self.stages_dir.as_path()) && ext == Some("md") {
            return stem().map(Kind::Stage);
        }
        if p.parent() == Some(self.proposals_dir.as_path()) && ext == Some("json") {
            return stem().map(Kind::Proposal);
        }
        if p == self.claims_file {
            return Some(Kind::Claims);
        }
        if p == self.agents_file {
            return Some(Kind::Agents);
        }
        if p == self.log_file {
            return Some(Kind::Log);
        }
        board_name(&self.boards_dir, p).map(Kind::Board)
    }

    fn process(&mut self, paths: &[PathBuf], tx: &Sender<Event>) {
        let at = now_rfc3339();
        let mut out: Vec<Event> = Vec::new();
        for p in paths {
            let Some(kind) = self.classify(p) else { continue };
            match kind {
                Kind::Stage(key) => {
                    if let Some(change) = diff(&mut self.stages, key.clone(), p) {
                        out.push(Event::Stage { key, change, at: at.clone() });
                    }
                }
                Kind::Board(name) => {
                    if let Some(change) = diff(&mut self.boards, name.clone(), p) {
                        out.push(Event::Board { name, change, at: at.clone() });
                    }
                }
                Kind::Proposal(id) => {
                    let exists = p.is_file();
                    if exists && self.proposals.insert(id.clone()) {
                        out.push(Event::Proposal { id, change: Change::Created, at: at.clone() });
                    } else if !exists && self.proposals.remove(&id) {
                        out.push(Event::Proposal { id, change: Change::Deleted, at: at.clone() });
                    }
                }
                Kind::Claims => {
                    let h = file_hash(p);
                    if h != self.claims_hash {
                        self.claims_hash = h;
                        out.push(Event::Claims { claims: self.project.claims().unwrap_or_default(), at: at.clone() });
                    }
                }
                Kind::Agents => {
                    let h = file_hash(p);
                    if h != self.agents_hash {
                        self.agents_hash = h;
                        out.push(Event::Agents { at: at.clone() });
                    }
                }
                Kind::Log => out.extend(self.tail_log().into_iter().map(|entry| Event::Activity { entry })),
            }
        }
        for e in out {
            if tx.send(e).is_err() {
                return;
            }
        }
    }

    /// New complete log lines since the last offset. A shrunk file means rotation: the unread rest of the
    /// old file (`agent.1.jsonl`) comes first, then the new file from its start.
    /// shortcut: a rotation is missed when the new file already outgrew the old offset by the time we look.
    fn tail_log(&mut self) -> Vec<LogEntry> {
        let len = std::fs::metadata(&self.log_file).map_or(0, |m| m.len());
        let mut out = Vec::new();
        if len < self.log_offset {
            out.extend(read_lines(&self.old_log_file, self.log_offset).0);
            self.log_offset = 0;
        }
        let (entries, used) = read_lines(&self.log_file, self.log_offset);
        self.log_offset += used;
        out.extend(entries);
        out
    }
}

/// Compare the file at `path` with the snapshot entry `key` and update the snapshot.
fn diff(snap: &mut HashMap<String, String>, key: String, path: &Path) -> Option<Change> {
    match std::fs::read(path) {
        Ok(b) => {
            let h = hash_bytes(&b);
            match snap.insert(key, h.clone()) {
                None => Some(Change::Created),
                Some(old) if old != h => Some(Change::Updated),
                Some(_) => None,
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => snap.remove(&key).map(|_| Change::Deleted),
        Err(_) => None, // briefly locked mid-replace: the next notification settles it
    }
}

/// Entries of the complete lines of `path` from byte `from`, and the number of bytes consumed.
fn read_lines(path: &Path, from: u64) -> (Vec<LogEntry>, u64) {
    let Ok(mut f) = std::fs::File::open(path) else { return (vec![], 0) };
    if f.seek(SeekFrom::Start(from)).is_err() {
        return (vec![], 0);
    }
    let mut buf = Vec::new();
    if f.read_to_end(&mut buf).is_err() {
        return (vec![], 0);
    }
    let Some(end) = buf.iter().rposition(|b| *b == b'\n') else { return (vec![], 0) };
    let entries = buf[..end].split(|b| *b == b'\n').filter_map(|l| serde_json::from_slice::<LogEntry>(l).ok()).collect();
    (entries, (end + 1) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_waits_for_complete_lines() {
        let dir = tempfile::tempdir().unwrap();
        let p = Project::init(dir.path(), "demo").unwrap();
        let mut t = Tracker::new(p.clone(), &Dirs::prepare(&p).unwrap());
        std::fs::write(&t.log_file, "{\"action\":\"a\"}
{\"action\":\"b").unwrap();
        assert_eq!(t.tail_log().into_iter().map(|e| e.action).collect::<Vec<_>>(), ["a"]);
        let mut f = std::fs::OpenOptions::new().append(true).open(&t.log_file).unwrap();
        std::io::Write::write_all(&mut f, b"\"}
").unwrap();
        drop(f);
        assert_eq!(t.tail_log().into_iter().map(|e| e.action).collect::<Vec<_>>(), ["b"]);
    }

    #[test]
    fn tail_reads_unread_rest_of_rotated_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = Project::init(dir.path(), "demo").unwrap();
        let mut t = Tracker::new(p.clone(), &Dirs::prepare(&p).unwrap());
        let log = |action: &str, max: u64| {
            p.log_action_limited(&LogEntry { action: action.into(), summary: "x".repeat(40), ..Default::default() }, max)
                .unwrap();
        };
        log("first", u64::MAX);
        t.tail_log();
        log("unread", u64::MAX);
        log("b", 1);
        let got: Vec<String> = t.tail_log().into_iter().map(|e| e.action).collect();
        assert_eq!(got, ["unread", "b"]);
    }
}
