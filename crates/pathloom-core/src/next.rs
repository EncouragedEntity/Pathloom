//! "What next" queries, comments and file hashes.

use crate::error::{Error, Result};
use crate::fsutil::now_minute;
use crate::hash::hash_bytes;
use crate::model::*;
use crate::project::{Project, check_key};
use crate::status::compute_statuses;
use serde::{Deserialize, Serialize};

/// An open task of a `ready`/`active` stage (spec §5).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct NextTask {
    pub task_id: String,
    pub title: String,
    pub stage_key: String,
    pub stage_title: String,
    pub who: Who,
    pub priority: Priority,
    pub due: Option<String>,
}

fn rank(p: Priority) -> u8 {
    match p {
        Priority::High => 0,
        Priority::Med => 1,
        Priority::Low => 2,
    }
}

impl Project {
    /// sha256 (hex) of the stage file's bytes; pass it back in `expected` to detect concurrent edits.
    pub fn stage_hash(&self, key: &str) -> Result<String> {
        check_key(key)?;
        let path = self.stage_path(key);
        if !path.is_file() {
            return Err(Error::NotFound(format!("stage {key}")));
        }
        Ok(hash_bytes(&std::fs::read(path)?))
    }

    /// Open tasks of stages that are `ready` or `active`, sorted by priority (high first), due date
    /// (earliest first, none last), then stage key and file order. For a task with subtasks the open
    /// subtasks are listed. `limit` 0 = no limit.
    pub fn next_tasks(&self, limit: usize) -> Result<Vec<NextTask>> {
        let stages = self.load_stages()?;
        let statuses = compute_statuses(&stages);
        let mut out: Vec<NextTask> = Vec::new();
        for s in &stages {
            if !matches!(statuses.get(&s.key), Some(Status::Ready | Status::Active)) {
                continue;
            }
            let open = s.tasks.iter().flat_map(|t| if t.sub.is_empty() { vec![t] } else { t.sub.iter().collect() });
            for t in open.filter(|t| !t.done) {
                out.push(NextTask {
                    task_id: t.id.clone(),
                    title: t.title.clone(),
                    stage_key: s.key.clone(),
                    stage_title: s.title.clone(),
                    who: s.who,
                    priority: s.priority,
                    due: s.due.clone(),
                });
            }
        }
        out.sort_by(|a, b| {
            rank(a.priority).cmp(&rank(b.priority)).then_with(|| match (&a.due, &b.due) {
                (Some(x), Some(y)) => x.cmp(y),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            })
        });
        if limit > 0 {
            out.truncate(limit);
        }
        Ok(out)
    }

    /// Append `- <UTC minute> <author> — <text>` to the stage's `## Comments`.
    pub fn add_comment(&self, key: &str, author: &str, text: &str) -> Result<Stage> {
        let text = text.replace(['\r', '\n'], " ");
        let text = text.trim();
        if text.is_empty() {
            return Err(Error::InvalidSpec("comment text must not be empty".into()));
        }
        let author = author.replace(['\r', '\n'], " ");
        let author = if author.trim().is_empty() { "agent" } else { author.trim() };
        self.edit_stage(key, |s| {
            s.comments.push(Comment { at: now_minute(), author: author.into(), text: text.into() });
            Ok(())
        })
    }
}
