//! External-client features (m7): agent profiles, sessions, claims lock, event stream.

use pathloom_core::events::{Change, Event, EventWatcher};
use pathloom_core::*;
use std::time::{Duration, Instant};

fn setup() -> (tempfile::TempDir, Project) {
    let dir = tempfile::tempdir().unwrap();
    let p = Project::init(dir.path(), "demo").unwrap();
    let spec = Project::parse_spec("stages: [{id: A, title: Alpha, tasks: [one, two]}]").unwrap();
    p.apply(&spec, &ApplyOptions::default()).unwrap();
    (dir, p)
}

fn sess(id: &str) -> SessionRef {
    SessionRef { client: "maestro".into(), id: id.into(), url: Some(format!("maestro://session/{id}")), title: Some("Implement auth".into()) }
}

// ---- protocol ----

#[test]
fn capabilities_read_only_vs_full() {
    assert_eq!(PROTOCOL, "pathloom/1");
    let full = capabilities(false);
    let ro = capabilities(true);
    assert_eq!(ro, ["read", "activity", "events", "validate"]);
    for c in ["read", "apply", "proposals", "claims", "activity", "agents", "events", "sessions", "layout", "validate"] {
        assert!(full.contains(&c), "{c}");
    }
}

// ---- agent profiles ----

#[test]
fn agents_roundtrip_sorted_and_validated() {
    let (d, p) = setup();
    assert!(p.agents().unwrap().is_empty());
    let mk = |id: &str, name: &str, color: &str, avatar: &str, kind: &str| AgentProfile {
        id: id.into(),
        name: name.into(),
        color: color.into(),
        avatar: avatar.into(),
        kind: kind.into(),
    };
    p.upsert_agent(mk("maestro", "Maestro", "#3fb6f2", "assets/maestro.png", "orchestrator")).unwrap();
    let saved = p.upsert_agent(mk("claude-code", "Claude", "#d97757", "🤖", "")).unwrap();
    assert_eq!(saved.kind, "agent");
    let ids: Vec<String> = p.agents().unwrap().into_iter().map(|a| a.id).collect();
    assert_eq!(ids, ["claude-code", "maestro"]);
    // stable, pretty file; updating replaces in place
    let path = d.path().join("plan/agents.json");
    let before = std::fs::read_to_string(&path).unwrap();
    assert!(before.contains("\n  \"agents\": [\n") && before.ends_with("}\n"));
    p.upsert_agent(mk("claude-code", "Claude", "#d97757", "🤖", "agent")).unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
    p.upsert_agent(mk("claude-code", "Claude 2", "#fff", "", "agent")).unwrap();
    assert_eq!(p.agents().unwrap()[0].name, "Claude 2");
    // validation
    assert!(p.upsert_agent(mk("Bad Id", "x", "", "", "")).is_err());
    assert!(p.upsert_agent(mk("a", &"n".repeat(41), "", "", "")).is_err());
    assert!(p.upsert_agent(mk("a", "n", "blue", "", "")).is_err());
    assert!(p.upsert_agent(mk("a", "n", "", "abc", "")).is_err());
    assert!(p.upsert_agent(mk("a", "n", "", "assets/../x.png", "")).is_err());
    assert!(p.upsert_agent(mk("a", "n", "", "https://x/y.png", "")).is_err());
    assert_eq!(p.agents().unwrap().len(), 2, "rejected profiles are not stored");
    // remove
    p.remove_agent("maestro").unwrap();
    assert!(matches!(p.remove_agent("maestro"), Err(Error::NotFound(_))));
    assert_eq!(p.agents().unwrap().len(), 1);
}

// ---- sessions ----

#[test]
fn stage_sessions_roundtrip_through_frontmatter() {
    let (_d, p) = setup();
    let mut s = p.load_stage("A").unwrap();
    assert!(s.sessions.is_empty());
    s.sessions = vec![sess("sess_1"), SessionRef { client: "codex".into(), id: "x y".into(), url: None, title: None }];
    p.save_stage(&s).unwrap();
    let text = p.stage_source("A").unwrap();
    assert!(text.contains("sessions: [{client: maestro, id: sess_1, url: \"maestro://session/sess_1\", title: Implement auth}"), "{text}");
    let back = p.load_stage("A").unwrap();
    assert_eq!(back.sessions, s.sessions);
    p.save_stage(&back).unwrap();
    assert_eq!(p.stage_source("A").unwrap(), text, "stable rewrite");
    // camelCase JSON on the view
    let v = serde_json::to_value(&p.stage_views_live().unwrap()[0]).unwrap();
    assert_eq!(v["sessions"][0]["client"], "maestro");
    assert_eq!(v["sessions"][0]["url"], "maestro://session/sess_1");
    // a broken entry no longer breaks loading: sessions are hidden and the raw list is kept
    let bad = text.replace("client: codex", "client: Bad Client");
    std::fs::write(p.root.join("plan/stages/A.md"), &bad).unwrap();
    let loaded = p.load_stage("A").unwrap();
    assert!(loaded.sessions.is_empty());
    p.save_stage(&loaded).unwrap();
    assert!(p.stage_source("A").unwrap().contains("Bad Client"));
}

#[test]
fn apply_sessions_add_dedups_and_validates() {
    let (_d, p) = setup();
    let y = r#"{"stages":[{"id":"A","sessions_add":[{"client":"maestro","id":"s1","title":"One"},{"client":"maestro","id":"s2"}]}]}"#;
    let spec = Project::parse_spec(y).unwrap();
    let r = p.apply(&spec, &ApplyOptions::default()).unwrap();
    assert_eq!(r.updated, ["A"]);
    let again = p.apply(&spec, &ApplyOptions::default()).unwrap();
    assert!(again.updated.is_empty(), "re-apply is a no-op");
    let spec2 = Project::parse_spec(r#"{"stages":[{"id":"A","sessions_add":[{"client":"maestro","id":"s1"}]}]}"#).unwrap();
    p.apply(&spec2, &ApplyOptions::default()).unwrap();
    let ids: Vec<String> = p.load_stage("A").unwrap().sessions.into_iter().map(|s| s.id).collect();
    assert_eq!(ids, ["s2", "s1"], "same client+id moves to the end, no duplicate");
    assert_eq!(p.load_stage("A").unwrap().sessions[1].title.as_deref(), Some("One"), "old title kept");
    // invalid session: nothing written
    let bad = Project::parse_spec(r#"{"stages":[{"id":"A","sessions_add":[{"client":"m","id":"1","url":"javascript://x"}]}]}"#).unwrap();
    assert!(p.apply(&bad, &ApplyOptions::default()).is_err());
    // at most 20, newest kept
    for i in 0..25 {
        let s = Project::parse_spec(&format!(r#"{{"stages":[{{"id":"A","sessions_add":[{{"client":"m","id":"n{i}"}}]}}]}}"#)).unwrap();
        p.apply(&s, &ApplyOptions::default()).unwrap();
    }
    let l = p.load_stage("A").unwrap().sessions;
    assert_eq!((l.len(), l.last().map(|s| s.id.as_str())), (20, Some("n24")));
}

#[test]
fn claim_with_session_links_stage_and_log_keeps_session() {
    let (_d, p) = setup();
    let c = p.claim_task_with("A-01", "maestro", 600, "", Some(&sess("s1"))).unwrap();
    assert_eq!(c.session, Some(sess("s1")));
    p.claim_task_with("A-01", "maestro", 600, "", Some(&sess("s1"))).unwrap(); // renew: no duplicate
    p.claim_task_with("A-02", "maestro", 600, "", Some(&sess("s2"))).unwrap();
    let ids: Vec<String> = p.load_stage("A").unwrap().sessions.into_iter().map(|s| s.id).collect();
    assert_eq!(ids, ["s1", "s2"]);
    assert_eq!(p.claims().unwrap()[0].session, Some(sess("s1")));
    let views = p.stage_views_live().unwrap();
    assert_eq!(views[0].claims[0].session, Some(sess("s1")));
    assert!(p.claim_task_with("A-01", "x", 60, "", Some(&SessionRef { client: "BAD".into(), id: "1".into(), url: None, title: None })).is_err());
    p.log_action(&LogEntry { author: "maestro".into(), action: "claim_task".into(), session: Some(sess("s1")), ..Default::default() }).unwrap();
    assert_eq!(p.read_log(1, None).unwrap()[0].session, Some(sess("s1")));
    p.log_action(&LogEntry { action: "plain".into(), ..Default::default() }).unwrap();
    assert!(p.read_log(1, None).unwrap()[0].session.is_none());
}

// ---- claims lock ----

#[test]
fn concurrent_claims_exactly_one_wins() {
    let (_d, p) = setup();
    let handles: Vec<_> = (0..8)
        .map(|i| {
            let p = p.clone();
            std::thread::spawn(move || p.claim_task("A-01", &format!("agent{i}"), 600, ""))
        })
        .collect();
    let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    let wins = results.iter().filter(|r| r.is_ok()).count();
    assert_eq!(wins, 1, "{results:?}");
    assert!(results.iter().filter(|r| r.is_err()).all(|r| matches!(r, Err(Error::Claimed { .. }))));
    assert_eq!(p.claims().unwrap().len(), 1);
    assert!(!p.root.join(".pathloom/claims.lock").exists(), "lock released");
}

#[test]
fn stale_lock_is_removed() {
    let (_d, p) = setup();
    let lock = p.root.join(".pathloom/claims.lock");
    std::fs::write(&lock, "").unwrap();
    let old = std::time::SystemTime::now() - Duration::from_secs(60);
    std::fs::OpenOptions::new().write(true).open(&lock).unwrap().set_modified(old).unwrap();
    p.claim_task("A-01", "claude", 60, "").unwrap();
}

// ---- events ----

/// Wait up to `secs` for an event matching `pred`; other events are skipped.
fn wait_for(w: &EventWatcher, secs: u64, pred: impl Fn(&Event) -> bool) -> Option<Event> {
    let end = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < end {
        if let Some(e) = w.recv_timeout(Duration::from_millis(100))
            && pred(&e)
        {
            return Some(e);
        }
    }
    None
}

#[test]
fn event_json_shape() {
    let e = Event::Stage { key: "AUTH".into(), change: Change::Created, at: "2026-11-05T10:00:00Z".into() };
    assert_eq!(e.to_json_line(), r#"{"type":"stage","key":"AUTH","change":"created","at":"2026-11-05T10:00:00Z"}"#);
    let h: serde_json::Value = serde_json::from_str(&Event::hello().to_json_line()).unwrap();
    assert_eq!((h["type"].as_str(), h["protocol"].as_str()), (Some("hello"), Some("pathloom/1")));
    let back: Event = serde_json::from_str(&e.to_json_line()).unwrap();
    assert_eq!(back, e);
}

#[test]
fn watcher_reports_stage_claim_log_proposal_agents_and_board() {
    let (_d, p) = setup();
    let w = EventWatcher::start(&p).unwrap();

    p.create_stage("Beta", Some("B")).unwrap();
    let e = wait_for(&w, 5, |e| matches!(e, Event::Stage { key, .. } if key == "B")).expect("stage created");
    assert!(matches!(e, Event::Stage { change: Change::Created, .. }));

    p.add_task("A", "three").unwrap();
    let e = wait_for(&w, 5, |e| matches!(e, Event::Stage { key, .. } if key == "A")).expect("stage updated");
    assert!(matches!(e, Event::Stage { change: Change::Updated, .. }));

    p.delete_stage("B").unwrap();
    let e = wait_for(&w, 5, |e| matches!(e, Event::Stage { key, .. } if key == "B")).expect("stage deleted");
    assert!(matches!(e, Event::Stage { change: Change::Deleted, .. }));

    p.claim_task("A-01", "claude", 600, "").unwrap();
    let Some(Event::Claims { claims, .. }) = wait_for(&w, 5, |e| matches!(e, Event::Claims { .. })) else {
        panic!("no claims event")
    };
    assert_eq!(claims.len(), 1);
    assert_eq!(claims[0].task_id, "A-01");

    p.log_action(&LogEntry { author: "claude".into(), source: "cli".into(), action: "ping".into(), ..Default::default() }).unwrap();
    let Some(Event::Activity { entry }) = wait_for(&w, 5, |e| matches!(e, Event::Activity { entry } if entry.action == "ping")) else {
        panic!("no activity event")
    };
    assert_eq!(entry.author, "claude");

    let spec = Project::parse_spec("stages: [{id: A, tasks: [more]}]").unwrap();
    let prop = p.propose(&spec, "claude").unwrap();
    let e = wait_for(&w, 5, |e| matches!(e, Event::Proposal { .. })).expect("proposal created");
    assert!(matches!(&e, Event::Proposal { id, change: Change::Created, .. } if *id == prop.id));
    p.reject_proposal(&prop.id).unwrap();
    let e = wait_for(&w, 5, |e| matches!(e, Event::Proposal { .. })).expect("proposal deleted");
    assert!(matches!(e, Event::Proposal { change: Change::Deleted, .. }));

    p.upsert_agent(AgentProfile { id: "claude".into(), name: "Claude".into(), ..Default::default() }).unwrap();
    assert!(wait_for(&w, 5, |e| matches!(e, Event::Agents { .. })).is_some(), "agents event");

    p.create_board("ideas", "Ideas").unwrap();
    let e = wait_for(&w, 5, |e| matches!(e, Event::Board { .. })).expect("board event");
    assert!(matches!(&e, Event::Board { name, change: Change::Created, .. } if name == "ideas"));
}

#[test]
fn watcher_ignores_identical_rewrite_and_tails_log() {
    let (_d, p) = setup();
    p.log_action(&LogEntry { action: "before".into(), ..Default::default() }).unwrap();
    let w = EventWatcher::start(&p).unwrap();
    // identical content: no stage event; the old log line is not replayed
    let s = p.load_stage("A").unwrap();
    p.save_stage(&s).unwrap();
    assert!(wait_for(&w, 1, |e| matches!(e, Event::Stage { .. } | Event::Activity { .. })).is_none());
    p.log_action(&LogEntry { action: "one".into(), ..Default::default() }).unwrap();
    assert!(wait_for(&w, 5, |e| matches!(e, Event::Activity { entry } if entry.action == "one")).is_some());
}

#[test]
fn invalid_sessions_do_not_break_loading_and_are_preserved() {
    let dir = tempfile::tempdir().unwrap();
    let p = pathloom_core::Project::init(dir.path(), "t").unwrap();
    let path = p.plan_dir().join("stages/BAD.md");
    let text = "---\nid: BAD\ntitle: Bad sessions\nkind: stage\nwho: ai\npriority: med\nsessions: [{client: \"x\", id: \"1\", url: \"javascript:alert(1)\"}]\n---\n";
    std::fs::write(&path, text).unwrap();
    let s = p.load_stage("BAD").unwrap();
    assert!(s.sessions.is_empty());
    p.add_task("BAD", "Still editable").unwrap();
    let after = std::fs::read_to_string(&path).unwrap();
    assert!(after.contains("javascript:alert(1)"), "raw sessions kept: {after}");
}
