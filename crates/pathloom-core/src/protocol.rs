//! Protocol version and capability list advertised to external clients (m7 contract §1).

/// Major version of the file and MCP contract. Breaking changes bump it to `pathloom/2`.
pub const PROTOCOL: &str = "pathloom/1";

/// What this build supports. A read-only server keeps only the non-mutating capabilities.
pub fn capabilities(read_only: bool) -> Vec<&'static str> {
    if read_only {
        vec!["read", "activity", "events", "validate"]
    } else {
        vec!["read", "apply", "proposals", "claims", "activity", "agents", "events", "sessions", "layout", "validate"]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_only_has_no_mutating_capabilities() {
        let rw = capabilities(false);
        let ro = capabilities(true);
        assert!(ro.iter().all(|c| rw.contains(c)));
        for mutating in ["apply", "proposals", "claims", "agents", "sessions", "layout"] {
            assert!(rw.contains(&mutating) && !ro.contains(&mutating), "{mutating}");
        }
        assert_eq!(PROTOCOL, "pathloom/1");
    }
}
