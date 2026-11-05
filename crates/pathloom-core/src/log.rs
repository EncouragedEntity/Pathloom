//! Agent activity log: `.pathloom/log/agent.jsonl`, one JSON object per line, append-only.

use crate::error::Result;
use crate::fsutil::{format_secs, now_secs};
use crate::project::Project;
use serde::{Deserialize, Serialize};
use std::io::Write;

const LOG_FILE: &str = ".pathloom/log/agent.jsonl";
const OLD_LOG_FILE: &str = ".pathloom/log/agent.1.jsonl";
/// The log is rotated to `agent.1.jsonl` when it grows past this.
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

/// One logged action. `source` is `mcp` | `cli` | `app`.
/// Tokens and money an agent reports for its own work (Pathloom only shows it; it never counts or calls models).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(default)]
pub struct Usage {
    pub tokens_in: u64,
    pub tokens_out: u64,
    /// US dollars.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
}

/// Usage totals per agent and per stage (from the whole log).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct UsageSummary {
    pub total: Usage,
    pub by_agent: std::collections::BTreeMap<String, Usage>,
    pub by_stage: std::collections::BTreeMap<String, Usage>,
}

impl Usage {
    fn add(&mut self, o: &Usage) {
        self.tokens_in = self.tokens_in.saturating_add(o.tokens_in);
        self.tokens_out = self.tokens_out.saturating_add(o.tokens_out);
        if let Some(c) = o.cost_usd {
            *self.cost_usd.get_or_insert(0.0) += c;
        }
    }

    /// Reject negative or non-finite cost.
    pub fn validate(&self) -> Result<()> {
        if self.cost_usd.is_some_and(|c| !c.is_finite() || c < 0.0) {
            return Err(crate::error::Error::InvalidSpec("cost_usd must be a non-negative number".into()));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(default)]
pub struct LogEntry {
    pub at: String,
    pub author: String,
    pub source: String,
    pub action: String,
    pub summary: String,
    pub stages: Vec<String>,
    pub tasks: Vec<String>,
    pub files: Vec<String>,
    /// External client session the action was done from (optional).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<crate::session::SessionRef>,
    /// Tokens / cost the client reported with this action (optional).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
}

impl Project {
    /// Append `entry` (an empty `at` becomes now). Callers should treat an `Err` as a warning only:
    /// a log failure must never fail the action that was logged.
    pub fn log_action(&self, entry: &LogEntry) -> Result<()> {
        self.log_action_limited(entry, MAX_LOG_BYTES)
    }

    pub(crate) fn log_action_limited(&self, entry: &LogEntry, max_bytes: u64) -> Result<()> {
        let mut e = entry.clone();
        if e.at.is_empty() {
            e.at = format_secs(now_secs());
        }
        let path = self.root.join(LOG_FILE);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        if std::fs::metadata(&path).is_ok_and(|m| m.len() > max_bytes) {
            let old = self.root.join(OLD_LOG_FILE);
            let _ = std::fs::remove_file(&old); // Windows: rename does not replace
            std::fs::rename(&path, &old)?;
        }
        let mut line = serde_json::to_string(&e).map_err(|e| crate::error::Error::InvalidSpec(e.to_string()))?;
        line.push('\n');
        std::fs::OpenOptions::new().create(true).append(true).open(&path)?.write_all(line.as_bytes())?;
        Ok(())
    }

    /// Sum of all reported usage (current and rotated log), per agent and per stage. A usage entry that
    /// touches several stages is split evenly between them.
    pub fn usage_summary(&self) -> Result<UsageSummary> {
        let mut out = UsageSummary::default();
        for e in self.read_log(0, None)? {
            let Some(u) = &e.usage else { continue };
            out.total.add(u);
            out.by_agent.entry(e.author.clone()).or_default().add(u);
            let n = e.stages.len().max(1) as u64;
            for k in &e.stages {
                let part = Usage {
                    tokens_in: u.tokens_in / n,
                    tokens_out: u.tokens_out / n,
                    cost_usd: u.cost_usd.map(|c| c / n as f64),
                };
                out.by_stage.entry(k.clone()).or_default().add(&part);
            }
        }
        Ok(out)
    }

    /// Newest entries first, at most `limit` (0 = all), only those touching `stage` when given.
    /// Lines that are not valid entries are skipped.
    pub fn read_log(&self, limit: usize, stage: Option<&str>) -> Result<Vec<LogEntry>> {
        let mut out = Vec::new();
        for file in [LOG_FILE, OLD_LOG_FILE] {
            let Ok(text) = std::fs::read_to_string(self.root.join(file)) else { continue };
            let entries = text
                .lines()
                .rev()
                .filter_map(|l| serde_json::from_str::<LogEntry>(l).ok())
                .filter(|e| stage.is_none_or(|s| e.stages.iter().any(|x| x == s)));
            for e in entries {
                if limit != 0 && out.len() >= limit {
                    return Ok(out);
                }
                out.push(e);
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(action: &str, stages: &[&str]) -> LogEntry {
        LogEntry {
            author: "claude".into(),
            source: "mcp".into(),
            action: action.into(),
            stages: stages.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }
    }

    fn actions(v: &[LogEntry]) -> Vec<&str> {
        v.iter().map(|e| e.action.as_str()).collect()
    }

    #[test]
    fn append_read_filter_and_broken_lines() {
        let dir = tempfile::tempdir().unwrap();
        let p = Project::init(dir.path(), "demo").unwrap();
        assert!(p.read_log(10, None).unwrap().is_empty());
        p.log_action(&entry("one", &["A"])).unwrap();
        let path = dir.path().join(LOG_FILE);
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(b"{broken\n\n").unwrap();
        drop(f);
        p.log_action(&entry("two", &["B"])).unwrap();
        p.log_action(&entry("three", &["A", "B"])).unwrap();
        let all = p.read_log(0, None).unwrap();
        assert_eq!(actions(&all), ["three", "two", "one"]);
        assert!(all[0].at.ends_with('Z') && all[0].at.len() == 20);
        assert_eq!(p.read_log(2, None).unwrap().len(), 2);
        assert_eq!(actions(&p.read_log(10, Some("A")).unwrap()), ["three", "one"]);
    }

    #[test]
    fn rotation_keeps_one_old_file_and_reads_across() {
        let dir = tempfile::tempdir().unwrap();
        let p = Project::init(dir.path(), "demo").unwrap();
        p.log_action_limited(&entry("old", &[]), 1).unwrap();
        p.log_action_limited(&entry("mid", &[]), 1).unwrap(); // size > 1 -> rotated, "old" moves to .1
        p.log_action_limited(&entry("new", &[]), 1).unwrap(); // rotated again, "old" is dropped
        assert!(dir.path().join(OLD_LOG_FILE).is_file());
        assert_eq!(actions(&p.read_log(0, None).unwrap()), ["new", "mid"]);
    }
}
