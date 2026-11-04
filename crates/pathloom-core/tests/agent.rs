//! apply / layout / next / comments / proposals / validate / writes registry.

use pathloom_core::*;
use serde_json::Value;

fn project() -> (tempfile::TempDir, Project) {
    let dir = tempfile::tempdir().unwrap();
    let p = Project::init(dir.path(), "demo").unwrap();
    (dir, p)
}

fn opts() -> ApplyOptions {
    ApplyOptions { dry_run: false, author: "tester".into() }
}

fn spec(y: &str) -> ApplySpec {
    Project::parse_spec(y).unwrap()
}

const BIG: &str = r#"
board: roadmap
stages:
  - id: M0
    title: Core
    priority: high
    tasks: [Format, Writer]
  - id: AUTH
    title: Auth
    depends: [M0]
    tasks: [Login, Signup]
  - id: UI
    title: UI
    depends: [{id: M0, soft: true}]
    tasks: [Shell]
  - id: REL
    title: Release
    kind: milestone
    depends: [AUTH, UI]
links: [{from: UI, to: REL}]
frames: [{name: "Phase 1", members: [M0, AUTH]}]
comments: [{stage: M0, text: "kickoff"}]
"#;

fn cards(b: &Board) -> Vec<(String, f64, f64)> {
    b.elements
        .iter()
        .filter(|e| e["type"] == "card")
        .map(|e| (e["ref"].as_str().unwrap().to_string(), e["x"].as_f64().unwrap(), e["y"].as_f64().unwrap()))
        .collect()
}

fn pos(b: &Board, k: &str) -> (f64, f64) {
    let c = cards(b);
    let (_, x, y) = c.iter().find(|c| c.0 == k).unwrap();
    (*x, *y)
}

#[test]
fn apply_creates_stages_links_tasks_frames() {
    let (_d, p) = project();
    let r = p.apply(&spec(BIG), &opts()).unwrap();
    assert_eq!(r.created, ["M0", "AUTH", "UI", "REL"]);
    assert_eq!(r.cards_added.len(), 4);
    assert_eq!(r.frames_added, ["Phase 1"]);
    assert!(r.files.contains(&"plan/stages/M0.md".to_string()));
    assert!(r.files.contains(&"plan/boards/roadmap.board.json".to_string()));

    let auth = p.load_stage("AUTH").unwrap();
    assert_eq!(auth.tasks.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["AUTH-01", "AUTH-02"]);
    assert_eq!(auth.depends, vec![Dep { id: "M0".into(), soft: false }]);
    let rel = p.load_stage("REL").unwrap();
    assert!(rel.depends.iter().any(|d| d.id == "UI"));
    let m0 = p.load_stage("M0").unwrap();
    assert_eq!(m0.comments[0].author, "tester");
    assert_eq!(m0.priority, Priority::High);

    let b = p.load_board("roadmap").unwrap();
    let (m0x, _) = pos(&b, "M0");
    let (ax, _) = pos(&b, "AUTH");
    let (rx, _) = pos(&b, "REL");
    assert_eq!(ax, m0x + 320.0);
    assert_eq!(rx, ax + 320.0);
    let frame = b.elements.iter().find(|e| e["type"] == "frame").unwrap();
    assert_eq!(frame["name"], "Phase 1");
    let fid = frame["id"].as_str().unwrap();
    let members: Vec<&str> =
        b.elements.iter().filter(|e| e.get("frame").and_then(Value::as_str) == Some(fid)).map(|e| e["ref"].as_str().unwrap()).collect();
    assert_eq!(members.len(), 2);
    // frame encloses member cards with 24 padding (FRAME_PAD)
    let (fx, fw) = (frame["x"].as_f64().unwrap(), frame["w"].as_f64().unwrap());
    assert_eq!(fx, m0x - 24.0);
    assert_eq!(fw, (ax + 250.0 + 24.0) - fx);
    // ids look like the canvas ones, frame sits below its cards in z-order
    assert!(frame["id"].as_str().unwrap().starts_with('e') && frame["id"].as_str().unwrap().len() == 11);
    let fi = frame["index"].as_str().unwrap();
    assert!(b.elements.iter().filter(|e| e.get("frame").and_then(Value::as_str) == Some(fid)).all(|e| e["index"].as_str().unwrap() > fi));
    assert_eq!(p.validate().unwrap(), vec![]);
}

#[test]
fn dry_run_writes_nothing() {
    let (d, p) = project();
    let before = std::fs::read_to_string(d.path().join("plan/boards/roadmap.board.json")).unwrap();
    let r = p.apply(&spec(BIG), &ApplyOptions { dry_run: true, ..opts() }).unwrap();
    assert_eq!(r.created.len(), 4);
    assert!(p.load_stages().unwrap().is_empty());
    assert_eq!(std::fs::read_to_string(d.path().join("plan/boards/roadmap.board.json")).unwrap(), before);
}

#[test]
fn rollback_on_cycle_and_unknown_dep() {
    let (_d, p) = project();
    p.apply(&spec("stages: [{id: A, title: A}, {id: B, title: B, depends: [A]}]"), &opts()).unwrap();
    let a_before = p.stage_source("A").unwrap();
    let e = p
        .apply(&spec("stages: [{id: C, title: C}, {id: A, depends: [B]}]"), &opts())
        .unwrap_err();
    assert!(matches!(e, Error::Cycle(_)), "{e}");
    assert_eq!(p.stage_source("A").unwrap(), a_before);
    assert!(p.load_stage("C").is_err(), "nothing written");

    let e = p.apply(&spec("stages: [{id: C, title: C, depends: [NOPE]}]"), &opts()).unwrap_err();
    assert!(matches!(e, Error::NotFound(_)));
    assert!(p.load_stage("C").is_err());
    let e = p.apply(&spec("stages: [{id: C}]"), &opts()).unwrap_err();
    assert!(matches!(e, Error::InvalidSpec(_)));
}

#[test]
fn hash_conflict_is_transactional() {
    let (_d, p) = project();
    p.apply(&spec("stages: [{id: A, title: A, tasks: [one]}]"), &opts()).unwrap();
    let h = p.stage_hash("A").unwrap();
    assert_eq!(h.len(), 64);
    p.add_task("A", "sneaky").unwrap();
    let s = spec(&format!("stages: [{{id: B, title: B}}, {{id: A, tasks: [mine]}}]\nexpected: {{A: \"{h}\"}}"));
    let e = p.apply(&s, &opts()).unwrap_err();
    assert!(matches!(e, Error::Conflict { ref key } if key == "A"));
    assert!(p.load_stage("B").is_err());
    assert_eq!(p.load_stage("A").unwrap().tasks.len(), 2);
    // fresh hash passes
    let h2 = p.stage_hash("A").unwrap();
    let s = spec(&format!("stages: [{{id: A, tasks: [mine]}}]\nexpected: {{A: \"{h2}\"}}"));
    p.apply(&s, &opts()).unwrap();
    assert_eq!(p.load_stage("A").unwrap().tasks.len(), 3);
}

#[test]
fn reapply_is_idempotent() {
    let (_d, p) = project();
    p.apply(&spec(BIG), &opts()).unwrap();
    let board = p.load_board("roadmap").unwrap();
    let r = p.apply(&spec(BIG), &opts()).unwrap();
    assert!(r.created.is_empty() && r.updated.is_empty() && r.cards_added.is_empty(), "{r:?}");
    assert!(r.frames_added.is_empty() && r.files.is_empty(), "{r:?}");
    assert_eq!(p.load_stage("AUTH").unwrap().tasks.len(), 2);
    assert_eq!(p.load_stage("M0").unwrap().comments.len(), 1);
    assert_eq!(p.load_board("roadmap").unwrap(), board);
}

#[test]
fn update_existing_fields_tasks_and_place() {
    let (_d, p) = project();
    p.apply(&spec("stages: [{id: A, title: A, due: 2026-12-01, branch: x, tasks: [t1, t2]}]"), &opts()).unwrap();
    assert_eq!(p.load_stage("A").unwrap().due.as_deref(), Some("2026-12-01"));
    let r = p
        .apply(&spec("stages: [{id: A, due: '', branch: '', tasks_done: [A-01], place: {x: 500, y: 40}}]"), &opts())
        .unwrap();
    assert_eq!(r.updated, ["A"]);
    let a = p.load_stage("A").unwrap();
    assert!(a.due.is_none() && a.branch.is_none() && a.tasks[0].done);
    let b = p.load_board("roadmap").unwrap();
    assert_eq!(pos(&b, "A"), (500.0, 40.0));
    let e = p.apply(&spec("stages: [{id: A, tasks_done: [A-99]}]"), &opts()).unwrap_err();
    assert!(matches!(e, Error::NotFound(_)));
}

#[test]
fn place_after_and_json_spec() {
    let (_d, p) = project();
    p.apply(&spec(r#"{"stages":[{"id":"A","title":"A","place":{"x":100,"y":100}},{"id":"B","title":"B","place":{"after":"A"}}]}"#), &opts())
        .unwrap();
    let b = p.load_board("roadmap").unwrap();
    assert_eq!(pos(&b, "B"), (420.0, 100.0));
    assert!(matches!(Project::parse_spec("stages: [{id: A, bogus: 1}]"), Err(Error::InvalidSpec(_))));
    assert!(matches!(Project::parse_spec("{ nope"), Err(Error::InvalidSpec(_))));
}

#[test]
fn generated_key_and_title_reuse() {
    let (_d, p) = project();
    let r = p.apply(&spec("stages: [{title: Build pipeline}]"), &opts()).unwrap();
    assert_eq!(r.created, ["BP"]);
    let r = p.apply(&spec("stages: [{title: Build pipeline, tasks: [x]}]"), &opts()).unwrap();
    assert!(r.created.is_empty());
    assert_eq!(p.load_stages().unwrap().len(), 1);
    let e = p.apply(&spec("stages: [{id: Z, title: Z}, {id: Z, title: Z}]"), &opts()).unwrap_err();
    assert!(matches!(e, Error::DuplicateKey(_)));
}

#[test]
fn layout_no_overlap_and_dep_order() {
    let (_d, p) = project();
    p.apply(&spec(BIG), &opts()).unwrap();
    // scramble positions and add an obstacle where the layout would put a card
    let mut b = p.load_board("roadmap").unwrap();
    for (i, e) in b.elements.iter_mut().filter(|e| e["type"] == "card").enumerate() {
        e.insert("x".into(), Value::from(10 * i as i64));
        e.insert("y".into(), Value::from(7 * i as i64));
    }
    let obstacle = serde_json::json!({"id":"eobst00001","type":"rect","x":0,"y":-10,"w":900,"h":500,"index":"zz"});
    b.elements.push(obstacle.as_object().unwrap().clone());
    p.save_board("roadmap", &b).unwrap();

    let b = p.layout_board("roadmap", &[]).unwrap();
    let c = cards(&b);
    for (k, dep) in [("AUTH", "M0"), ("UI", "M0"), ("REL", "AUTH"), ("REL", "UI")] {
        assert!(pos(&b, k).0 >= pos(&b, dep).0 + 320.0, "{k} right of {dep}");
    }
    for (i, a) in c.iter().enumerate() {
        for o in &c[i + 1..] {
            let overlap = a.1 < o.1 + 250.0 && o.1 < a.1 + 250.0 && a.2 < o.2 + 140.0 && o.2 < a.2 + 140.0;
            assert!(!overlap, "{a:?} overlaps {o:?}");
        }
        // clear of the rect obstacle (0..900 x -10..490) unless it is entirely below it
        assert!(a.2 >= 490.0 || a.1 >= 900.0 || a.2 + 140.0 <= -10.0, "{a:?} overlaps obstacle");
    }
    // saved
    assert_eq!(p.load_board("roadmap").unwrap(), b);
    // frame refitted around its members
    let frame = b.elements.iter().find(|e| e["type"] == "frame").unwrap();
    assert!(frame["w"].as_f64().unwrap() >= 250.0 + 80.0);
}

#[test]
fn layout_only_new_keeps_others() {
    let (_d, p) = project();
    p.apply(&spec("stages: [{id: A, title: A, place: {x: 5, y: 5}}, {id: B, title: B, place: {x: 5, y: 600}}]"), &opts())
        .unwrap();
    p.apply(&spec("stages: [{id: C, title: C, depends: [A]}]"), &opts()).unwrap();
    let b = p.load_board("roadmap").unwrap();
    assert_eq!(pos(&b, "A"), (5.0, 5.0));
    assert_eq!(pos(&b, "B"), (5.0, 600.0));
    assert_eq!(pos(&b, "C"), (325.0, 5.0));
    let b = p.layout_board("roadmap", &["C".into()]).unwrap();
    assert_eq!(pos(&b, "A"), (5.0, 5.0));
    assert!(matches!(p.layout_board("roadmap", &["ZZ".into()]), Err(Error::NotFound(_))));
}

#[test]
fn next_ordering() {
    let (_d, p) = project();
    p.apply(
        &spec(
            r#"
stages:
  - {id: LOW, title: Low, priority: low, tasks: [l1]}
  - {id: HI2, title: Hi later, priority: high, due: 2026-12-31, tasks: [h2]}
  - {id: HI1, title: Hi soon, priority: high, due: 2026-11-30, tasks: [h1a, h1b]}
  - {id: HI3, title: Hi nodue, priority: high, tasks: [h3]}
  - {id: MED, title: Med, tasks: [m1]}
  - {id: BLK, title: Blocked, priority: high, depends: [MED], tasks: [b1]}
"#,
        ),
        &opts(),
    )
    .unwrap();
    let ids: Vec<String> = p.next_tasks(0).unwrap().into_iter().map(|t| t.task_id).collect();
    assert_eq!(ids, ["HI1-01", "HI1-02", "HI2-01", "HI3-01", "MED-01", "LOW-01"]);
    assert_eq!(p.next_tasks(2).unwrap().len(), 2);
    p.set_task_done("MED-01", true).unwrap();
    let ids: Vec<String> = p.next_tasks(0).unwrap().into_iter().map(|t| t.task_id).collect();
    assert!(ids.contains(&"BLK-01".to_string()), "unblocked: {ids:?}");
}

#[test]
fn comments_round_trip() {
    let (_d, p) = project();
    p.create_stage("A", Some("A")).unwrap();
    let s = p.add_comment("A", "agent:claude", "line one\nline two — dash").unwrap();
    assert_eq!(s.comments.len(), 1);
    let again = p.load_stage("A").unwrap();
    assert_eq!(again.comments[0].author, "agent:claude");
    assert_eq!(again.comments[0].text, "line one line two — dash");
    assert!(again.comments[0].at.ends_with('Z') && again.comments[0].at.len() == 17);
    assert!(p.add_comment("A", "x", "  ").is_err());
    assert!(matches!(p.add_comment("NOPE", "x", "y"), Err(Error::NotFound(_))));
}

#[test]
fn proposals_lifecycle() {
    let (d, p) = project();
    let prop = p.propose(&spec("stages: [{id: A, title: A, tasks: [t]}]"), "agent:x").unwrap();
    assert!(p.load_stages().unwrap().is_empty(), "propose changes no plan files");
    assert_eq!(prop.preview.created, ["A"]);
    assert!(d.path().join(format!(".pathloom/proposals/{}.json", prop.id)).is_file());
    let list = p.list_proposals().unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0], prop);

    let rep = p.accept_proposal(&prop.id).unwrap();
    assert_eq!(rep.created, ["A"]);
    assert!(p.list_proposals().unwrap().is_empty());
    assert_eq!(p.load_stage("A").unwrap().tasks.len(), 1);

    let p2 = p.propose(&spec("stages: [{id: B, title: B}]"), "a").unwrap();
    p.reject_proposal(&p2.id).unwrap();
    assert!(p.load_stage("B").is_err() && p.list_proposals().unwrap().is_empty());
    assert!(matches!(p.reject_proposal(&p2.id), Err(Error::NotFound(_))));
    assert!(matches!(p.accept_proposal("../x"), Err(Error::InvalidName(_))));
    // an invalid spec is refused at propose time
    assert!(p.propose(&spec("stages: [{id: C, title: C, depends: [NOPE]}]"), "a").is_err());
}

#[test]
fn validate_and_fix() {
    let (d, p) = project();
    p.apply(&spec("stages: [{id: A, title: A, tasks: [t]}, {id: B, title: B, depends: [A]}]"), &opts()).unwrap();
    assert!(p.validate().unwrap().is_empty());
    // break things by hand
    let a = d.path().join("plan/stages/B.md");
    let t = std::fs::read_to_string(&a).unwrap().replace("depends: [A]", "depends: [A, GONE]");
    std::fs::write(&a, t).unwrap();
    let a = d.path().join("plan/stages/A.md");
    let t = std::fs::read_to_string(&a).unwrap().replace("A-01", "WRONG-1");
    std::fs::write(&a, t).unwrap();
    std::fs::write(d.path().join("plan/stages/Z.md"), "no frontmatter").unwrap();
    let mut b = p.load_board("roadmap").unwrap();
    b.elements.push(
        serde_json::json!({"id":"eorphan001","type":"card","ref":"GONE","x":0,"y":0,"w":250,"h":100,"index":"zz"})
            .as_object()
            .unwrap()
            .clone(),
    );
    p.save_board("roadmap", &b).unwrap();

    let codes: Vec<String> = p.validate().unwrap().into_iter().map(|i| i.code).collect();
    for c in ["BROKEN_DEPEND", "INVALID_TASK_ID", "PARSE_ERROR", "BROKEN_CARD"] {
        assert!(codes.contains(&c.to_string()), "{c} in {codes:?}");
    }
    let fixes = p.validate_fix().unwrap();
    assert_eq!(fixes.len(), 2, "{fixes:?}");
    let codes: Vec<String> = p.validate().unwrap().into_iter().map(|i| i.code).collect();
    assert!(!codes.contains(&"BROKEN_DEPEND".into()) && !codes.contains(&"BROKEN_CARD".into()));
    assert!(codes.contains(&"INVALID_TASK_ID".into()), "not auto-fixed");

    // cycle detection
    std::fs::remove_file(d.path().join("plan/stages/Z.md")).unwrap();
    let a = d.path().join("plan/stages/A.md");
    let t = std::fs::read_to_string(&a).unwrap().replace("kind: stage", "kind: stage\ndepends: [B]");
    std::fs::write(&a, t).unwrap();
    assert!(p.validate().unwrap().iter().any(|i| i.code == "CYCLE"));
}

#[test]
fn writes_registry_tracks_own_writes() {
    let (d, p) = project();
    p.create_stage("Own", Some("OWN")).unwrap();
    let path = d.path().join("plan/stages/OWN.md");
    let h = hash_bytes(&std::fs::read(&path).unwrap());
    assert!(writes::is_own(&path, &h));
    assert!(!writes::is_own(&path, "deadbeef"));
    std::fs::write(&path, "external").unwrap();
    assert!(!writes::is_own(&path, &hash_bytes(b"external")));
    assert_eq!(hash_bytes(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
}
