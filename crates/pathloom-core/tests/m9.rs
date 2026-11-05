//! Readable boards: full layout by phases, auto-layout after agent changes, pinned cards, plan hints.

use pathloom_core::{ApplyOptions, Project};
use serde_json::Value;

fn setup() -> (tempfile::TempDir, Project) {
    let dir = tempfile::tempdir().unwrap();
    let p = Project::init(dir.path(), "demo").unwrap();
    (dir, p)
}

fn apply(p: &Project, yaml: &str) {
    p.apply(&Project::parse_spec(yaml).unwrap(), &ApplyOptions::default()).unwrap();
}

fn pos(p: &Project, key: &str) -> (f64, f64) {
    let b = p.load_board("roadmap").unwrap();
    let e = b.elements.iter().find(|e| e.get("ref").and_then(Value::as_str) == Some(key)).unwrap();
    (e["x"].as_f64().unwrap(), e["y"].as_f64().unwrap())
}

const PLAN: &str = "
stages:
  - {id: A, title: A, tasks: [a]}
  - {id: B, title: B, tasks: [b], depends: [A]}
  - {id: C, title: C, tasks: [c], depends: [B]}
  - {id: D, title: D, tasks: [d], depends: [A]}
frames:
  - {name: '2 · Later', members: [C, D]}
  - {name: '1 · First', members: [A, B]}
";

#[test]
fn full_layout_puts_phases_in_column_blocks() {
    let (_d, p) = setup();
    apply(&p, PLAN);
    p.layout_board("roadmap", &[]).unwrap();
    let (ax, bx, cx, dx) = (pos(&p, "A").0, pos(&p, "B").0, pos(&p, "C").0, pos(&p, "D").0);
    assert!(ax < bx, "inside a phase: left to right");
    // the whole second phase sits right of the first one
    assert!(cx > bx && dx > bx, "{ax} {bx} {cx} {dx}");
    let b = p.load_board("roadmap").unwrap();
    let frames: Vec<(f64, f64)> = b
        .elements
        .iter()
        .filter(|e| e["type"] == "frame")
        .map(|e| (e["x"].as_f64().unwrap(), e["x"].as_f64().unwrap() + e["w"].as_f64().unwrap()))
        .collect();
    assert_eq!(frames.len(), 2);
    assert!(frames[0].1 <= frames[1].0 || frames[1].1 <= frames[0].0, "frames do not overlap: {frames:?}");
}

#[test]
fn auto_layout_rearranges_after_apply_and_keeps_pinned_cards() {
    let (_d, p) = setup();
    apply(&p, PLAN);
    let b = p.set_board_auto_layout("roadmap", true).unwrap();
    assert!(b.auto_layout);
    assert!(p.stage_source("A").is_ok());
    assert!(std::fs::read_to_string(p.plan_dir().join("boards/roadmap.board.json")).unwrap().contains("\"autoLayout\": true"));
    // the user pins C somewhere far away
    let mut b = p.load_board("roadmap").unwrap();
    for e in &mut b.elements {
        if e.get("ref").and_then(Value::as_str) == Some("C") {
            e.insert("x".into(), 5000.into());
            e.insert("y".into(), 5000.into());
            e.insert("pinned".into(), true.into());
        }
    }
    p.save_board("roadmap", &b).unwrap();
    // an agent adds a stage: the board re-arranges, C stays
    apply(&p, "stages: [{id: E, title: E, tasks: [e], depends: [D]}]");
    assert_eq!(pos(&p, "C"), (5000.0, 5000.0));
    assert!(pos(&p, "E").0 > pos(&p, "D").0);
    // turning it off keeps positions
    let before = pos(&p, "E");
    p.set_board_auto_layout("roadmap", false).unwrap();
    assert_eq!(pos(&p, "E"), before);
    assert!(!p.load_board("roadmap").unwrap().auto_layout);
}

#[test]
fn hints_and_description() {
    let (_d, p) = setup();
    apply(
        &p,
        "stages:
  - {id: A, title: A, tasks: [a], description: Base for everything}
  - {id: B, title: B, tasks: [b], depends: [A]}
  - {id: C, title: C, depends: [A, B]}",
    );
    assert_eq!(p.load_stage("A").unwrap().description, "Base for everything");
    let codes: Vec<(String, String)> = p.plan_hints().unwrap().into_iter().map(|i| (i.code, i.message)).collect();
    assert!(codes.iter().any(|(c, m)| c == "REDUNDANT_DEP" && m.starts_with("C already waits for A")), "{codes:?}");
    assert!(codes.iter().any(|(c, m)| c == "NO_DESCRIPTION" && m.starts_with("B ")));
    assert!(!codes.iter().any(|(c, m)| c == "NO_DESCRIPTION" && (m.starts_with("A ") || m.starts_with("C "))), "A has one, C has no tasks");
}

#[test]
fn task_notes_and_files() {
    let (d, p) = setup();
    apply(&p, "stages: [{id: A, title: A, tasks: [one, two]}]");
    p.set_task_note("A-01", "Use PKCE.\nSee RFC 7636.").unwrap();
    p.add_task_file("A-01", "docs/auth.md").unwrap();
    p.add_task_file("A-01", r"docs\auth.md").unwrap(); // same file, no duplicate
    let s = p.load_stage("A").unwrap();
    assert_eq!(s.task_info["A-01"].note, "Use PKCE.\nSee RFC 7636.");
    assert_eq!(s.task_info["A-01"].files, ["docs/auth.md"]);
    assert!(p.add_task_file("A-01", "../x").is_err());
    assert!(p.set_task_note("A-09", "x").is_err());
    // apply sets notes and files too
    apply(&p, "stages: [{id: A, task_notes: {A-02: Second}, task_files_add: {A-02: ['https://x.dev/spec']}}]");
    let s = p.load_stage("A").unwrap();
    assert_eq!((s.task_info["A-02"].note.as_str(), s.task_info["A-02"].files.len()), ("Second", 1));
    // clearing removes the entry; removing a task drops its details
    p.set_task_note("A-02", "").unwrap();
    p.remove_task_file("A-02", "https://x.dev/spec").unwrap();
    p.remove_task("A-01").unwrap();
    let src = std::fs::read_to_string(d.path().join("plan/stages/A.md")).unwrap();
    assert!(!src.contains("task_info"), "{src}");
}

/// Cards size to their content in the app, which stores the real `w`; layout must not let a wide card cover
/// the next column (full layout) or a card placed next to it (layout of new cards).
#[test]
fn layout_uses_stored_card_width() {
    let (_d, p) = setup();
    apply(&p, "stages:\n  - {id: A, title: A, tasks: [a]}\n  - {id: B, title: B, tasks: [b], depends: [A]}\n");
    let mut b = p.load_board("roadmap").unwrap();
    for e in &mut b.elements {
        if e.get("ref").and_then(Value::as_str) == Some("A") {
            e.insert("w".into(), 420.into());
        }
    }
    p.save_board("roadmap", &b).unwrap();
    p.layout_board("roadmap", &[]).unwrap();
    let ((ax, _), (bx, _)) = (pos(&p, "A"), pos(&p, "B"));
    assert!(bx >= ax + 420.0 + 70.0, "full layout: B starts after wide A: {ax} {bx}");

    apply(&p, "stages:\n  - {id: C, title: C, tasks: [c], depends: [A]}\n");
    p.layout_board("roadmap", &["C".to_string()]).unwrap();
    assert!(pos(&p, "C").0 >= ax + 420.0 + 70.0, "new card goes right of wide A");
}
