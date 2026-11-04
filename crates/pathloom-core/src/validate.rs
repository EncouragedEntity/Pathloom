//! Integrity checks (`validate`) and the safe automatic fixes (`validate_fix`).

use crate::error::Result;
use crate::layout::{card_ref, el_id};
use crate::model::*;
use crate::project::Project;
use crate::status::find_cycle;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;

/// A problem found by [`Project::validate`]. Codes: `PARSE_ERROR`, `DUPLICATE_KEY`, `BROKEN_DEPEND`,
/// `BROKEN_CARD`, `CYCLE`, `INVALID_TASK_ID`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct Issue {
    pub code: String,
    pub message: String,
    /// File the problem is in, relative to the project root.
    pub path: String,
}

fn issue(code: &str, message: impl Into<String>, path: &str) -> Issue {
    Issue { code: code.into(), message: message.into(), path: path.into() }
}

/// `KEY-NN` or `KEY-NNx` where `x` is a subtask letter; `sub` = must be a subtask of `parent`.
fn task_id_ok(id: &str, key: &str, parent: Option<&str>) -> bool {
    let Some(rest) = id.strip_prefix(key).and_then(|r| r.strip_prefix('-')) else { return false };
    let digits = rest.trim_end_matches(|c: char| c.is_ascii_lowercase());
    let letters = &rest[digits.len()..];
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    match parent {
        None => letters.is_empty(),
        Some(p) => letters.len() == 1 && id.starts_with(p),
    }
}

impl Project {
    fn rel(&self, p: &Path) -> String {
        p.strip_prefix(&self.root).unwrap_or(p).to_string_lossy().replace('\\', "/")
    }

    /// Stage files that parse, plus issues for those that do not.
    fn scan_stages(&self, issues: &mut Vec<Issue>) -> Result<Vec<Stage>> {
        let mut out = Vec::new();
        if let Ok(rd) = std::fs::read_dir(self.plan_dir().join("stages")) {
            for e in rd {
                let path = e?.path();
                if path.extension().is_some_and(|x| x == "md") {
                    match crate::project::read_text(&path).and_then(|t| Stage::from_markdown(&path, &t)) {
                        Ok(s) => out.push(s),
                        Err(err) => issues.push(issue("PARSE_ERROR", err.to_string(), &self.rel(&path))),
                    }
                }
            }
        }
        out.sort_by(|a, b| a.key.cmp(&b.key));
        Ok(out)
    }

    fn scan_boards(&self, issues: &mut Vec<Issue>) -> Result<Vec<(String, Board)>> {
        let mut out = Vec::new();
        for name in self.list_boards()? {
            match self.load_board(&name) {
                Ok(b) => out.push((name, b)),
                Err(err) => issues.push(issue("PARSE_ERROR", err.to_string(), &self.rel(&self.board_path(&name)))),
            }
        }
        Ok(out)
    }

    /// Check all stage and board files. An empty list means the project is consistent.
    pub fn validate(&self) -> Result<Vec<Issue>> {
        let mut issues = Vec::new();
        let stages = self.scan_stages(&mut issues)?;
        let keys: HashSet<&str> = stages.iter().map(|s| s.key.as_str()).collect();
        for s in &stages {
            let path = self.rel(&self.stage_path(&s.key));
            for d in s.depends.iter().filter(|d| !keys.contains(d.id.as_str())) {
                issues.push(issue("BROKEN_DEPEND", format!("{} depends on missing stage {}", s.key, d.id), &path));
            }
            let mut ids = HashSet::new();
            for t in &s.tasks {
                for (id, parent) in std::iter::once((&t.id, None)).chain(t.sub.iter().map(|x| (&x.id, Some(t.id.as_str())))) {
                    if !task_id_ok(id, &s.key, parent) {
                        issues.push(issue("INVALID_TASK_ID", format!("task id `{id}` is not valid in {}", s.key), &path));
                    }
                    if !ids.insert(id.as_str()) {
                        issues.push(issue("DUPLICATE_KEY", format!("duplicate task id {id} in {}", s.key), &path));
                    }
                }
            }
        }
        if let Some(c) = find_cycle(&stages) {
            issues.push(issue("CYCLE", format!("dependency cycle: {}", c.join(" -> ")), &self.rel(&self.plan_dir().join("stages"))));
        }
        for (name, b) in self.scan_boards(&mut issues)? {
            let path = self.rel(&self.board_path(&name));
            let mut ids = HashSet::new();
            for el in &b.elements {
                if !ids.insert(el_id(el)) {
                    issues.push(issue("DUPLICATE_KEY", format!("duplicate element id {} on board {name}", el_id(el)), &path));
                }
                if let Some(r) = card_ref(el).filter(|r| !keys.contains(r)) {
                    issues.push(issue("BROKEN_CARD", format!("card {} on board {name} refers to missing stage {r}", el_id(el)), &path));
                }
            }
        }
        Ok(issues)
    }

    /// Safe fixes only: drop `depends` entries on missing stages and card elements of missing stages.
    /// Returns a description of each fix. Everything else (cycles, bad ids) is left for a human.
    pub fn validate_fix(&self) -> Result<Vec<String>> {
        let mut ignored = Vec::new();
        let stages = self.scan_stages(&mut ignored)?;
        let keys: HashSet<String> = stages.iter().map(|s| s.key.clone()).collect();
        let mut fixes = Vec::new();
        for mut s in stages {
            let before = s.depends.len();
            let removed: Vec<String> = s.depends.iter().filter(|d| !keys.contains(&d.id)).map(|d| d.id.clone()).collect();
            if removed.is_empty() {
                continue;
            }
            s.depends.retain(|d| keys.contains(&d.id));
            debug_assert!(s.depends.len() < before);
            self.save_stage(&s)?;
            fixes.push(format!("{}: removed broken depends {}", s.key, removed.join(", ")));
        }
        for (name, mut b) in self.scan_boards(&mut ignored)? {
            let before = b.elements.len();
            b.elements.retain(|el| card_ref(el).is_none_or(|r| keys.contains(r)));
            if b.elements.len() != before {
                self.save_board(&name, &b)?;
                fixes.push(format!("board {name}: removed {} card(s) of missing stages", before - b.elements.len()));
            }
        }
        Ok(fixes)
    }
}
