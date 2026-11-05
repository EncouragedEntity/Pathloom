//! Task claims (`.pathloom/claims.json`): which agent is working on which task right now.
//!
//! Machine state, not plan state: the file is git-ignored. Claims expire (TTL) and are pruned on write.
//! Read-modify-write is serialized across processes by `.pathloom/claims.lock`.

use crate::error::{Error, Result};
use crate::fsutil::{FileLock, format_secs, now_secs, write_atomic};
use crate::session::{SessionRef, push_session};
use crate::model::{Stage, StageView};
use crate::project::Project;
use crate::status::stage_views;
use serde::{Deserialize, Serialize};

/// Default claim lifetime: 30 minutes.
pub const DEFAULT_CLAIM_TTL_SECS: u64 = 30 * 60;
/// Longest allowed claim lifetime: 8 hours.
pub const MAX_CLAIM_TTL_SECS: u64 = 8 * 3600;
/// A claim whose agent sent no heartbeat (or action) for this long is shown as "silent, maybe stuck".
pub const SILENT_AFTER_SECS: i64 = 10 * 60;

const CLAIMS_FILE: &str = ".pathloom/claims.json";
const GITIGNORE: &str = ".pathloom/.gitignore";
const LOCK_FILE: &str = ".pathloom/claims.lock";

/// One live claim. `at` / `expires_at` are RFC3339 UTC (`2026-11-05T01:00:00Z`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct Claim {
    pub task_id: String,
    pub agent: String,
    pub at: String,
    pub expires_at: String,
    #[serde(default)]
    pub note: String,
    /// External client session this claim was made from.
    #[serde(default)]
    pub session: Option<SessionRef>,
    /// Last sign of life from the agent (claim, heartbeat or any logged action). Older files lack it: `at` counts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heartbeat_at: Option<String>,
}

impl Claim {
    /// Last sign of life: `heartbeat_at`, else `at`.
    pub fn last_seen(&self) -> &str {
        self.heartbeat_at.as_deref().unwrap_or(&self.at)
    }

    /// No sign of life for [`SILENT_AFTER_SECS`] at time `now` (unix seconds).
    pub fn is_silent(&self, now: i64) -> bool {
        // Both sides are RFC3339 UTC in the same format, so string order is time order.
        self.last_seen() < format_secs(now - SILENT_AFTER_SECS).as_str()
    }
}

/// Claim as shown on a stage card (camelCase JSON, like the rest of `StageView`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimView {
    pub task_id: String,
    pub agent: String,
    pub expires_at: String,
    #[serde(default)]
    pub session: Option<SessionRef>,
    /// Last sign of life (RFC3339). The app recomputes "silent" from it as time passes.
    #[serde(default)]
    pub heartbeat_at: String,
    /// No sign of life for 10 minutes when the view was built.
    #[serde(default)]
    pub silent: bool,
    #[serde(default)]
    pub note: String,
}

impl ClaimView {
    fn of(c: &Claim, now: i64) -> Self {
        ClaimView {
            task_id: c.task_id.clone(),
            agent: c.agent.clone(),
            expires_at: c.expires_at.clone(),
            session: c.session.clone(),
            heartbeat_at: c.last_seen().to_string(),
            silent: c.is_silent(now),
            note: c.note.clone(),
        }
    }
}

#[derive(Default, Serialize, Deserialize)]
struct ClaimFile {
    #[serde(default)]
    claims: Vec<Claim>,
}

/// Stage key of a task id (`AUTH-02a` -> `AUTH`).
fn stage_key_of(task_id: &str) -> &str {
    task_id.split('-').next().unwrap_or("")
}

/// Locate `task_id` in `s`: `(its subtask ids, None)` for a top-level task, `([], Some(parent id))` for a
/// subtask, `None` when unknown.
fn find_task(s: &Stage, task_id: &str) -> Option<(Vec<String>, Option<String>)> {
    for t in &s.tasks {
        if t.id == task_id {
            return Some((t.sub.iter().map(|x| x.id.clone()).collect(), None));
        }
        if t.sub.iter().any(|x| x.id == task_id) {
            return Some((vec![], Some(t.id.clone())));
        }
    }
    None
}

impl Project {
    fn claims_path(&self) -> std::path::PathBuf {
        self.root.join(CLAIMS_FILE)
    }

    /// All claims in the file, expired ones included. A missing or unreadable file is "no claims"
    /// (it is machine state and is rewritten on the next claim).
    fn read_claims_raw(&self) -> Vec<Claim> {
        std::fs::read_to_string(self.claims_path())
            .ok()
            .and_then(|t| serde_json::from_str::<ClaimFile>(&t).ok())
            .map_or_else(Vec::new, |f| f.claims)
    }

    fn write_claims(&self, claims: Vec<Claim>) -> Result<()> {
        let text = serde_json::to_string_pretty(&ClaimFile { claims }).map_err(|e| Error::InvalidSpec(e.to_string()))?;
        write_atomic(&self.claims_path(), text.as_bytes())?;
        self.ensure_claims_ignored();
        Ok(())
    }

    /// Make sure `.pathloom/.gitignore` lists `claims.json` and `claims.lock` (older projects lack them). Best effort.
    fn ensure_claims_ignored(&self) {
        let path = self.root.join(GITIGNORE);
        let cur = std::fs::read_to_string(&path).unwrap_or_default();
        let mut text = cur.clone();
        for name in ["claims.json", "claims.lock"] {
            if text.lines().any(|l| l.trim() == name) {
                continue;
            }
            if !text.is_empty() && !text.ends_with('\n') {
                text.push('\n');
            }
            text.push_str(name);
            text.push('\n');
        }
        if text != cur {
            let _ = write_atomic(&path, text.as_bytes());
        }
    }

    /// Serialize read-modify-write of `claims.json` (and `agents.json`) across processes.
    pub(crate) fn lock_claims(&self) -> Result<FileLock> {
        FileLock::acquire(&self.root.join(LOCK_FILE))
    }

    fn live(claims: Vec<Claim>, now: &str) -> Vec<Claim> {
        claims.into_iter().filter(|c| c.expires_at.as_str() > now).collect()
    }

    /// Live (not expired) claims.
    pub fn claims(&self) -> Result<Vec<Claim>> {
        Ok(Self::live(self.read_claims_raw(), &format_secs(now_secs())))
    }

    /// Claim `task_id` (a task or subtask) for `agent`. The same agent claiming again renews the TTL.
    /// `ttl_secs` 0 = 30 minutes; capped at 8 hours. Claiming a task held by another agent (directly, via its
    /// parent task or via one of its subtasks) fails with [`Error::Claimed`]; a done task is `InvalidSpec`.
    pub fn claim_task(&self, task_id: &str, agent: &str, ttl_secs: u64, note: &str) -> Result<Claim> {
        self.claim_task_with(task_id, agent, ttl_secs, note, None)
    }

    /// Like [`Project::claim_task`] with the external client session the claim comes from. The session is
    /// stored on the claim and appended to the stage's `sessions` (dedup by client+id).
    pub fn claim_task_with(
        &self,
        task_id: &str,
        agent: &str,
        ttl_secs: u64,
        note: &str,
        session: Option<&SessionRef>,
    ) -> Result<Claim> {
        self.claim_inner(task_id, agent, ttl_secs, note, session, now_secs())
    }

    #[cfg(test)]
    pub(crate) fn claim_task_at(&self, task_id: &str, agent: &str, ttl_secs: u64, note: &str, now: i64) -> Result<Claim> {
        self.claim_inner(task_id, agent, ttl_secs, note, None, now)
    }

    fn claim_inner(
        &self,
        task_id: &str,
        agent: &str,
        ttl_secs: u64,
        note: &str,
        session: Option<&SessionRef>,
        now: i64,
    ) -> Result<Claim> {
        let session = session.cloned().map(SessionRef::normalize).transpose()?;
        let agent = agent.trim();
        if agent.is_empty() {
            return Err(Error::InvalidSpec("agent name must not be empty".into()));
        }
        let stage = self.load_stage(stage_key_of(task_id)).map_err(|e| match e {
            Error::NotFound(_) | Error::InvalidKey(_) => Error::NotFound(format!("task {task_id}")),
            other => other,
        })?;
        let (subs, parent) =
            find_task(&stage, task_id).ok_or_else(|| Error::NotFound(format!("task {task_id}")))?;
        let done = stage
            .tasks
            .iter()
            .flat_map(|t| std::iter::once(t).chain(t.sub.iter()))
            .find(|t| t.id == task_id)
            .is_some_and(|t| t.is_done());
        if done {
            return Err(Error::InvalidSpec(format!("task {task_id} is already done")));
        }
        let ttl = if ttl_secs == 0 { DEFAULT_CLAIM_TTL_SECS } else { ttl_secs.min(MAX_CLAIM_TTL_SECS) };
        let now_s = format_secs(now);
        let mut related = subs;
        related.extend(parent);
        related.push(task_id.to_string());
        let _lock = self.lock_claims()?;
        let mut claims = Self::live(self.read_claims_raw(), &now_s);
        if let Some(c) = claims.iter().find(|c| c.agent != agent && related.contains(&c.task_id)) {
            return Err(Error::Claimed {
                task_id: c.task_id.clone(),
                by: c.agent.clone(),
                expires_at: c.expires_at.clone(),
            });
        }
        let secs = i64::try_from(ttl).unwrap_or(i64::MAX / 2);
        let claim = Claim {
            task_id: task_id.into(),
            agent: agent.into(),
            at: now_s.clone(),
            expires_at: format_secs(now.saturating_add(secs)),
            note: note.replace(['\r', '\n'], " ").trim().into(),
            session: session.clone(),
            heartbeat_at: Some(now_s.clone()),
        };
        claims.retain(|c| c.task_id != task_id);
        claims.push(claim.clone());
        self.write_claims(claims)?;
        if let Some(s) = session {
            // Best effort: the claim is already made; a failed history update must not undo it.
            let _ = self.edit_stage(stage_key_of(task_id), |st| {
                push_session(&mut st.sessions, s);
                Ok(())
            });
        }
        Ok(claim)
    }

    /// Drop `agent`'s claim on `task_id` and on its subtasks. Nothing claimed is fine (no-op).
    /// Someone else's live claim fails with [`Error::Claimed`] unless `force`.
    pub fn release_task(&self, task_id: &str, agent: &str, force: bool) -> Result<()> {
        self.release_task_at(task_id, agent, force, now_secs())
    }

    pub(crate) fn release_task_at(&self, task_id: &str, agent: &str, force: bool, now: i64) -> Result<()> {
        let mut ids = vec![task_id.to_string()];
        if let Ok(s) = self.load_stage(stage_key_of(task_id))
            && let Some((subs, _)) = find_task(&s, task_id)
        {
            ids.extend(subs);
        }
        let _lock = self.lock_claims()?;
        let all = self.read_claims_raw();
        let claims = Self::live(all.clone(), &format_secs(now));
        if let Some(c) = claims.iter().find(|c| ids.contains(&c.task_id) && c.agent != agent && !force) {
            return Err(Error::Claimed {
                task_id: c.task_id.clone(),
                by: c.agent.clone(),
                expires_at: c.expires_at.clone(),
            });
        }
        let kept: Vec<Claim> = claims.into_iter().filter(|c| !ids.contains(&c.task_id)).collect();
        if kept.len() != all.len() {
            self.write_claims(kept)?;
        }
        Ok(())
    }

    /// The agent is alive: refresh `heartbeat_at` on its live claims (only `task_id` when given) and keep them
    /// for at least another default TTL. A non-empty `note` replaces the claims' note. Returns the touched claims;
    /// a `task_id` the agent does not hold fails with [`Error::NotFound`].
    pub fn heartbeat(&self, agent: &str, task_id: Option<&str>, note: Option<&str>) -> Result<Vec<Claim>> {
        self.heartbeat_inner(agent, task_id, note, true, now_secs())
    }

    /// Best effort after any logged action of `agent`: mark its claims alive (no TTL change, never fails).
    pub fn touch_claims(&self, agent: &str) {
        let _ = self.heartbeat_inner(agent, None, None, false, now_secs());
    }

    pub(crate) fn heartbeat_inner(
        &self,
        agent: &str,
        task_id: Option<&str>,
        note: Option<&str>,
        extend: bool,
        now: i64,
    ) -> Result<Vec<Claim>> {
        let agent = agent.trim();
        let now_s = format_secs(now);
        let keep_until = format_secs(now.saturating_add(i64::try_from(DEFAULT_CLAIM_TTL_SECS).unwrap_or(1800)));
        let note = note.map(|n| n.replace(['\r', '\n'], " ").trim().to_string()).filter(|n| !n.is_empty());
        let _lock = self.lock_claims()?;
        let all = self.read_claims_raw();
        let mut claims = Self::live(all.clone(), &now_s);
        let mut touched = Vec::new();
        for c in claims.iter_mut().filter(|c| c.agent == agent && task_id.is_none_or(|t| c.task_id == t)) {
            c.heartbeat_at = Some(now_s.clone());
            if extend && c.expires_at < keep_until {
                c.expires_at.clone_from(&keep_until);
            }
            if let Some(n) = &note {
                c.note.clone_from(n);
            }
            touched.push(c.clone());
        }
        if let (Some(t), true) = (task_id, touched.is_empty()) {
            return Err(Error::NotFound(format!("claim of {agent} on task {t}")));
        }
        if !touched.is_empty() || claims.len() != all.len() {
            self.write_claims(claims)?;
        }
        Ok(touched)
    }

    /// Stage key changed: move its claims to the new task ids. Best effort.
    pub(crate) fn rename_claims(&self, old: &str, new: &str) {
        let Ok(_lock) = self.lock_claims() else { return };
        let mut all = self.read_claims_raw();
        let mut changed = false;
        for c in &mut all {
            if let Some(rest) = c.task_id.strip_prefix(old).and_then(|r| r.strip_prefix('-')) {
                c.task_id = format!("{new}-{rest}");
                changed = true;
            }
        }
        if changed {
            let _ = self.write_claims(all);
        }
    }

    /// Remove claims on tasks that are done in `stages` (called after a task is marked done).
    pub(crate) fn release_done_claims(&self, stages: &[Stage]) {
        let Ok(_lock) = self.lock_claims() else { return };
        let all = self.read_claims_raw();
        if all.is_empty() {
            return;
        }
        let done = |id: &str| {
            stages
                .iter()
                .flat_map(|s| s.tasks.iter())
                .flat_map(|t| std::iter::once(t).chain(t.sub.iter()))
                .any(|t| t.id == id && t.is_done())
        };
        let kept: Vec<Claim> = all.iter().filter(|c| !done(&c.task_id)).cloned().collect();
        if kept.len() != all.len() {
            // Best effort: a failed claims write must not fail marking the task done.
            let _ = self.write_claims(Self::live(kept, &format_secs(now_secs())));
        }
    }

    /// Like [`stage_views`] on all stages, with each view's live claims filled in.
    pub fn stage_views_live(&self) -> Result<Vec<StageView>> {
        let mut views = stage_views(&self.load_stages()?);
        let claims = self.claims()?;
        let now = now_secs();
        for v in &mut views {
            v.claims = claims.iter().filter(|c| stage_key_of(&c.task_id) == v.stage.key).map(|c| ClaimView::of(c, now)).collect();
        }
        Ok(views)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (tempfile::TempDir, Project) {
        let dir = tempfile::tempdir().unwrap();
        let p = Project::init(dir.path(), "demo").unwrap();
        let spec = Project::parse_spec("stages: [{id: A, title: Alpha, tasks: [one, two]}]").unwrap();
        p.apply(&spec, &Default::default()).unwrap();
        p.add_subtask("A-02", "x").unwrap();
        p.add_subtask("A-02", "y").unwrap();
        (dir, p)
    }

    const T0: i64 = 1_793_788_920;

    #[test]
    fn lifecycle_renew_conflict_expiry_force() {
        let (_d, p) = setup();
        let c = p.claim_task_at("A-01", "claude", 0, " note\n", T0).unwrap();
        assert_eq!(c.expires_at, format_secs(T0 + 1800));
        assert_eq!(c.note, "note");
        // renew by same agent keeps a single claim
        let c2 = p.claim_task_at("A-01", "claude", 7200, "", T0 + 60).unwrap();
        assert_eq!(c2.expires_at, format_secs(T0 + 60 + 7200));
        assert_eq!(p.read_claims_raw().len(), 1);
        // ttl is capped at 8 h
        let c3 = p.claim_task_at("A-01", "claude", 999_999, "", T0).unwrap();
        assert_eq!(c3.expires_at, format_secs(T0 + 8 * 3600));
        // conflict
        let Err(Error::Claimed { task_id, by, .. }) = p.claim_task_at("A-01", "codex", 60, "", T0 + 10) else {
            panic!("expected Claimed")
        };
        assert_eq!((task_id.as_str(), by.as_str()), ("A-01", "claude"));
        // other agent cannot release, force can
        assert!(matches!(p.release_task_at("A-01", "codex", false, T0 + 10), Err(Error::Claimed { .. })));
        p.release_task_at("A-01", "codex", true, T0 + 10).unwrap();
        assert!(p.read_claims_raw().is_empty());
        // expiry frees the task and is pruned on write
        p.claim_task_at("A-01", "claude", 60, "", T0).unwrap();
        p.claim_task_at("A-01", "codex", 60, "", T0 + 61).unwrap();
        let all = p.read_claims_raw();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].agent, "codex");
        // releasing something nobody holds is fine
        p.release_task_at("A-02", "codex", false, T0).unwrap();
    }

    #[test]
    fn parent_covers_subtasks_and_errors() {
        let (_d, p) = setup();
        p.claim_task_at("A-02", "claude", 60, "", T0).unwrap();
        assert!(matches!(p.claim_task_at("A-02a", "codex", 60, "", T0), Err(Error::Claimed { .. })));
        p.claim_task_at("A-02a", "claude", 60, "", T0).unwrap();
        p.release_task_at("A-02", "claude", false, T0).unwrap();
        assert!(p.read_claims_raw().is_empty(), "releasing the parent drops subtask claims too");
        p.claim_task_at("A-02b", "codex", 60, "", T0).unwrap();
        assert!(matches!(p.claim_task_at("A-02", "claude", 60, "", T0), Err(Error::Claimed { .. })));
        assert!(matches!(p.claim_task_at("A-09", "claude", 60, "", T0), Err(Error::NotFound(_))));
        assert!(matches!(p.claim_task_at("ZZ-01", "claude", 60, "", T0), Err(Error::NotFound(_))));
        assert!(matches!(p.claim_task_at("A-01", " ", 60, "", T0), Err(Error::InvalidSpec(_))));
        p.set_task_done("A-01", true).unwrap();
        assert!(matches!(p.claim_task_at("A-01", "claude", 60, "", T0), Err(Error::InvalidSpec(_))));
    }

    #[test]
    fn heartbeat_touch_and_silence() {
        let (_d, p) = setup();
        let c = p.claim_task_at("A-01", "claude", 120, "", T0).unwrap();
        assert_eq!(c.last_seen(), format_secs(T0));
        assert!(!c.is_silent(T0 + SILENT_AFTER_SECS) && c.is_silent(T0 + SILENT_AFTER_SECS + 1));
        // heartbeat refreshes, extends a short claim to the default TTL and sets the note
        let hb = p.heartbeat_inner("claude", None, Some("running tests"), true, T0 + 100).unwrap();
        assert_eq!(hb.len(), 1);
        assert_eq!(hb[0].heartbeat_at.as_deref(), Some(format_secs(T0 + 100).as_str()));
        assert_eq!(hb[0].expires_at, format_secs(T0 + 100 + 1800));
        assert_eq!(hb[0].note, "running tests");
        // touch (any action) refreshes without extending
        let t = p.heartbeat_inner("claude", None, None, false, T0 + 200).unwrap();
        assert_eq!((t[0].expires_at.as_str(), t[0].note.as_str()), (format_secs(T0 + 100 + 1800).as_str(), "running tests"));
        // other agents and unknown tasks
        assert!(p.heartbeat_inner("codex", None, None, true, T0).unwrap().is_empty());
        assert!(matches!(p.heartbeat_inner("claude", Some("A-02"), None, true, T0 + 300), Err(Error::NotFound(_))));
        // old claims.json without heartbeat_at: `at` counts
        let mut old = p.read_claims_raw();
        old[0].heartbeat_at = None;
        p.write_claims(old).unwrap();
        assert_eq!(p.read_claims_raw()[0].last_seen(), format_secs(T0));
    }

    #[test]
    fn gitignore_gets_claims_json_once() {
        let (d, p) = setup();
        let gi = d.path().join(".pathloom/.gitignore");
        assert!(std::fs::read_to_string(&gi).unwrap().contains("claims.json"));
        std::fs::write(&gi, "cache/").unwrap(); // old project, no trailing newline
        p.claim_task("A-01", "claude", 60, "").unwrap();
        p.claim_task("A-01", "claude", 60, "").unwrap();
        assert_eq!(std::fs::read_to_string(&gi).unwrap(), "cache/\nclaims.json\nclaims.lock\n");
    }
}
