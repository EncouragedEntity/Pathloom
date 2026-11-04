use pathloom_core::*;
use serde_json::json;
use std::path::Path;

const M0: &str = include_str!("fixtures/M0.md");
const CUSTOM: &str = include_str!("fixtures/CUSTOM.md");

fn project() -> (tempfile::TempDir, Project) {
    let dir = tempfile::tempdir().unwrap();
    let p = Project::init(dir.path(), "demo").unwrap();
    (dir, p)
}

fn stage(key: &str, deps: &[(&str, bool)], tasks: &[bool]) -> Stage {
    let mut s = Stage::new(key, key);
    s.depends = deps.iter().map(|(i, soft)| Dep { id: (*i).into(), soft: *soft }).collect();
    s.tasks = tasks
        .iter()
        .enumerate()
        .map(|(i, d)| Task { id: format!("{key}-{:02}", i + 1), title: "t".into(), done: *d, sub: vec![] })
        .collect();
    s
}

// ---- stage file golden ----

#[test]
fn golden_round_trip_spec_example() {
    let s = Stage::from_markdown(Path::new("M0.md"), M0).unwrap();
    assert_eq!(s.key, "M0");
    assert_eq!(s.depends, vec![Dep { id: "S0".into(), soft: false }, Dep { id: "M2".into(), soft: true }]);
    assert_eq!(s.pr.as_deref(), Some("12"));
    assert_eq!(s.tasks.len(), 2);
    assert_eq!(s.tasks[1].sub.len(), 2);
    assert!(s.tasks[0].done && !s.tasks[1].done);
    assert_eq!(s.comments.len(), 2);
    assert_eq!(s.comments[0].author, "agent:claude");
    assert_eq!(s.to_markdown(), M0);
}

#[test]
fn golden_custom_sections_and_unknown_keys_preserved() {
    let s = Stage::from_markdown(Path::new("CUSTOM.md"), CUSTOM).unwrap();
    assert_eq!(s.kind, StageKind::Milestone);
    assert_eq!(s.tasks.len(), 1, "task inside code fence must not be parsed");
    assert_eq!(s.title, "Custom: sections");
    assert!(s.description.contains("## Notes"));
    assert_eq!(s.to_markdown(), CUSTOM);
}

#[test]
fn crlf_input_accepted_and_written_as_lf() {
    let crlf = M0.replace('\n', "\r\n");
    let s = Stage::from_markdown(Path::new("M0.md"), &crlf).unwrap();
    assert_eq!(s.to_markdown(), M0);
}

#[test]
fn edit_keeps_user_text() {
    let mut s = Stage::from_markdown(Path::new("CUSTOM.md"), CUSTOM).unwrap();
    s.tasks.push(Task { id: "CUSTOM-02".into(), title: "Second".into(), done: true, sub: vec![] });
    let out = s.to_markdown();
    assert!(out.contains("Free text between managed sections.\n\n### Sub heading\nMore text.\n"));
    assert!(out.contains("- [x] CUSTOM-02 Second\n"));
    assert!(out.ends_with("## Appendix\nTrailing user section, no final blank line.\n"));
}

#[test]
fn new_stage_is_stable_after_reparse() {
    let mut s = Stage::new("AB", "Авторизація: вхід");
    s.tasks.push(Task { id: "AB-01".into(), title: "x".into(), done: false, sub: vec![] });
    s.comments.push(Comment { at: "2026-01-01T00:00Z".into(), author: "human".into(), text: "hi".into() });
    s.due = Some("2026-12-01".into());
    s.pr = Some("7".into());
    let text = s.to_markdown();
    let back = Stage::from_markdown(Path::new("AB.md"), &text).unwrap();
    assert_eq!(back.title, s.title);
    assert_eq!(back.due, s.due);
    assert_eq!(back.to_markdown(), text);
}

#[test]
fn parse_errors() {
    assert!(matches!(Stage::from_markdown(Path::new("A.md"), "no frontmatter"), Err(Error::Parse { .. })));
    assert!(matches!(Stage::from_markdown(Path::new("A.md"), "---\nid: A\n"), Err(Error::Parse { .. })));
    assert!(matches!(Stage::from_markdown(Path::new("A.md"), "---\nid: B\n---\n"), Err(Error::Parse { .. })));
    assert!(matches!(Stage::from_markdown(Path::new("a.md"), "---\nid: a\n---\n"), Err(Error::InvalidKey(_))));
}

// ---- keys ----

#[test]
fn key_validation() {
    for ok in ["A", "M0", "ABCDEFG1"] {
        assert!(is_valid_key(ok), "{ok}");
    }
    for bad in ["", "a", "0A", "ABCDEFGH1", "A-B", "М0"] {
        assert!(!is_valid_key(bad), "{bad}");
    }
}

#[test]
fn key_generation() {
    let none = |_: &str| false;
    assert_eq!(generate_key("Авторизація", &none), "AVT");
    assert_eq!(generate_key("Ядро і формат файлів", &none), "IIFF");
    assert_eq!(generate_key("Core engine", &none), "CE");
    assert_eq!(generate_key("!!!", &none), "S1");
    assert_eq!(generate_key("2024 plan", &none), "P");
    let taken = |k: &str| ["CE", "CE2"].contains(&k);
    assert_eq!(generate_key("Core engine", &taken), "CE3");
    assert_eq!(generate_key("", &|k: &str| k == "S1"), "S2");
}

#[test]
fn create_stage_keys_and_collisions() {
    let (_d, p) = project();
    assert_eq!(p.create_stage("Core engine", None).unwrap().key, "CE");
    assert_eq!(p.create_stage("Content editor", None).unwrap().key, "CE2");
    assert_eq!(p.create_stage("x", Some("M0")).unwrap().key, "M0");
    assert!(matches!(p.create_stage("x", Some("M0")), Err(Error::DuplicateKey(_))));
    assert!(matches!(p.create_stage("x", Some("bad")), Err(Error::InvalidKey(_))));
}

// ---- project / boards ----

#[test]
fn init_open_find() {
    let (d, p) = project();
    assert_eq!(p.config.plan_dir, "plan");
    let gi = std::fs::read_to_string(d.path().join(".pathloom/.gitignore")).unwrap();
    assert_eq!(gi, "cache/\nproposals/\nlog/\n");
    assert!(p.plan_dir().join("stages").is_dir());
    let b = p.load_board("roadmap").unwrap();
    assert_eq!((b.title.as_str(), b.style.as_str(), b.elements.len()), ("Roadmap", "clean", 0));
    assert!(matches!(Project::init(d.path(), "again"), Err(Error::AlreadyInitialized(_))));
    assert_eq!(Project::open(d.path()).unwrap().config.name, "demo");
    let deep = d.path().join("plan/stages");
    assert_eq!(Project::find(&deep).unwrap().root, d.path());
    let other = tempfile::tempdir().unwrap();
    assert!(matches!(Project::open(other.path()), Err(Error::NotAProject)));
}

#[test]
fn board_canonical_write_and_round_trip() {
    let (_d, p) = project();
    let mut b = p.create_board("arch/backend", "Backend").unwrap();
    assert!(matches!(p.create_board("arch/backend", "x"), Err(Error::DuplicateKey(_))));
    assert!(matches!(p.create_board("../x", "x"), Err(Error::InvalidName(_))));
    let el = |v: serde_json::Value| v.as_object().unwrap().clone();
    b.elements.push(el(json!({"stroke":"#c9c2ec","index":"a2","seed":81723,"type":"rect","h":80,"x":40,"y":600.5,"w":160,"id":"e1","angle":0,"fill":null,"custom":{"b":1,"a":[1,2]}})));
    b.elements.push(el(json!({"index":"a1","ref":"M0","type":"card","id":"e2","x":1,"y":2})));
    p.save_board("arch/backend", &b).unwrap();
    p.save_board("zeta", &Board::new("Z")).unwrap();
    assert_eq!(p.list_boards().unwrap(), vec!["arch/backend", "roadmap", "zeta"]);

    let text = std::fs::read_to_string(p.plan_dir().join("boards/arch/backend.board.json")).unwrap();
    let expected = "{\n  \"format\": \"pathloom.board/1\",\n  \"title\": \"Backend\",\n  \"style\": \"clean\",\n  \"elements\": [\n\
{\"id\":\"e1\",\"type\":\"rect\",\"x\":40,\"y\":600.5,\"w\":160,\"h\":80,\"angle\":0,\"index\":\"a2\",\"custom\":{\"b\":1,\"a\":[1,2]},\"fill\":null,\"seed\":81723,\"stroke\":\"#c9c2ec\"},\n\
{\"id\":\"e2\",\"type\":\"card\",\"ref\":\"M0\",\"x\":1,\"y\":2,\"index\":\"a1\"}\n  ]\n}\n";
    assert_eq!(text, expected);
    let back = p.load_board("arch/backend").unwrap();
    assert_eq!(back.elements[0]["x"], json!(40), "integers stay integers");
    assert!(back.elements[0]["x"].is_i64() || back.elements[0]["x"].is_u64());
    p.save_board("arch/backend", &back).unwrap();
    assert_eq!(std::fs::read_to_string(p.plan_dir().join("boards/arch/backend.board.json")).unwrap(), expected);
    assert!(matches!(p.load_board("nope"), Err(Error::NotFound(_))));
}

// ---- tasks ----

#[test]
fn add_task_numbering() {
    let (_d, p) = project();
    p.create_stage("Core", Some("C")).unwrap();
    assert_eq!(p.add_task("C", "one").unwrap().tasks[0].id, "C-01");
    p.add_task("C", "two").unwrap();
    p.remove_task("C-01").unwrap();
    let s = p.add_task("C", "three").unwrap();
    assert_eq!(s.tasks.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["C-02", "C-03"]);
    let s = p.rename_task("C-03", "  renamed ").unwrap();
    assert_eq!(s.tasks[1].title, "renamed");
    assert!(matches!(p.remove_task("C-99"), Err(Error::NotFound(_))));
    assert!(matches!(p.add_task("Q", "x"), Err(Error::NotFound(_))));
}

#[test]
fn set_task_done_with_subtasks() {
    let (_d, p) = project();
    let mut s = p.create_stage("Core", Some("C")).unwrap();
    let sub = |id: &str| Task { id: id.into(), title: id.into(), done: false, sub: vec![] };
    s.tasks.push(Task { id: "C-01".into(), title: "p".into(), done: false, sub: vec![sub("C-01a"), sub("C-01b")] });
    p.save_stage(&s).unwrap();
    let s = p.set_task_done("C-01a", true).unwrap();
    assert!(s.tasks[0].sub[0].done && !s.tasks[0].sub[1].done && !s.tasks[0].is_done());
    let s = p.set_task_done("C-01", true).unwrap();
    assert!(s.tasks[0].sub.iter().all(|t| t.done) && s.tasks[0].done);
    let s = p.set_task_done("C-01", false).unwrap();
    assert!(s.tasks[0].sub.iter().all(|t| !t.done));
    let s = p.remove_task("C-01b").unwrap();
    assert_eq!(s.tasks[0].sub.len(), 1);
}

// ---- links / graph ----

#[test]
fn link_unlink_and_cycles() {
    let (_d, p) = project();
    for k in ["A", "B", "C"] {
        p.create_stage(k, Some(k)).unwrap();
    }
    p.link("A", "B", false).unwrap();
    p.link("B", "C", true).unwrap();
    p.link("A", "B", true).unwrap(); // duplicate: no-op, stays hard
    let b = p.load_stage("B").unwrap();
    assert_eq!(b.depends, vec![Dep { id: "A".into(), soft: false }]);
    assert_eq!(p.load_stage("C").unwrap().depends, vec![Dep { id: "B".into(), soft: true }]);

    match p.link("C", "A", false) {
        Err(Error::Cycle(path)) => assert_eq!(path, ["A", "B", "C"]),
        other => panic!("expected cycle, got {other:?}"),
    }
    assert!(matches!(p.link("A", "A", false), Err(Error::Cycle(_))));
    assert!(matches!(p.link("A", "Z", false), Err(Error::NotFound(_))));
    assert!(p.load_stage("A").unwrap().depends.is_empty(), "rejected link must not be written");

    p.unlink("B", "C").unwrap();
    p.link("C", "A", false).unwrap();
}

#[test]
fn delete_stage_cleans_depends() {
    let (_d, p) = project();
    for k in ["A", "B", "C"] {
        p.create_stage(k, Some(k)).unwrap();
    }
    p.link("A", "B", false).unwrap();
    p.link("A", "C", true).unwrap();
    p.link("B", "C", false).unwrap();
    p.delete_stage("A").unwrap();
    assert!(matches!(p.load_stage("A"), Err(Error::NotFound(_))));
    assert!(p.load_stage("B").unwrap().depends.is_empty());
    assert_eq!(p.load_stage("C").unwrap().depends, vec![Dep { id: "B".into(), soft: false }]);
    assert_eq!(p.load_stages().unwrap().len(), 2);
}

// ---- statuses ----


#[test]
fn statuses_chain() {
    let a = stage("A", &[], &[true, true]);
    let b = stage("B", &[("A", false)], &[true, false]);
    let c = stage("C", &[("B", false)], &[false]);
    let d = stage("D", &[], &[false]);
    let e = stage("E", &[], &[]);
    let got = compute_statuses(&[a, b, c, d, e]);
    use Status::*;
    assert_eq!(got["A"], Done);
    assert_eq!(got["B"], Active);
    assert_eq!(got["C"], Blocked);
    assert_eq!(got["D"], Ready);
    assert_eq!(got["E"], Ready, "empty stage is not done");
}

#[test]
fn statuses_soft_unknown_and_empty_blocked() {
    let a = stage("A", &[], &[false]);
    let b = stage("B", &[("A", true)], &[false]);
    let c = stage("C", &[("NOPE", false)], &[false]);
    let d = stage("D", &[("A", false)], &[]);
    let got = compute_statuses(&[a, b, c, d]);
    assert_eq!(got["B"], Status::Ready, "soft dep never blocks");
    assert_eq!(got["C"], Status::Ready, "unknown dep ignored");
    assert_eq!(got["D"], Status::Blocked);
}

#[test]
fn statuses_milestones_and_subtasks() {
    let mut a = stage("A", &[], &[false]);
    a.tasks[0].sub = vec![
        Task { id: "A-01a".into(), title: "x".into(), done: true, sub: vec![] },
        Task { id: "A-01b".into(), title: "y".into(), done: true, sub: vec![] },
    ];
    let mut m = stage("M", &[("A", false), ("B", true)], &[]);
    m.kind = StageKind::Milestone;
    let mut m0 = stage("N", &[], &[]);
    m0.kind = StageKind::Milestone;
    let b = stage("B", &[], &[false]);
    let got = compute_statuses(&[a.clone(), b.clone(), m.clone(), m0]);
    assert_eq!(got["A"], Status::Done, "subtasks all done => task done");
    assert_eq!(got["M"], Status::Done, "soft dep ignored");
    assert_eq!(got["N"], Status::Ready);
    // a hard dep that is not done blocks the milestone
    let a2 = stage("A", &[], &[false]);
    assert_eq!(compute_statuses(&[a2, b, m])["M"], Status::Blocked);
}

#[test]
fn stage_view_json_shape() {
    let a = stage("A", &[], &[true, false]);
    let views = stage_views(&[a]);
    assert_eq!(views[0].progress, (1, 2));
    let v = serde_json::to_value(&views[0]).unwrap();
    assert_eq!(v["key"], "A");
    assert_eq!(v["status"], "active");
    assert_eq!(v["progress"], json!([1, 2]));
    assert_eq!(v["kind"], "stage");
    assert_eq!(v["tasks"][0]["done"], true);
    assert!(v.get("extra").is_none());
}

#[test]
fn set_title_keeps_key_and_rejects_empty() {
    let (_d, p) = project();
    let s = p.create_stage("Перший етап", Some("A1")).unwrap();
    let renamed = p.set_title(&s.key, "  Новий заголовок ").unwrap();
    assert_eq!(renamed.key, "A1");
    assert_eq!(p.load_stage("A1").unwrap().title, "Новий заголовок");
    assert!(p.set_title("A1", "   ").is_err());
}
