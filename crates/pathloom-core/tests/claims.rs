//! Claims through the public API: auto-release, next_tasks_for, stage_views_live.

use pathloom_core::*;

fn setup() -> (tempfile::TempDir, Project) {
    let dir = tempfile::tempdir().unwrap();
    let p = Project::init(dir.path(), "demo").unwrap();
    let spec = Project::parse_spec(
        "stages:\n  - {id: A, title: Alpha, priority: high, tasks: [one, two]}\n  - {id: B, title: Beta, tasks: [three]}\n",
    )
    .unwrap();
    p.apply(&spec, &ApplyOptions::default()).unwrap();
    p.add_subtask("A-02", "sub x").unwrap();
    p.add_subtask("A-02", "sub y").unwrap();
    (dir, p)
}

fn claimed_ids(p: &Project) -> Vec<String> {
    p.claims().unwrap().into_iter().map(|c| c.task_id).collect()
}

#[test]
fn done_releases_task_and_subtask_claims() {
    let (_d, p) = setup();
    p.claim_task("A-01", "claude", 600, "").unwrap();
    p.claim_task("A-02a", "claude", 600, "").unwrap();
    p.claim_task("B-01", "claude", 600, "").unwrap();
    p.set_task_done("A-01", true).unwrap();
    assert_eq!(claimed_ids(&p), ["A-02a", "B-01"]);
    // marking the parent done completes its subtasks and frees their claims
    p.set_task_done("A-02", true).unwrap();
    assert_eq!(claimed_ids(&p), ["B-01"]);
}

#[test]
fn apply_tasks_done_releases_claims() {
    let (_d, p) = setup();
    p.claim_task("A-01", "codex", 600, "").unwrap();
    p.claim_task("B-01", "codex", 600, "").unwrap();
    let spec = Project::parse_spec("stages: [{id: A, tasks_done: [A-01]}]").unwrap();
    p.apply(&spec, &ApplyOptions::default()).unwrap();
    assert_eq!(claimed_ids(&p), ["B-01"]);
}

#[test]
fn next_tasks_for_excludes_others_and_puts_own_first() {
    let (_d, p) = setup();
    p.claim_task("B-01", "claude", 600, "").unwrap(); // lowest priority, but own
    p.claim_task("A-01", "codex", 600, "").unwrap();
    let ids = |a: Option<&str>| {
        p.next_tasks_for(0, a).unwrap().into_iter().map(|t| (t.task_id, t.claimed_by)).collect::<Vec<_>>()
    };
    assert_eq!(
        ids(Some("claude")),
        [("B-01".into(), Some("claude".into())), ("A-02a".into(), None), ("A-02b".into(), None)]
    );
    assert_eq!(ids(Some("codex"))[0], ("A-01".into(), Some("codex".into())));
    assert!(!ids(Some("codex")).iter().any(|t| t.0 == "B-01"));
    assert_eq!(ids(None).len(), 2, "no identity: claimed tasks are hidden");
    assert_eq!(p.next_tasks(0).unwrap().len(), 2);
}

#[test]
fn parent_claim_hides_subtasks_from_others() {
    let (_d, p) = setup();
    p.claim_task("A-02", "claude", 600, "").unwrap();
    let ids: Vec<String> = p.next_tasks_for(0, Some("codex")).unwrap().into_iter().map(|t| t.task_id).collect();
    assert_eq!(ids, ["A-01", "B-01"]);
    let own: Vec<String> = p.next_tasks_for(0, Some("claude")).unwrap().into_iter().map(|t| t.task_id).collect();
    assert_eq!(&own[..2], ["A-02a", "A-02b"]);
}

#[test]
fn stage_views_live_fills_claims() {
    let (_d, p) = setup();
    p.claim_task("A-01", "claude", 600, "n").unwrap();
    let views = p.stage_views_live().unwrap();
    assert_eq!(views[0].claims.len(), 1);
    assert!(views[1].claims.is_empty());
    let j = serde_json::to_value(&views[0]).unwrap();
    assert_eq!(j["claims"][0]["taskId"], "A-01");
    assert_eq!(j["claims"][0]["agent"], "claude");
    assert!(j["claims"][0]["expiresAt"].as_str().unwrap().ends_with('Z'));
    assert!(stage_views(&p.load_stages().unwrap())[0].claims.is_empty());
}

#[test]
fn who_round_trips_in_stage_files() {
    let (_d, p) = setup();
    for w in ["me", "both", "ai:claude", "human:Olia B"] {
        p.update_meta("A", StageMeta { who: Some(Who::parse(w).unwrap()), ..Default::default() }).unwrap();
        assert!(p.stage_source("A").unwrap().contains(&format!("who: {w}\n")));
        assert_eq!(p.load_stage("A").unwrap().who.as_str(), w);
    }
}
