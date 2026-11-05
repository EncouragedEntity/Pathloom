//! Batch changes (`apply`): spec types, parsing and the transactional apply (spec §7.3).
//!
//! All target files are computed in memory and validated first; nothing is written on any error.

use crate::error::{Error, Result};
use crate::fsutil::{now_minute, write_atomic};
use crate::hash::hash_bytes;
use crate::indexkey::{key_after, key_between};
use crate::keygen::generate_key;
use crate::layout::{CARD_H, CARD_W, El, card_height, card_ref, el_id, el_type, fit_frame, layout_elements, num};
use crate::model::*;
use crate::project::{Project, check_board_name, check_key, mark_done, push_task, read_text};
use crate::status::find_cycle;
use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;

// ---------- spec types ----------

fn scalar(v: Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// Accept strings, numbers and booleans where a string is expected (YAML: `due: 2026-12-01`, `tasks: [2fa]`).
fn lenient_opt<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<Option<String>, D::Error> {
    match Option::<Value>::deserialize(d)? {
        None | Some(Value::Null) => Ok(None),
        Some(v) => scalar(v).map(Some).ok_or_else(|| serde::de::Error::custom("expected a string")),
    }
}

fn lenient_vec<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<Vec<String>, D::Error> {
    Option::<Vec<Value>>::deserialize(d)?
        .unwrap_or_default()
        .into_iter()
        .map(|v| scalar(v).ok_or_else(|| serde::de::Error::custom("expected a string")))
        .collect()
}

/// A dependency: `M0` or `{id: M2, soft: true}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum DepSpec {
    Key(String),
    Full {
        id: String,
        #[serde(default)]
        soft: bool,
    },
}

/// Where to put a new card: `{after: KEY}` or `{x, y}`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct Place {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
}

/// One stage to create or update.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct StageSpec {
    /// Stage key `[A-Z][A-Z0-9]{0,7}`; generated from the title when absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// Required for a new stage.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<StageKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub who: Option<Who>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<Priority>,
    /// ISO date; empty string clears.
    #[serde(deserialize_with = "lenient_opt", skip_serializing_if = "Option::is_none")]
    #[schemars(with = "Option<String>")]
    pub due: Option<String>,
    /// Empty string clears.
    #[serde(deserialize_with = "lenient_opt", skip_serializing_if = "Option::is_none")]
    #[schemars(with = "Option<String>")]
    pub branch: Option<String>,
    /// Full replacement of the stage's dependencies when present.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depends: Option<Vec<DepSpec>>,
    /// Task titles to append (skipped when a task with the same title exists).
    #[serde(deserialize_with = "lenient_vec", skip_serializing_if = "Vec::is_empty")]
    #[schemars(with = "Vec<String>")]
    pub tasks: Vec<String>,
    /// Task ids to mark done.
    #[serde(deserialize_with = "lenient_vec", skip_serializing_if = "Vec::is_empty")]
    #[schemars(with = "Vec<String>")]
    pub tasks_done: Vec<String>,
    /// Task ids to mark not done.
    #[serde(deserialize_with = "lenient_vec", skip_serializing_if = "Vec::is_empty")]
    #[schemars(with = "Vec<String>")]
    pub tasks_undone: Vec<String>,
    /// Hand-off files to list on the stage: project-relative paths or http(s) links (dedup; at most 30).
    #[serde(deserialize_with = "lenient_vec", skip_serializing_if = "Vec::is_empty")]
    #[schemars(with = "Vec<String>")]
    pub artifacts_add: Vec<String>,
    /// `kind: gate` only: command that must pass, e.g. `npm test`. Empty string clears.
    #[serde(deserialize_with = "lenient_opt", skip_serializing_if = "Option::is_none")]
    #[schemars(with = "Option<String>")]
    pub check: Option<String>,
    /// External client sessions to record on the stage (dedup by client+id; at most 20 are kept).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub sessions_add: Vec<crate::session::SessionRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub place: Option<Place>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LinkSpec {
    pub from: String,
    pub to: String,
    #[serde(default)]
    pub soft: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UnlinkSpec {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FrameSpec {
    pub name: String,
    pub members: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CommentSpec {
    pub stage: String,
    pub text: String,
}

/// Batch change set for [`Project::apply`] (YAML or JSON).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct ApplySpec {
    /// Board for new cards (default `roadmap`); created when missing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub board: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub stages: Vec<StageSpec>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub links: Vec<LinkSpec>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub unlinks: Vec<UnlinkSpec>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub frames: Vec<FrameSpec>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub comments: Vec<CommentSpec>,
    /// Stage key -> file hash (from `get_stage`); a mismatch fails with CONFLICT.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub expected: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplyOptions {
    pub dry_run: bool,
    /// Author recorded on comments.
    pub author: String,
}

impl Default for ApplyOptions {
    fn default() -> Self {
        ApplyOptions { dry_run: false, author: "agent".into() }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CardPlacement {
    pub key: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ApplyReport {
    /// New stage keys.
    pub created: Vec<String>,
    /// Existing stage keys whose file changed.
    pub updated: Vec<String>,
    pub board: String,
    pub cards_added: Vec<CardPlacement>,
    /// Names of the frames created.
    pub frames_added: Vec<String>,
    pub warnings: Vec<String>,
    /// Changed files, relative to the project root.
    pub files: Vec<String>,
}

// ---------- apply ----------

fn bad(msg: impl Into<String>) -> Error {
    Error::InvalidSpec(msg.into())
}

fn new_element_id(taken: &HashSet<String>) -> String {
    loop {
        let u = ulid::Ulid::generate().to_string().to_lowercase();
        let id = format!("e{}", &u[16..26]);
        if !taken.contains(&id) {
            return id;
        }
    }
}

fn opt_clear(v: &str) -> Option<String> {
    let v = v.trim();
    (!v.is_empty()).then(|| v.to_string())
}

fn title_case(name: &str) -> String {
    let last = name.rsplit('/').next().unwrap_or(name);
    let mut c = last.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

impl Project {
    /// Parse a spec from YAML or JSON (JSON when the first non-space char is `{`).
    pub fn parse_spec(text: &str) -> Result<ApplySpec> {
        if text.trim_start().starts_with('{') {
            return serde_json::from_str(text).map_err(|e| bad(e.to_string()));
        }
        let v: Value = serde_saphyr::from_str(text).map_err(|e| bad(e.to_string()))?;
        if v.is_null() {
            return Ok(ApplySpec::default());
        }
        serde_json::from_value(v).map_err(|e| bad(e.to_string()))
    }

    /// Apply a spec: all or nothing. With `dry_run` nothing is written but the report is complete.
    pub fn apply(&self, spec: &ApplySpec, opts: &ApplyOptions) -> Result<ApplyReport> {
        let (report, files) = self.plan_apply(spec, opts)?;
        if !opts.dry_run {
            commit(&files)?;
            if spec.stages.iter().any(|s| !s.tasks_done.is_empty()) {
                let touched: Vec<Stage> =
                    report.created.iter().chain(&report.updated).filter_map(|k| self.load_stage(k).ok()).collect();
                self.release_done_claims(&touched);
            }
        }
        Ok(report)
    }

    #[allow(clippy::too_many_lines)]
    fn plan_apply(&self, spec: &ApplySpec, opts: &ApplyOptions) -> Result<(ApplyReport, Vec<(PathBuf, String)>)> {
        let mut stages = self.load_stages()?;
        let mut orig: HashMap<String, String> = HashMap::new();
        for s in &stages {
            orig.insert(s.key.clone(), self.stage_source(&s.key)?);
        }
        for (k, h) in &spec.expected {
            let src = orig.get(k).ok_or_else(|| Error::NotFound(format!("stage {k}")))?;
            if hash_bytes(src.as_bytes()) != *h {
                return Err(Error::Conflict { key: k.clone() });
            }
        }
        let mut idx: HashMap<String, usize> = stages.iter().enumerate().map(|(i, s)| (s.key.clone(), i)).collect();
        let bname = spec.board.clone().unwrap_or_else(|| "roadmap".into());
        check_board_name(&bname)?;
        let mut report = ApplyReport { board: bname.clone(), ..Default::default() };
        let mut touched: Vec<String> = Vec::new();
        fn touch(k: &str, touched: &mut Vec<String>) {
            if !touched.iter().any(|t| t == k) {
                touched.push(k.to_string());
            }
        }

        // 1. resolve keys, create new stages
        let mut seen: HashSet<String> = HashSet::new();
        let mut resolved: Vec<(String, &StageSpec)> = Vec::new();
        for ss in &spec.stages {
            let title = ss.title.as_deref().map(str::trim).filter(|t| !t.is_empty());
            let key = match &ss.id {
                Some(id) => {
                    check_key(id)?;
                    id.clone()
                }
                None => {
                    let t = title.ok_or_else(|| bad("a stage without `id` needs a `title`"))?;
                    match stages.iter().find(|s| s.title == t) {
                        Some(s) => s.key.clone(),
                        None => generate_key(t, &|k| idx.contains_key(k)),
                    }
                }
            };
            if !seen.insert(key.clone()) {
                return Err(Error::DuplicateKey(key));
            }
            if !idx.contains_key(&key) {
                let t = title.ok_or_else(|| bad(format!("new stage {key} needs a `title`")))?;
                stages.push(Stage::new(&key, t));
                idx.insert(key.clone(), stages.len() - 1);
                report.created.push(key.clone());
            }
            touch(&key, &mut touched);
            resolved.push((key, ss));
        }

        // 2. field updates, deps, tasks
        for (key, ss) in &resolved {
            let st = &mut stages[idx[key]];
            if let Some(t) = ss.title.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
                st.title = t.to_string();
            }
            if let Some(k) = ss.kind {
                st.kind = k;
            }
            if let Some(w) = &ss.who {
                st.who = w.clone();
            }
            if let Some(p) = ss.priority {
                st.priority = p;
            }
            if let Some(d) = &ss.due {
                st.due = opt_clear(d);
            }
            if let Some(b) = &ss.branch {
                st.branch = opt_clear(b);
            }
            if let Some(list) = &ss.depends {
                let mut deps: Vec<Dep> = Vec::new();
                for d in list {
                    let (id, soft) = match d {
                        DepSpec::Key(id) => (id, false),
                        DepSpec::Full { id, soft } => (id, *soft),
                    };
                    check_key(id)?;
                    if id == key {
                        return Err(Error::Cycle(vec![key.clone(), key.clone()]));
                    }
                    if deps.iter().all(|x| &x.id != id) {
                        deps.push(Dep { id: id.clone(), soft });
                    }
                }
                st.depends = deps;
            }
            if !ss.tasks.is_empty() && st.kind == StageKind::Milestone {
                report.warnings.push(format!("{key} is a milestone; milestones normally have no tasks"));
            }
            for t in &ss.tasks {
                let t = t.trim();
                if !t.is_empty() && st.tasks.iter().all(|x| x.title != t) {
                    push_task(st, t);
                }
            }
            for id in &ss.tasks_done {
                mark_done(st, id, true)?;
            }
            for id in &ss.tasks_undone {
                mark_done(st, id, false)?;
            }
            for a in &ss.artifacts_add {
                let a = crate::project::check_artifact(a)?;
                if !st.artifacts.contains(&a) {
                    if st.artifacts.len() >= 30 {
                        return Err(bad(format!("{key} has 30 artifacts already")));
                    }
                    st.artifacts.push(a);
                }
            }
            if let Some(c) = &ss.check {
                st.check = opt_clear(&c.replace(['\r', '\n'], " "));
            }
            for s in &ss.sessions_add {
                crate::session::push_session(&mut st.sessions, s.clone().normalize()?);
            }
        }
        let has = |idx: &HashMap<String, usize>, k: &str| -> Result<()> {
            check_key(k)?;
            if idx.contains_key(k) { Ok(()) } else { Err(Error::NotFound(format!("stage {k}"))) }
        };

        // 3. links / unlinks
        for l in &spec.links {
            has(&idx, &l.from)?;
            has(&idx, &l.to)?;
            if l.from == l.to {
                return Err(Error::Cycle(vec![l.from.clone(), l.to.clone()]));
            }
            let st = &mut stages[idx[&l.to]];
            if st.depends.iter().all(|d| d.id != l.from) {
                st.depends.push(Dep { id: l.from.clone(), soft: l.soft });
                touch(&l.to, &mut touched);
            }
        }
        for u in &spec.unlinks {
            has(&idx, &u.to)?;
            let st = &mut stages[idx[&u.to]];
            let before = st.depends.len();
            st.depends.retain(|d| d.id != u.from);
            if st.depends.len() != before {
                touch(&u.to, &mut touched);
            }
        }
        for k in &touched {
            for d in &stages[idx[k]].depends {
                has(&idx, &d.id)?;
            }
        }
        if let Some(cycle) = find_cycle(&stages) {
            return Err(Error::Cycle(cycle));
        }

        // 4. comments
        let author = {
            let a = opts.author.replace(['\r', '\n'], " ");
            if a.trim().is_empty() { "agent".to_string() } else { a.trim().to_string() }
        };
        for c in &spec.comments {
            has(&idx, &c.stage)?;
            let text = c.text.replace(['\r', '\n'], " ");
            let text = text.trim();
            if text.is_empty() {
                return Err(bad("comment text must not be empty"));
            }
            let st = &mut stages[idx[&c.stage]];
            if st.comments.iter().all(|x| x.author != author || x.text != text) {
                st.comments.push(Comment { at: now_minute(), author: author.clone(), text: text.into() });
                touch(&c.stage, &mut touched);
            }
        }

        // 5. stage files
        let mut files: Vec<(PathBuf, String)> = Vec::new();
        for k in &touched {
            let md = stages[idx[k]].to_markdown();
            let is_new = report.created.contains(k);
            if !is_new && orig.get(k).is_some_and(|o| o.replace("\r\n", "\n") == md) {
                continue;
            }
            if !is_new {
                report.updated.push(k.clone());
            }
            files.push((self.stage_path(k), md));
        }

        // 6. board: cards, placement, frames
        let wants_board = spec.board.is_some()
            || !report.created.is_empty()
            || !spec.frames.is_empty()
            || spec.stages.iter().any(|s| s.place.is_some());
        if wants_board {
            let bpath = self.board_path(&bname);
            let orig_board = if bpath.is_file() { Some(Board::from_json(&bpath, &read_text(&bpath)?)?) } else { None };
            let mut board = orig_board.clone().unwrap_or_else(|| Board::new(&title_case(&bname)));
            self.plan_board(spec, &resolved, &stages, &idx, &mut board, &mut report)?;
            if orig_board.as_ref() != Some(&board) {
                files.push((bpath, board.to_canonical_json()));
            }
        }

        report.files = files
            .iter()
            .map(|(p, _)| p.strip_prefix(&self.root).unwrap_or(p).to_string_lossy().replace('\\', "/"))
            .collect();
        Ok((report, files))
    }

    fn plan_board(
        &self,
        spec: &ApplySpec,
        resolved: &[(String, &StageSpec)],
        stages: &[Stage],
        idx: &HashMap<String, usize>,
        board: &mut Board,
        report: &mut ApplyReport,
    ) -> Result<()> {
        let els = &mut board.elements;
        let known = |k: &str| -> Result<()> {
            if idx.contains_key(k) { Ok(()) } else { Err(Error::NotFound(format!("stage {k}"))) }
        };
        let card_idx = |els: &[El], k: &str| els.iter().position(|e| card_ref(e) == Some(k));

        // which stages need a new card
        let mut need: Vec<String> = report.created.clone();
        let mut explicit: HashMap<String, (f64, f64)> = HashMap::new();
        let mut after: HashMap<String, String> = HashMap::new();
        for (key, ss) in resolved {
            let Some(p) = &ss.place else { continue };
            let has_card = card_idx(els, key).is_some();
            match (p.x, p.y, &p.after) {
                (Some(_), None, _) | (None, Some(_), _) => return Err(bad(format!("place of {key}: give both x and y"))),
                (Some(_), Some(_), Some(_)) => return Err(bad(format!("place of {key}: use either after or x/y"))),
                (Some(x), Some(y), None) => {
                    explicit.insert(key.clone(), (x, y));
                    if !has_card && !need.contains(key) {
                        need.push(key.clone());
                    }
                }
                (None, None, Some(t)) => {
                    known(t)?;
                    if has_card && !need.contains(key) {
                        report.warnings.push(format!("place.after ignored for {key}: it already has a card"));
                    } else {
                        if !need.contains(key) {
                            need.push(key.clone());
                        }
                        after.insert(key.clone(), t.clone());
                    }
                }
                (None, None, None) => {}
            }
        }
        for f in &spec.frames {
            if f.members.is_empty() {
                return Err(bad(format!("frame `{}` has no members", f.name)));
            }
            for m in &f.members {
                known(m)?;
                if card_idx(els, m).is_none() && !need.contains(m) {
                    need.push(m.clone());
                }
            }
        }

        // create cards
        let mut taken: HashSet<String> = els.iter().map(|e| el_id(e).to_string()).collect();
        let mut last_index = els.iter().filter_map(|e| e.get("index").and_then(Value::as_str)).max().map(String::from);
        let mut new_cards: Vec<String> = Vec::new();
        for k in &need {
            if card_idx(els, k).is_some() {
                continue;
            }
            let id = new_element_id(&taken);
            taken.insert(id.clone());
            let index = key_after(last_index.as_deref());
            last_index = Some(index.clone());
            let mut m: El = Map::new();
            m.insert("id".into(), id.into());
            m.insert("type".into(), "card".into());
            m.insert("ref".into(), k.clone().into());
            m.insert("x".into(), 0.into());
            m.insert("y".into(), 0.into());
            m.insert("w".into(), num(CARD_W));
            let h = stages.iter().find(|s| &s.key == k).map_or(CARD_H, card_height);
            m.insert("h".into(), num(h));
            m.insert("index".into(), index.into());
            els.push(m);
            new_cards.push(k.clone());
        }
        for (k, (x, y)) in &explicit {
            if let Some(i) = card_idx(els, k) {
                els[i].insert("x".into(), num(*x));
                els[i].insert("y".into(), num(*y));
            }
        }
        let movers: HashSet<String> = new_cards.iter().filter(|k| !explicit.contains_key(*k)).cloned().collect();
        if !movers.is_empty() {
            layout_elements(els, stages, Some(&movers), &after)?;
        }
        for k in &new_cards {
            if let Some(i) = card_idx(els, k) {
                let r = crate::layout::card_rect(&els[i]);
                report.cards_added.push(CardPlacement { key: k.clone(), x: r.x, y: r.y, w: r.w });
            }
        }

        // frames
        for f in &spec.frames {
            let member_idx: Vec<usize> = f.members.iter().filter_map(|m| card_idx(els, m)).collect();
            let existing = els.iter().find(|e| el_type(e) == "frame" && e.get("name").and_then(Value::as_str) == Some(&f.name));
            let fid = if let Some(e) = existing {
                el_id(e).to_string()
            } else {
                let id = new_element_id(&taken);
                taken.insert(id.clone());
                let min_member = member_idx.iter().filter_map(|&i| els[i].get("index").and_then(Value::as_str)).min().map(String::from);
                let index = key_between(None, min_member.as_deref());
                let mut m: El = Map::new();
                m.insert("id".into(), id.clone().into());
                m.insert("type".into(), "frame".into());
                for k in ["x", "y", "w", "h"] {
                    m.insert(k.into(), 0.into());
                }
                m.insert("index".into(), index.into());
                m.insert("name".into(), f.name.clone().into());
                els.insert(0, m);
                report.frames_added.push(f.name.clone());
                id
            };
            // `els.insert(0, ..)` shifted indices: look members up again.
            for m in &f.members {
                if let Some(i) = card_idx(els, m) {
                    els[i].insert("frame".into(), fid.clone().into());
                }
            }
            fit_frame(els, &fid);
        }
        Ok(())
    }
}

/// Write all files; on a failed write restore the ones already written.
fn commit(files: &[(PathBuf, String)]) -> Result<()> {
    let mut done: Vec<(&PathBuf, Option<Vec<u8>>)> = Vec::new();
    for (p, text) in files {
        let old = std::fs::read(p).ok();
        if let Err(e) = write_atomic(p, text.as_bytes()) {
            for (p, old) in done.iter().rev() {
                let _ = match old {
                    Some(b) => write_atomic(p, b),
                    None => std::fs::remove_file(p).map_err(Error::from),
                };
            }
            return Err(e);
        }
        done.push((p, old));
    }
    Ok(())
}
