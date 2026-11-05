//! Evidence on done tasks (ideas #33).

use pathloom_core::{Error, Evidence, Project};

fn setup() -> (tempfile::TempDir, Project) {
    let dir = tempfile::tempdir().unwrap();
    let p = Project::init(dir.path(), "demo").unwrap();
    let spec = Project::parse_spec("stages: [{id: A, title: Alpha, tasks: [one, two]}]").unwrap();
    p.apply(&spec, &Default::default()).unwrap();
    (dir, p)
}

fn ev(cmd: &str, code: i32) -> Evidence {
    Evidence {
        command: cmd.into(),
        exit_code: code,
        duration_ms: Some(1200),
        summary: Some("94 passed".into()),
        log: None,
        at: String::new(),
        by: "claude".into(),
    }
}

#[test]
fn evidence_roundtrips_and_is_dropped_on_reopen() {
    let (_d, p) = setup();
    p.set_task_done_with("A-01", true, Some(ev("npm run test -w @pathloom/canvas", 0))).unwrap();
    let src = p.stage_source("A").unwrap();
    assert!(src.contains("evidence: {A-01: {command: \"npm run test -w @pathloom/canvas\", exit_code: 0"), "{src}");
    let s = p.load_stage("A").unwrap();
    let e = &s.evidence["A-01"];
    assert_eq!((e.exit_code, e.duration_ms, e.by.as_str()), (0, Some(1200), "claude"));
    assert!(!e.at.is_empty());
    // a write that does not touch the task keeps the evidence byte-identical
    p.add_task("A", "three").unwrap();
    assert!(p.stage_source("A").unwrap().contains("evidence: {A-01:"));
    // reopening drops it
    p.set_task_done("A-01", false).unwrap();
    assert!(p.load_stage("A").unwrap().evidence.is_empty());
    assert!(!p.stage_source("A").unwrap().contains("evidence"));
}

#[test]
fn failing_or_misplaced_evidence_is_refused() {
    let (_d, p) = setup();
    assert!(matches!(p.set_task_done_with("A-01", true, Some(ev("cargo test", 101))), Err(Error::InvalidSpec(m)) if m.contains("exit_code 101")));
    assert!(matches!(p.set_task_done_with("A-01", false, Some(ev("cargo test", 0))), Err(Error::InvalidSpec(_))));
    assert!(!p.load_stage("A").unwrap().tasks[0].done, "nothing written on error");
}

#[test]
fn hand_edited_bad_evidence_keeps_the_stage_loadable() {
    let (d, p) = setup();
    let path = d.path().join("plan/stages/A.md");
    let src = std::fs::read_to_string(&path).unwrap();
    let src = src.replacen("priority: med\n", "priority: med\nevidence: {A-01: {exit_code: oops}}\n", 1);
    std::fs::write(&path, &src).unwrap();
    let s = p.load_stage("A").unwrap();
    assert!(s.evidence.is_empty());
    p.add_task("A", "three").unwrap();
    assert!(p.stage_source("A").unwrap().contains("evidence: {A-01: {exit_code: oops}}"), "kept raw");
}

#[test]
fn require_evidence_is_saved_in_project_toml() {
    let (d, mut p) = setup();
    assert!(!p.config.require_evidence);
    p.set_require_evidence(true).unwrap();
    assert!(Project::open(d.path()).unwrap().config.require_evidence);
}

// ---- artifacts (#35), gates (#39), usage (#38) ----

#[test]
fn artifacts_are_validated_deduped_and_resolved() {
    let (d, p) = setup();
    let spec = Project::parse_spec(
        "stages: [{id: A, artifacts_add: [specs/auth/spec.md, 'https://x.dev/plan', specs\\auth\\spec.md]}]",
    )
    .unwrap();
    p.apply(&spec, &Default::default()).unwrap();
    let s = p.load_stage("A").unwrap();
    assert_eq!(s.artifacts, ["specs/auth/spec.md", "https://x.dev/plan"]);
    assert!(p.stage_source("A").unwrap().contains("artifacts: [specs/auth/spec.md, \"https://x.dev/plan\"]"));
    for bad in ["../secret", "/etc/passwd", "C:/x", "a/../../b"] {
        let spec = Project::parse_spec(&format!("stages: [{{id: A, artifacts_add: ['{bad}']}}]")).unwrap();
        assert!(matches!(p.apply(&spec, &Default::default()), Err(Error::InvalidSpec(_))), "{bad}");
    }
    assert!(matches!(p.artifact_path("specs/auth/spec.md"), Err(Error::NotFound(_))));
    std::fs::create_dir_all(d.path().join("specs/auth")).unwrap();
    std::fs::write(d.path().join("specs/auth/spec.md"), "# spec").unwrap();
    assert!(p.artifact_path("specs/auth/spec.md").unwrap().ends_with("spec.md"));
    assert!(p.artifact_path("https://x.dev/plan").is_err());
}

#[test]
fn gate_is_done_only_with_a_passing_check() {
    let (_d, p) = setup();
    let spec = Project::parse_spec("stages: [{id: G, title: Tests pass, kind: gate, check: npm test, depends: [A]}]").unwrap();
    p.apply(&spec, &Default::default()).unwrap();
    let status = |p: &Project| pathloom_core::stage_views(&p.load_stages().unwrap()).into_iter().find(|v| v.stage.key == "G").unwrap();
    assert_eq!(status(&p).progress, (0, 1));
    assert_eq!(status(&p).status, pathloom_core::Status::Blocked);
    let (_, passed) = p.set_gate_result("G", ev("npm test", 0)).unwrap();
    assert!(passed);
    let v = status(&p);
    assert_eq!((v.status, v.progress), (pathloom_core::Status::Done, (1, 1)));
    assert!(p.stage_source("G").unwrap().contains("check: npm test"));
    // a later failing run reopens the gate
    let (_, passed) = p.set_gate_result("G", ev("npm test", 1)).unwrap();
    assert!(!passed);
    assert_ne!(status(&p).status, pathloom_core::Status::Done);
    assert!(matches!(p.set_gate_result("A", ev("x", 0)), Err(Error::InvalidSpec(_))));
}

#[test]
fn usage_is_summed_per_agent_and_stage() {
    let (_d, p) = setup();
    let log = |author: &str, stages: &[&str], tin: u64, cost: Option<f64>| {
        p.log_action(&pathloom_core::LogEntry {
            author: author.into(),
            action: "usage".into(),
            stages: stages.iter().map(|s| s.to_string()).collect(),
            usage: Some(pathloom_core::Usage { tokens_in: tin, tokens_out: 10, cost_usd: cost }),
            ..Default::default()
        })
        .unwrap();
    };
    log("claude", &["A"], 100, Some(0.5));
    log("claude", &["A", "B"], 200, Some(1.0));
    log("codex", &[], 50, None);
    p.log_action(&pathloom_core::LogEntry { author: "x".into(), ..Default::default() }).unwrap();
    let u = p.usage_summary().unwrap();
    assert_eq!((u.total.tokens_in, u.total.tokens_out, u.total.cost_usd), (350, 30, Some(1.5)));
    assert_eq!(u.by_agent["claude"].tokens_in, 300);
    assert_eq!(u.by_agent["codex"].cost_usd, None);
    assert_eq!((u.by_stage["A"].tokens_in, u.by_stage["A"].cost_usd), (200, Some(1.0)));
    assert_eq!(u.by_stage["B"].tokens_in, 100);
    assert!(pathloom_core::Usage { cost_usd: Some(-1.0), ..Default::default() }.validate().is_err());
}
