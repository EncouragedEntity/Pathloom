//! Import task lists of other tools as an apply spec. Today: GitHub Spec Kit `specs/<feature>/tasks.md`.
//!
//! Each `## ...` section with checkbox tasks becomes a stage (tasks in `###` subsections included), all stages go
//! into one frame named after the feature. Dependencies follow Spec Kit's phase order: a phase waits for the one
//! before it; "User Story" phases wait only for the last non-story phase (stories run in parallel); the phase
//! after a run of stories waits for all of them. Re-importing the same file updates the same stage keys: new
//! tasks are appended, newly checked tasks are marked done, nothing is removed.

use crate::apply::{ApplySpec, DepSpec, FrameSpec, StageSpec};
use crate::error::{Error, Result};
use crate::keygen::generate_key;
use crate::model::Stage;
use crate::project::{Project, push_task};
use crate::stagefile::is_valid_key;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq)]
struct Phase {
    title: String,
    story: bool,
    /// (checked, title)
    tasks: Vec<(bool, String)>,
}

/// What an import would do, next to the spec it produced.
#[derive(Debug, Clone, Serialize)]
pub struct ImportReport {
    /// Feature name from the `# Tasks: ...` heading.
    pub feature: String,
    /// Stage keys in phase order.
    pub stages: Vec<String>,
    pub tasks: usize,
}

/// `- [ ] T001 ...` / `* [x] ...` at any indent -> (checked, rest).
fn checkbox(line: &str) -> Option<(bool, &str)> {
    let l = line.trim_start();
    let r = l.strip_prefix("- [").or_else(|| l.strip_prefix("* ["))?;
    let mut cs = r.chars();
    let done = match cs.next()? {
        ' ' => false,
        'x' | 'X' => true,
        _ => return None,
    };
    let rest = cs.as_str().strip_prefix(']')?.trim();
    (!rest.is_empty()).then_some((done, rest))
}

/// `Phase 3: User Story 1 - Login (Priority: P1)` -> `User Story 1 - Login (Priority: P1)`.
fn phase_title(h: &str) -> String {
    let h = h.trim();
    if h.to_lowercase().starts_with("phase")
        && let Some((head, rest)) = h.split_once(':')
        && head.chars().count() <= 16
        && !rest.trim().is_empty()
    {
        return rest.trim().to_string();
    }
    h.to_string()
}

fn is_story(h: &str) -> bool {
    let l = h.to_lowercase();
    l.contains("user story") || l.split(|c: char| !c.is_alphanumeric()).any(|w| w.len() > 2 && w.starts_with("us") && w[2..].chars().all(|c| c.is_ascii_digit()))
}

/// Parse `tasks.md`: (feature name, phases with at least one task).
fn parse(text: &str) -> (String, Vec<Phase>) {
    let mut feature = String::new();
    let mut phases: Vec<Phase> = Vec::new();
    let mut cur: Option<Phase> = None;
    let mut loose: Vec<(bool, String)> = Vec::new();
    let mut fence = false;
    for line in text.lines() {
        if line.trim_start().starts_with("```") {
            fence = !fence;
            continue;
        }
        if fence {
            continue;
        }
        if let Some(h) = line.strip_prefix("# ") {
            if feature.is_empty() {
                let h = h.trim();
                feature = h.strip_prefix("Tasks:").map_or(h, str::trim).to_string();
            }
        } else if let Some(h) = line.strip_prefix("## ") {
            phases.extend(cur.take().filter(|p| !p.tasks.is_empty()));
            cur = Some(Phase { title: phase_title(h), story: is_story(h), tasks: vec![] });
        } else if let Some((done, t)) = checkbox(line) {
            match &mut cur {
                Some(p) => p.tasks.push((done, t.to_string())),
                None => loose.push((done, t.to_string())),
            }
        }
    }
    phases.extend(cur.filter(|p| !p.tasks.is_empty()));
    if !loose.is_empty() {
        let title = if feature.is_empty() { "Tasks".to_string() } else { feature.clone() };
        phases.insert(0, Phase { title, story: false, tasks: loose });
    }
    (feature, phases)
}

/// Spec Kit dependency rule (see module docs): indices each phase depends on.
fn deps(phases: &[Phase]) -> Vec<Vec<usize>> {
    let mut out = Vec::with_capacity(phases.len());
    let mut last_base: Option<usize> = None;
    for (i, p) in phases.iter().enumerate() {
        let d = if p.story {
            last_base.into_iter().collect()
        } else if i > 0 && phases[i - 1].story {
            (last_base.map_or(0, |b| b + 1)..i).collect()
        } else {
            i.checked_sub(1).into_iter().collect()
        };
        if !p.story {
            last_base = Some(i);
        }
        out.push(d);
    }
    out
}

/// Uppercase ASCII letters only, 1-5 chars.
fn clean_prefix(p: &str) -> Option<String> {
    let s: String = p.chars().filter(char::is_ascii_alphabetic).map(|c| c.to_ascii_uppercase()).take(5).collect();
    (!s.is_empty()).then_some(s)
}

impl Project {
    /// Build an apply spec from a Spec Kit `tasks.md`. Stage keys are `<prefix><phase number>` (`AUTH1`, `AUTH2`,
    /// ...); `prefix` defaults to the initials of the feature name. An existing stage with such a key but another
    /// title fails with `InvalidSpec` (pass another prefix) so an import never edits unrelated stages.
    pub fn import_spec_kit(&self, text: &str, prefix: Option<&str>) -> Result<(ApplySpec, ImportReport)> {
        let (feature, phases) = parse(text);
        if phases.is_empty() {
            return Err(Error::InvalidSpec("no checkbox tasks (`- [ ] T001 ...`) found".into()));
        }
        let prefix = match prefix {
            Some(p) => clean_prefix(p).ok_or_else(|| Error::InvalidSpec(format!("bad prefix `{p}` (use 1-5 letters)")))?,
            None => clean_prefix(&generate_key(&feature, &|_| false)).unwrap_or_else(|| "SK".into()),
        };
        let existing = self.load_stages()?;
        let keys: Vec<String> = (1..=phases.len()).map(|n| format!("{prefix}{n}")).collect();
        if let Some(k) = keys.iter().find(|k| !is_valid_key(k)) {
            return Err(Error::InvalidSpec(format!("too many phases for prefix {prefix}: key {k} is too long")));
        }
        let dep_idx = deps(&phases);
        let mut spec = ApplySpec::default();
        let mut tasks = 0;
        for ((key, p), d) in keys.iter().zip(&phases).zip(&dep_idx) {
            let old = existing.iter().find(|s| &s.key == key);
            if let Some(s) = old
                && s.title != p.title
            {
                return Err(Error::InvalidSpec(format!(
                    "stage {key} already exists as \"{}\"; pass another prefix",
                    s.title
                )));
            }
            // Replay the appends on a copy to learn the ids of tasks that are checked in the file.
            let mut sim = old.cloned().unwrap_or_else(|| Stage::new(key, &p.title));
            let mut done = Vec::new();
            for (checked, t) in &p.tasks {
                let id = match sim.tasks.iter().find(|x| &x.title == t) {
                    Some(x) => (!x.is_done()).then(|| x.id.clone()),
                    None => {
                        push_task(&mut sim, t);
                        sim.tasks.last().map(|x| x.id.clone())
                    }
                };
                if *checked && let Some(id) = id {
                    done.push(id);
                }
            }
            tasks += p.tasks.len();
            spec.stages.push(StageSpec {
                id: Some(key.clone()),
                title: Some(p.title.clone()),
                // Keep dependencies the user may have edited since the first import.
                depends: old.is_none().then(|| d.iter().map(|&i| DepSpec::Key(keys[i].clone())).collect()),
                tasks: p.tasks.iter().map(|(_, t)| t.clone()).collect(),
                tasks_done: done,
                ..Default::default()
            });
        }
        let frame = if feature.is_empty() { "Spec Kit".to_string() } else { feature.clone() };
        spec.frames.push(FrameSpec { name: frame, members: keys.clone() });
        Ok((spec, ImportReport { feature, stages: keys, tasks }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TASKS: &str = "# Tasks: Photo Albums

**Input**: Design documents from `/specs/001-photo-albums/`

## Format: `[ID] [P?] [Story] Description`

```
- [ ] T999 example inside a code block
```

## Phase 1: Setup

- [x] T001 Create project structure
- [ ] T002 [P] Initialize Vite project

## Phase 2: Foundational (Blocking Prerequisites)

- [ ] T003 Set up SQLite schema

## Phase 3: User Story 1 - Create albums (Priority: P1) 🎯 MVP

### Tests for User Story 1

- [ ] T004 [P] [US1] Contract test for albums

### Implementation for User Story 1

- [ ] T005 [US1] Album model in src/models/album.ts

## Phase 4: User Story 2 - Drag photos (Priority: P2)

- [ ] T006 [US2] Drag and drop

## Phase 5: Polish & Cross-Cutting Concerns

- [ ] T007 Docs

## Dependencies & Execution Order

- Setup first, then Foundational.
";

    #[test]
    fn parse_phases_and_dependencies() {
        let (feature, phases) = parse(TASKS);
        assert_eq!(feature, "Photo Albums");
        let titles: Vec<&str> = phases.iter().map(|p| p.title.as_str()).collect();
        assert_eq!(
            titles,
            [
                "Setup",
                "Foundational (Blocking Prerequisites)",
                "User Story 1 - Create albums (Priority: P1) 🎯 MVP",
                "User Story 2 - Drag photos (Priority: P2)",
                "Polish & Cross-Cutting Concerns"
            ]
        );
        assert_eq!(phases[0].tasks, [(true, "T001 Create project structure".into()), (false, "T002 [P] Initialize Vite project".into())]);
        assert_eq!(phases[2].tasks.len(), 2, "### subsections belong to their phase");
        assert_eq!(deps(&phases), vec![vec![], vec![0], vec![1], vec![1], vec![2, 3]]);
        // no `##` sections: one stage from the H1
        let (_, flat) = parse("# Tasks: X\n- [ ] a\n- [x] b\n");
        assert_eq!((flat.len(), flat[0].title.as_str(), flat[0].tasks.len()), (1, "X", 2));
    }

    #[test]
    fn import_creates_then_updates_the_same_stages() {
        let dir = tempfile::tempdir().unwrap();
        let p = Project::init(dir.path(), "demo").unwrap();
        let (spec, rep) = p.import_spec_kit(TASKS, None).unwrap();
        assert_eq!(rep.stages, ["PA1", "PA2", "PA3", "PA4", "PA5"]);
        assert_eq!(rep.tasks, 7);
        p.apply(&spec, &Default::default()).unwrap();
        let s1 = p.load_stage("PA1").unwrap();
        assert_eq!(s1.tasks.iter().map(|t| (t.id.as_str(), t.done)).collect::<Vec<_>>(), [("PA1-01", true), ("PA1-02", false)]);
        let s5 = p.load_stage("PA5").unwrap();
        assert_eq!(s5.depends.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(), ["PA3", "PA4"]);
        let board = p.load_board("roadmap").unwrap();
        assert!(board.elements.iter().any(|e| e.get("name").and_then(|v| v.as_str()) == Some("Photo Albums")));

        // re-import: T002 checked, one new task; nothing duplicated, user-edited depends kept
        p.unlink("PA4", "PA5").unwrap();
        let again = TASKS.replace("- [ ] T002", "- [x] T002").replace("- [ ] T007 Docs", "- [ ] T007 Docs\n- [ ] T008 Release");
        let (spec2, _) = p.import_spec_kit(&again, Some("pa")).unwrap();
        p.apply(&spec2, &Default::default()).unwrap();
        assert!(p.load_stage("PA1").unwrap().tasks.iter().all(|t| t.done));
        let s5 = p.load_stage("PA5").unwrap();
        assert_eq!(s5.tasks.len(), 2);
        assert_eq!(s5.depends.len(), 1);

        // a clashing key is refused
        p.create_stage("Something else", Some("X1")).unwrap();
        assert!(matches!(p.import_spec_kit(TASKS, Some("x")), Err(Error::InvalidSpec(_))));
        assert!(matches!(p.import_spec_kit("# nothing here", None), Err(Error::InvalidSpec(_))));
    }
}
