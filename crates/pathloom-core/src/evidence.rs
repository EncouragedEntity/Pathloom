//! Proof that a task is really done (`evidence` in the stage frontmatter): the check an agent ran and its result.
//!
//! Stored per task id; kept only for tasks that exist and are done (stale entries are dropped on write).

use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};

/// Result of a check (tests, build, lint) attached to a done task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct Evidence {
    /// Command that was run, e.g. `cargo test --workspace` (1-500 chars, one line).
    pub command: String,
    /// Process exit code. Only 0 can mark a task done.
    pub exit_code: i32,
    /// How long the check ran, in milliseconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// Short result, e.g. `94 passed` (up to 120 chars).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// Link (`https://...`) or project-relative path to the full log, without spaces.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log: Option<String>,
    /// When it was attached (RFC3339 UTC). Set by Pathloom.
    #[serde(default)]
    pub at: String,
    /// Who attached it (agent id or `me`). Set by Pathloom.
    #[serde(default)]
    pub by: String,
}

fn bad(msg: impl Into<String>) -> Error {
    Error::InvalidSpec(msg.into())
}

fn one_line(s: &str) -> String {
    s.replace(['\r', '\n'], " ").trim().to_string()
}

impl Evidence {
    /// Trim to one line, drop empty optional fields and validate.
    pub fn normalize(self) -> Result<Evidence> {
        let opt = |v: Option<String>| v.map(|s| one_line(&s)).filter(|s| !s.is_empty());
        let e = Evidence {
            command: one_line(&self.command),
            exit_code: self.exit_code,
            duration_ms: self.duration_ms,
            summary: opt(self.summary),
            log: opt(self.log),
            at: self.at.trim().to_string(),
            by: self.by.trim().to_string(),
        };
        if !(1..=500).contains(&e.command.chars().count()) {
            return Err(bad("evidence command must be 1-500 characters"));
        }
        if e.summary.as_ref().is_some_and(|s| s.chars().count() > 120) {
            return Err(bad("evidence summary must be at most 120 characters"));
        }
        if let Some(l) = &e.log {
            let lower = l.to_ascii_lowercase();
            if l.len() > 2048 || l.contains(' ') || ["javascript:", "data:", "vbscript:"].iter().any(|s| lower.starts_with(s)) {
                return Err(bad("evidence log must be a link or a path without spaces (no javascript:/data: links)"));
            }
        }
        Ok(e)
    }

    /// The check passed (exit code 0).
    pub fn passed(&self) -> bool {
        self.exit_code == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(cmd: &str, code: i32) -> Evidence {
        Evidence { command: cmd.into(), exit_code: code, duration_ms: None, summary: None, log: None, at: String::new(), by: String::new() }
    }

    #[test]
    fn normalize_trims_and_validates() {
        let e = Evidence { summary: Some("  ".into()), log: Some(" ci/log.txt ".into()), ..ev(" cargo test\n", 0) }.normalize().unwrap();
        assert_eq!((e.command.as_str(), e.summary.as_deref(), e.log.as_deref()), ("cargo test", None, Some("ci/log.txt")));
        assert!(e.passed() && !ev("x", 1).passed());
        assert!(ev(" ", 0).normalize().is_err());
        assert!(ev(&"x".repeat(501), 0).normalize().is_err());
        assert!(Evidence { log: Some("javascript:alert(1)".into()), ..ev("x", 0) }.normalize().is_err());
        assert!(Evidence { summary: Some("y".repeat(121)), ..ev("x", 0) }.normalize().is_err());
    }
}
