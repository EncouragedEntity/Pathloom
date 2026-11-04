//! Runs the built `pathloom` binary against a temp project.

use serde_json::Value;
use std::io::Write;
use std::process::{Command, Output, Stdio};

struct Proj {
    dir: tempfile::TempDir,
}

impl Proj {
    fn new() -> Proj {
        let p = Proj { dir: tempfile::tempdir().unwrap() };
        assert!(p.run(&["init", "--name", "demo"]).status.success());
        p
    }

    fn cmd(&self, args: &[&str]) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_pathloom"));
        c.arg("--project").arg(self.dir.path()).args(args);
        c
    }

    fn run(&self, args: &[&str]) -> Output {
        self.cmd(args).output().unwrap()
    }

    fn json(&self, args: &[&str]) -> Value {
        let mut a = vec!["--json"];
        a.extend_from_slice(args);
        let o = self.run(&a);
        assert!(o.status.success(), "{args:?}: {}", String::from_utf8_lossy(&o.stderr));
        serde_json::from_slice(&o.stdout).unwrap()
    }

    fn set_review(&self) {
        let path = self.dir.path().join(".pathloom/project.toml");
        let t = std::fs::read_to_string(&path).unwrap().replace("\"auto\"", "\"review\"");
        std::fs::write(path, t).unwrap();
    }
}

const SPEC: &str = "board: roadmap\nstages:\n  - {id: A, title: Alpha, tasks: [one]}\n  - {id: B, title: Beta, depends: [A], tasks: [two]}\n";

#[test]
fn full_flow_with_json() {
    let p = Proj::new();
    p.run(&["stage", "add", "M0", "Core", "--direct"]);
    let v = p.json(&["stage", "add", "AUTH", "Authentication", "--after", "M0"]);
    assert_eq!(v["mode"], "applied");
    let v = p.json(&["task", "add", "M0", "Write format"]);
    assert_eq!(v["task_id"], "M0-01");
    p.json(&["task", "add", "AUTH", "Login"]);
    p.json(&["task", "add", "M0", "Write tests"]);

    // AUTH is blocked until M0 is done, so only M0 tasks are next
    let next = p.json(&["next"]);
    let ids: Vec<&str> = next["tasks"].as_array().unwrap().iter().map(|t| t["task_id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["M0-01", "M0-02"]);

    p.json(&["task", "done", "M0-01"]);
    p.json(&["task", "done", "M0-02"]);
    let ids: Vec<String> = p.json(&["next"])["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["task_id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(ids, ["AUTH-01"]);

    p.json(&["stage", "add", "UI", "Interface"]);
    p.json(&["link", "M0", "UI", "--soft"]);
    assert_eq!(p.json(&["stage", "show", "UI"])["depends"][0]["soft"], true);
    let show = p.json(&["stage", "show", "AUTH"]);
    assert_eq!(show["status"], "ready");
    assert_eq!(show["hash"].as_str().unwrap().len(), 64);
    let list = p.json(&["stage", "list", "--status", "done"]);
    assert_eq!(list["stages"][0]["key"], "M0");

    p.json(&["comment", "AUTH", "started"]);
    let show = p.json(&["--author", "me", "stage", "show", "AUTH"]);
    assert_eq!(show["comments"][0]["author"], "agent");
    assert_eq!(p.json(&["board", "list"])["boards"][0], "roadmap");
    assert_eq!(p.json(&["validate"])["ok"], true);
    p.json(&["layout", "roadmap"]);
    for k in ["stage", "board", "spec"] {
        let o = p.run(&["schema", k]);
        let s: Value = serde_json::from_slice(&o.stdout).unwrap();
        assert!(s.get("properties").is_some() || s.get("$defs").is_some(), "{k}");
    }
}

#[test]
fn apply_dry_run_stdin_and_real() {
    let p = Proj::new();
    let mut c = p.cmd(&["--json", "apply", "-", "--dry-run"]);
    c.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = c.spawn().unwrap();
    child.stdin.take().unwrap().write_all(SPEC.as_bytes()).unwrap();
    let o = child.wait_with_output().unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    let v: Value = serde_json::from_slice(&o.stdout).unwrap();
    assert_eq!(v["mode"], "dry_run");
    assert_eq!(v["report"]["created"][1], "B");
    assert!(!p.dir.path().join("plan/stages/A.md").exists());

    let file = p.dir.path().join("spec.yaml");
    std::fs::write(&file, SPEC).unwrap();
    let v = p.json(&["apply", file.to_str().unwrap()]);
    assert_eq!(v["mode"], "applied");
    assert!(p.dir.path().join("plan/stages/B.md").exists());
    // second run: nothing changes
    let v = p.json(&["apply", file.to_str().unwrap()]);
    assert_eq!(v["report"]["files"].as_array().unwrap().len(), 0);
}

#[test]
fn errors_are_structured_and_exit_1() {
    let p = Proj::new();
    let o = p.run(&["--json", "task", "done", "NOPE-01"]);
    assert_eq!(o.status.code(), Some(1));
    let e: Value = serde_json::from_slice(&o.stderr).unwrap();
    assert_eq!(e["code"], "NOT_FOUND");

    std::fs::write(p.dir.path().join("s.yaml"), "stages: [{id: A, title: A}, {id: B, title: B, depends: [A]}]").unwrap();
    p.json(&["apply", p.dir.path().join("s.yaml").to_str().unwrap()]);
    let o = p.run(&["--json", "link", "B", "A"]);
    assert_eq!(o.status.code(), Some(1));
    let e: Value = serde_json::from_slice(&o.stderr).unwrap();
    assert_eq!(e["code"], "CYCLE");
    assert!(e["details"]["nodes"].is_array());

    let o = p.run(&["--json", "layout", "../evil"]);
    let e: Value = serde_json::from_slice(&o.stderr).unwrap();
    assert_eq!(e["code"], "OUT_OF_PROJECT");

    let o = p.run(&["task", "done", "NOPE-01"]);
    assert!(String::from_utf8_lossy(&o.stderr).starts_with("error [NOT_FOUND]"));
}

#[test]
fn review_mode_creates_proposals() {
    let p = Proj::new();
    p.set_review();
    let file = p.dir.path().join("spec.yaml");
    std::fs::write(&file, SPEC).unwrap();
    let v = p.json(&["apply", file.to_str().unwrap()]);
    assert_eq!(v["mode"], "proposed");
    let id = v["proposal_id"].as_str().unwrap().to_string();
    assert!(!p.dir.path().join("plan/stages/A.md").exists());
    assert_eq!(p.json(&["proposals", "list"])["proposals"].as_array().unwrap().len(), 1);

    let v = p.json(&["proposals", "accept", &id]);
    assert_eq!(v["report"]["created"][0], "A");
    assert!(p.dir.path().join("plan/stages/A.md").exists());

    // --direct bypasses review; stage add in review mode proposes
    assert_eq!(p.json(&["stage", "add", "C", "Gamma"])["mode"], "proposed");
    let v = p.json(&["stage", "add", "D", "Delta", "--direct"]);
    assert_eq!(v["mode"], "applied");
    let id = p.json(&["proposals", "list"])["proposals"][0]["id"].as_str().unwrap().to_string();
    p.json(&["proposals", "reject", &id]);
    assert_eq!(p.json(&["proposals", "list"])["proposals"].as_array().unwrap().len(), 0);
}

#[test]
fn validate_fix_and_exit_code() {
    let p = Proj::new();
    std::fs::write(p.dir.path().join("s.yaml"), "stages: [{id: A, title: A}, {id: B, title: B, depends: [A]}]").unwrap();
    p.json(&["apply", p.dir.path().join("s.yaml").to_str().unwrap()]);
    let f = p.dir.path().join("plan/stages/B.md");
    std::fs::write(&f, std::fs::read_to_string(&f).unwrap().replace("depends: [A]", "depends: [A, GONE]")).unwrap();
    let o = p.run(&["--json", "validate"]);
    assert_eq!(o.status.code(), Some(1));
    let v: Value = serde_json::from_slice(&o.stdout).unwrap();
    assert_eq!(v["issues"][0]["code"], "BROKEN_DEPEND");
    let v = p.json(&["validate", "--fix"]);
    assert_eq!(v["ok"], true);
    assert_eq!(v["fixed"].as_array().unwrap().len(), 1);
}

#[test]
fn not_a_project() {
    let d = tempfile::tempdir().unwrap();
    let o = Command::new(env!("CARGO_BIN_EXE_pathloom")).arg("--project").arg(d.path()).args(["--json", "next"]).output().unwrap();
    assert_eq!(o.status.code(), Some(1));
    let e: Value = serde_json::from_slice(&o.stderr).unwrap();
    assert_eq!(e["code"], "NOT_FOUND");
}
