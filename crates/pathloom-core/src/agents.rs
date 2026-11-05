//! Agent profiles (`plan/agents.json`): display name, color and avatar of each agent id (m7 contract §2).
//!
//! The file is part of the plan (committed): names and colors are shared by the team.

use crate::error::{Error, Result};
use crate::fsutil::write_atomic;
use crate::project::Project;
use serde::{Deserialize, Serialize};

const NAME_MAX: usize = 40;
const IMAGE_EXTS: [&str; 5] = ["png", "jpg", "jpeg", "webp", "svg"];

/// One agent profile. Empty `color` / `avatar` mean "not set" (the app generates them).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(default)]
pub struct AgentProfile {
    /// `[a-z0-9._-]{1,32}`, the same id as in `who: ai:<id>`, claims and the log.
    pub id: String,
    /// Display name, up to 40 characters.
    pub name: String,
    /// `#rgb` or `#rrggbb`.
    pub color: String,
    /// One emoji / up to 2 characters, or `assets/<file>` (png, jpg, webp, svg) next to the plan.
    pub avatar: String,
    /// Free label: `agent` (default), `orchestrator`, `reviewer`, ...
    pub kind: String,
}

#[derive(Default, Serialize, Deserialize)]
struct AgentsFile {
    #[serde(default)]
    agents: Vec<AgentProfile>,
}

fn bad(msg: impl Into<String>) -> Error {
    Error::InvalidSpec(msg.into())
}

/// True for a valid agent id `[a-z0-9._-]{1,32}`.
pub fn is_valid_agent_id(id: &str) -> bool {
    (1..=32).contains(&id.len()) && id.chars().all(|c| matches!(c, 'a'..='z' | '0'..='9' | '.' | '_' | '-'))
}

impl AgentProfile {
    /// Trim, fill defaults (`name` = id, `kind` = `agent`) and validate.
    pub fn normalize(mut self) -> Result<AgentProfile> {
        self.id = self.id.trim().to_string();
        self.name = self.name.trim().to_string();
        self.color = self.color.trim().to_string();
        self.avatar = self.avatar.trim().to_string();
        self.kind = self.kind.trim().to_string();
        if !is_valid_agent_id(&self.id) {
            return Err(bad(format!("agent id `{}` must be 1-32 chars of [a-z0-9._-]", self.id)));
        }
        if self.name.is_empty() {
            self.name.clone_from(&self.id);
        }
        if self.name.chars().count() > NAME_MAX || self.name.chars().any(char::is_control) {
            return Err(bad(format!("agent name must be at most {NAME_MAX} characters on one line")));
        }
        if !self.color.is_empty() && !valid_color(&self.color) {
            return Err(bad(format!("agent color `{}` must be #rgb or #rrggbb", self.color)));
        }
        if !self.avatar.is_empty() {
            check_avatar(&self.avatar)?;
        }
        if self.kind.is_empty() {
            self.kind = "agent".into();
        }
        if self.kind.chars().count() > 32 || self.kind.chars().any(char::is_control) {
            return Err(bad("agent kind must be at most 32 characters on one line"));
        }
        Ok(self)
    }
}

fn valid_color(c: &str) -> bool {
    c.strip_prefix('#').is_some_and(|h| matches!(h.len(), 3 | 6) && h.chars().all(|x| x.is_ascii_hexdigit()))
}

fn check_avatar(a: &str) -> Result<()> {
    if let Some(file) = a.strip_prefix("assets/") {
        let ext_ok = file.rsplit_once('.').is_some_and(|(_, e)| IMAGE_EXTS.contains(&e.to_ascii_lowercase().as_str()));
        let path_ok = !file.contains(['\\', ':'])
            && file.split('/').all(|s| !s.is_empty() && s != "." && s != "..");
        if ext_ok && path_ok {
            return Ok(());
        }
        return Err(bad(format!("avatar `{a}` must be assets/<file>.png|jpg|webp|svg without `..`")));
    }
    if a.chars().count() <= 2 && !a.chars().any(|c| c.is_control() || c.is_whitespace() || c == '/') {
        return Ok(());
    }
    Err(bad(format!("avatar `{a}` must be one emoji (up to 2 characters) or assets/<file>")))
}

impl Project {
    fn agents_path(&self) -> std::path::PathBuf {
        self.plan_dir().join("agents.json")
    }

    /// All profiles sorted by id. A missing file is "no profiles".
    pub fn agents(&self) -> Result<Vec<AgentProfile>> {
        let path = self.agents_path();
        let text = match std::fs::read_to_string(&path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
            Err(e) => return Err(e.into()),
        };
        let mut f: AgentsFile = serde_json::from_str(&text).map_err(|e| crate::error::parse_err(&path, e))?;
        f.agents.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(f.agents)
    }

    fn write_agents(&self, mut agents: Vec<AgentProfile>) -> Result<()> {
        agents.sort_by(|a, b| a.id.cmp(&b.id));
        let mut text = serde_json::to_string_pretty(&AgentsFile { agents }).map_err(|e| bad(e.to_string()))?;
        text.push('\n');
        write_atomic(&self.agents_path(), text.as_bytes())
    }

    /// Insert or replace the profile with `profile.id` (validated and normalized; returned).
    pub fn upsert_agent(&self, profile: AgentProfile) -> Result<AgentProfile> {
        let p = profile.normalize()?;
        let _lock = self.lock_claims()?;
        let mut all = self.agents()?;
        all.retain(|a| a.id != p.id);
        all.push(p.clone());
        self.write_agents(all)?;
        Ok(p)
    }

    /// Remove a profile; unknown id is `NotFound`.
    pub fn remove_agent(&self, id: &str) -> Result<()> {
        let _lock = self.lock_claims()?;
        let mut all = self.agents()?;
        let before = all.len();
        all.retain(|a| a.id != id);
        if all.len() == before {
            return Err(Error::NotFound(format!("agent {id}")));
        }
        self.write_agents(all)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prof(id: &str, name: &str, color: &str, avatar: &str) -> AgentProfile {
        AgentProfile { id: id.into(), name: name.into(), color: color.into(), avatar: avatar.into(), kind: String::new() }
    }

    #[test]
    fn validation() {
        for ok in [("a", "A", "#fff", "🤖"), ("claude-code", "Claude", "#d97757", "assets/maestro.png"), ("x.y_z", "", "", "")] {
            assert!(prof(ok.0, ok.1, ok.2, ok.3).normalize().is_ok(), "{ok:?}");
        }
        let n = prof("x", "", "", "").normalize().unwrap();
        assert_eq!((n.name.as_str(), n.kind.as_str()), ("x", "agent"));
        for id in ["", "A", "a b", &"a".repeat(33)] {
            assert!(prof(id, "n", "", "").normalize().is_err(), "{id}");
        }
        assert!(prof("a", &"n".repeat(41), "", "").normalize().is_err());
        assert!(prof("a", &"n".repeat(40), "", "").normalize().is_ok());
        for c in ["red", "#ff", "#ggg", "fff", "#12345", "#1234567"] {
            assert!(prof("a", "n", c, "").normalize().is_err(), "{c}");
        }
        for av in ["abc", "assets/../x.png", "assets/x.exe", "assets/x", "http://a/b.png", "assets/", "assets//x.png", "assets\\x.png", "a/"] {
            assert!(prof("a", "n", "", av).normalize().is_err(), "{av}");
        }
    }
}
