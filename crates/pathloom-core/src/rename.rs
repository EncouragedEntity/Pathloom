//! Change a stage key (`TB0` -> `AUTH`) everywhere it is used, in one step.

use crate::error::{Error, Result};
use crate::layout::card_ref;
use crate::model::Stage;
use crate::project::{Project, check_key};
use serde_json::Value;
use std::collections::BTreeMap;

/// `TB0-03a` -> `AUTH-03a` when `id` belongs to stage `old`.
fn rename_id(id: &str, old: &str, new: &str) -> Option<String> {
    id.strip_prefix(old).and_then(|r| r.strip_prefix('-')).map(|rest| format!("{new}-{rest}"))
}

fn rename_keys<V>(m: &mut BTreeMap<String, V>, old: &str, new: &str) {
    let moved: Vec<(String, String)> = m
        .keys()
        .filter_map(|k| if k == old { Some((k.clone(), new.to_string())) } else { rename_id(k, old, new).map(|n| (k.clone(), n)) })
        .collect();
    for (from, to) in moved {
        if let Some(v) = m.remove(&from) {
            m.insert(to, v);
        }
    }
}

impl Project {
    /// Rename stage `old` to `new`: the stage file, its task ids (`OLD-01` -> `NEW-01`), evidence and task details,
    /// `depends` of other stages, cards on every board and live claims. Fails when `new` is taken or invalid.
    /// Files are written first and the old stage file is removed last, so a failure leaves the old key working.
    pub fn rename_stage_key(&self, old: &str, new: &str) -> Result<Stage> {
        check_key(old)?;
        check_key(new)?;
        if old == new {
            return self.load_stage(old);
        }
        if self.stage_path(new).exists() {
            return Err(Error::DuplicateKey(new.into()));
        }
        let mut stage = self.load_stage(old)?;
        stage.key = new.to_string();
        for t in &mut stage.tasks {
            if let Some(n) = rename_id(&t.id, old, new) {
                t.id = n;
            }
            for s in &mut t.sub {
                if let Some(n) = rename_id(&s.id, old, new) {
                    s.id = n;
                }
            }
        }
        rename_keys(&mut stage.evidence, old, new);
        rename_keys(&mut stage.task_info, old, new);

        // other stages that depend on it
        let mut others: Vec<Stage> = Vec::new();
        for mut s in self.load_stages()? {
            if s.key == old {
                continue;
            }
            let mut changed = false;
            for d in &mut s.depends {
                if d.id == old {
                    d.id = new.to_string();
                    changed = true;
                }
            }
            if changed {
                others.push(s);
            }
        }
        // boards
        let mut boards = Vec::new();
        for name in self.list_boards()? {
            let mut b = self.load_board(&name)?;
            let mut changed = false;
            for e in &mut b.elements {
                if card_ref(e) == Some(old) {
                    e.insert("ref".into(), Value::from(new));
                    changed = true;
                }
            }
            if changed {
                boards.push((name, b));
            }
        }

        self.save_stage(&stage)?;
        for s in &others {
            self.save_stage(s)?;
        }
        for (name, b) in &boards {
            self.save_board(name, b)?;
        }
        self.rename_claims(old, new);
        std::fs::remove_file(self.stage_path(old))?;
        Ok(stage)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::StageKind;

    #[test]
    fn renames_everywhere() {
        let dir = tempfile::tempdir().unwrap();
        let p = Project::init(dir.path(), "demo").unwrap();
        let spec = Project::parse_spec(
            "stages:
  - {id: TB0, title: Base, tasks: [one, two]}
  - {id: B, title: B, tasks: [x], depends: [TB0]}",
        )
        .unwrap();
        p.apply(&spec, &Default::default()).unwrap();
        p.add_subtask("TB0-02", "sub").unwrap();
        p.set_task_note("TB0-01", "note").unwrap();
        p.claim_task("TB0-02", "claude", 0, "").unwrap();

        let s = p.rename_stage_key("TB0", "AUTH").unwrap();
        assert_eq!(s.key, "AUTH");
        assert_eq!(s.tasks[1].id, "AUTH-02");
        assert_eq!(s.tasks[1].sub[0].id, "AUTH-02a");
        assert_eq!(s.task_info["AUTH-01"].note, "note");
        assert!(!p.stage_path("TB0").exists());
        assert_eq!(p.load_stage("B").unwrap().depends[0].id, "AUTH");
        let b = p.load_board("roadmap").unwrap();
        assert!(b.elements.iter().any(|e| card_ref(e) == Some("AUTH")));
        assert!(!b.elements.iter().any(|e| card_ref(e) == Some("TB0")));
        assert_eq!(p.claims().unwrap()[0].task_id, "AUTH-02");
        assert_eq!(p.load_stage("AUTH").unwrap().kind, StageKind::Stage);
        // taken / invalid keys
        assert!(matches!(p.rename_stage_key("AUTH", "B"), Err(Error::DuplicateKey(_))));
        assert!(p.rename_stage_key("AUTH", "bad key").is_err());
        assert!(matches!(p.rename_stage_key("NOPE", "X"), Err(Error::NotFound(_))));
    }
}
