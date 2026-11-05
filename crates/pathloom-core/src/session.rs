//! Links to external client sessions (Maestro, Codex, ...): `{client, id, url?, title?}` (m7 contract §4).

use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};

/// Most sessions kept per stage; older ones are dropped.
pub const MAX_STAGE_SESSIONS: usize = 20;

/// Reference to a session of an external client that worked on a stage or claimed a task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct SessionRef {
    /// `[a-z0-9._-]{1,32}`
    pub client: String,
    /// Up to 128 printable characters.
    pub id: String,
    /// `http(s)://` or a custom scheme `app://`; never `javascript:`, `data:` or `file:`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Up to 120 characters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

fn bad(msg: impl Into<String>) -> Error {
    Error::InvalidSpec(msg.into())
}

fn clean(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

impl SessionRef {
    /// Trim, drop empty `url`/`title` and validate.
    pub fn normalize(self) -> Result<SessionRef> {
        let s = SessionRef {
            client: self.client.trim().to_string(),
            id: self.id.trim().to_string(),
            url: clean(self.url),
            title: clean(self.title),
        };
        s.validate()?;
        Ok(s)
    }

    pub fn validate(&self) -> Result<()> {
        let c = &self.client;
        if !(1..=32).contains(&c.chars().count()) || !c.chars().all(|x| matches!(x, 'a'..='z' | '0'..='9' | '.' | '_' | '-')) {
            return Err(bad(format!("session client `{c}` must be 1-32 chars of [a-z0-9._-]")));
        }
        if !(1..=128).contains(&self.id.chars().count()) || self.id.chars().any(char::is_control) {
            return Err(bad("session id must be 1-128 printable characters"));
        }
        if let Some(t) = &self.title
            && (t.chars().count() > 120 || t.chars().any(char::is_control))
        {
            return Err(bad("session title must be at most 120 characters on one line"));
        }
        if let Some(u) = &self.url {
            check_url(u)?;
        }
        Ok(())
    }

    fn same(&self, o: &SessionRef) -> bool {
        self.client == o.client && self.id == o.id
    }
}

fn check_url(u: &str) -> Result<()> {
    let err = || bad(format!("session url `{u}` must be http(s):// or a custom scheme like app://, without spaces"));
    if u.len() > 2048 || u.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(err());
    }
    let (scheme, rest) = u.split_once("://").ok_or_else(err)?;
    let mut cs = scheme.chars();
    let ok = cs.next().is_some_and(|c| c.is_ascii_alphabetic())
        && cs.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'));
    if !ok || rest.is_empty() {
        return Err(err());
    }
    if matches!(scheme.to_ascii_lowercase().as_str(), "javascript" | "data" | "file" | "vbscript" | "blob") {
        return Err(bad(format!("session url scheme `{scheme}` is not allowed")));
    }
    Ok(())
}

/// Add `s` to `list` (dedup by client+id: the old entry is replaced and moves to the end, keeping its
/// `url`/`title` when `s` has none). Keeps only the newest [`MAX_STAGE_SESSIONS`].
pub(crate) fn push_session(list: &mut Vec<SessionRef>, mut s: SessionRef) {
    if let Some(i) = list.iter().position(|x| x.same(&s)) {
        let old = list.remove(i);
        s.url = s.url.or(old.url);
        s.title = s.title.or(old.title);
    }
    list.push(s);
    if list.len() > MAX_STAGE_SESSIONS {
        list.drain(..list.len() - MAX_STAGE_SESSIONS);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(client: &str, id: &str, url: Option<&str>) -> SessionRef {
        SessionRef { client: client.into(), id: id.into(), url: url.map(Into::into), title: None }
    }

    #[test]
    fn validation() {
        for ok in [Some("maestro://session/x"), Some("https://a.b/c"), Some("vscode-insiders://x"), None] {
            assert!(s("maestro", "sess_1", ok).normalize().is_ok(), "{ok:?}");
        }
        for url in ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "FILE://x", "nope", "://x", "a b://x", "http://", "1ab://x", "http://a b"] {
            assert!(s("maestro", "1", Some(url)).normalize().is_err(), "{url}");
        }
        for c in ["", "Maestro", "a b", &"a".repeat(33)] {
            assert!(s(c, "1", None).normalize().is_err(), "{c}");
        }
        assert!(s("m", "", None).normalize().is_err());
        assert!(s("m", &"x".repeat(129), None).normalize().is_err());
        assert!(s("m", "a\nb", None).normalize().is_err());
        let mut t = s("m", "1", None);
        t.title = Some("x".repeat(121));
        assert!(t.normalize().is_err());
        let n = SessionRef { client: " m ".into(), id: " 1 ".into(), url: Some(" ".into()), title: Some(" T ".into()) }.normalize().unwrap();
        assert_eq!((n.client.as_str(), n.id.as_str(), n.url, n.title.as_deref()), ("m", "1", None, Some("T")));
    }

    #[test]
    fn push_dedups_and_caps() {
        let mut l = vec![];
        push_session(&mut l, s("m", "1", Some("m://1")));
        push_session(&mut l, s("m", "2", None));
        push_session(&mut l, s("m", "1", None));
        assert_eq!(l.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), ["2", "1"]);
        assert_eq!(l[1].url.as_deref(), Some("m://1"));
        for i in 0..30 {
            push_session(&mut l, s("m", &format!("n{i}"), None));
        }
        assert_eq!(l.len(), MAX_STAGE_SESSIONS);
        assert_eq!(l.last().map(|x| x.id.as_str()), Some("n29"));
    }
}
