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

#[test]
fn claims_and_log_commands() {
    let p = Proj::new();
    let file = p.dir.path().join("spec.yaml");
    std::fs::write(&file, SPEC).unwrap();
    p.json(&["--author", "agent:Claude", "apply", file.to_str().unwrap()]);

    let c = p.json(&["--author", "agent:Claude", "task", "claim", "A-01", "--ttl", "10m", "--note", "working"]);
    assert_eq!(c["task_id"], "A-01");
    assert_eq!(c["agent"], "claude");
    assert_eq!(c["note"], "working");

    // another agent: conflict with structured error, and the task is hidden from `next`
    let o = p.run(&["--json", "--author", "codex", "task", "claim", "A-01"]);
    assert!(!o.status.success());
    let e: Value = serde_json::from_slice(&o.stderr).unwrap();
    assert_eq!(e["code"], "CLAIMED");
    assert_eq!(e["details"]["by"], "claude");
    assert_eq!(e["details"]["task_id"], "A-01");
    assert_eq!(p.json(&["--author", "codex", "next"])["tasks"].as_array().unwrap().len(), 0);
    assert_eq!(p.json(&["--author", "claude", "next"])["tasks"][0]["claimed_by"], "claude");

    let list = p.json(&["claims"]);
    assert_eq!(list["claims"].as_array().unwrap().len(), 1);
    assert_eq!(list["claims"][0]["agent"], "claude");

    // release by a stranger needs --force
    assert!(!p.run(&["--author", "codex", "task", "release", "A-01"]).status.success());
    p.json(&["--author", "codex", "task", "release", "A-01", "--force"]);
    assert_eq!(p.json(&["claims"])["claims"].as_array().unwrap().len(), 0);

    // done releases
    p.json(&["--author", "claude", "task", "claim", "A-01"]);
    p.json(&["--author", "claude", "task", "done", "A-01"]);
    assert_eq!(p.json(&["claims"])["claims"].as_array().unwrap().len(), 0);

    let log = p.json(&["log", "--limit", "50"]);
    let actions: Vec<&str> = log["entries"].as_array().unwrap().iter().map(|e| e["action"].as_str().unwrap()).collect();
    assert_eq!(actions, ["task done", "claim_task", "release_task", "claim_task", "apply"]);
    let first_apply = &log["entries"][4];
    assert_eq!((first_apply["author"].as_str(), first_apply["source"].as_str()), (Some("claude"), Some("cli")));
    assert_eq!(first_apply["stages"], serde_json::json!(["A", "B"]));
    assert_eq!(first_apply["files"][0], "plan/stages/A.md");
    assert_eq!(log["entries"][2]["author"], "codex");
    let only_b = p.json(&["log", "--stage", "B"]);
    assert_eq!(only_b["entries"].as_array().unwrap().len(), 1);
    assert!(p.run(&["log"]).status.success());
}

#[test]
fn log_failure_is_only_a_warning() {
    let p = Proj::new();
    p.json(&["stage", "add", "A", "Alpha", "--direct"]);
    // a directory where the log file should be: appending fails
    let log = p.dir.path().join(".pathloom/log/agent.jsonl");
    std::fs::remove_file(&log).unwrap();
    std::fs::create_dir_all(&log).unwrap();
    let o = p.run(&["--json", "task", "add", "A", "one"]);
    assert!(o.status.success());
    let v: Value = serde_json::from_slice(&o.stdout).unwrap();
    assert_eq!(v["task_id"], "A-01");
    assert!(v["log_warning"].as_str().unwrap().contains("activity log not written"));
    assert!(String::from_utf8_lossy(&o.stderr).contains("warning:"));
}

#[test]
fn info_json_has_protocol_and_capabilities() {
    let p = Proj::new();
    let v = p.json(&["info"]);
    assert_eq!(v["protocol"], "pathloom/1");
    assert_eq!(v["name"], "demo");
    assert!(v["capabilities"].as_array().unwrap().iter().any(|c| c == "events"));
    let human = p.run(&["info"]);
    let text = String::from_utf8_lossy(&human.stdout);
    assert!(text.contains("protocol: pathloom/1") && text.contains("capabilities:"), "{text}");
}

#[test]
fn agent_set_list_remove() {
    let p = Proj::new();
    let v = p.json(&["agent", "set", "claude-code", "--name", "Claude", "--color", "#d97757", "--avatar", "🤖"]);
    assert_eq!(v["agent"]["kind"], "agent");
    p.json(&["agent", "set", "maestro", "--name", "Maestro", "--kind", "orchestrator"]);
    p.json(&["agent", "set", "claude-code", "--color", "#fff"]); // merge keeps name
    let v = p.json(&["agent", "list"]);
    assert_eq!(v["agents"][0]["name"], "Claude");
    assert_eq!(v["agents"][0]["color"], "#fff");
    assert_eq!(v["agents"][1]["kind"], "orchestrator");
    assert!(!p.run(&["agent", "set", "x", "--color", "red"]).status.success());
    assert!(!p.run(&["agent", "set", "Bad Id"]).status.success());
    p.json(&["agent", "remove", "maestro"]);
    assert!(!p.run(&["agent", "remove", "maestro"]).status.success());
    assert_eq!(p.json(&["agent", "list"])["agents"].as_array().unwrap().len(), 1);
    assert_eq!(p.json(&["log", "--limit", "1"])["entries"][0]["action"], "agent remove");
}

#[test]
fn task_claim_with_session() {
    let p = Proj::new();
    p.json(&["stage", "add", "A", "Alpha", "--direct"]);
    p.json(&["task", "add", "A", "one", "--direct"]);
    let v = p.json(&[
        "--author", "maestro", "task", "claim", "A-01", "--session-client", "maestro", "--session-id", "sess_1",
        "--session-url", "maestro://session/sess_1", "--session-title", "Implement auth",
    ]);
    assert_eq!(v["session"]["id"], "sess_1");
    assert_eq!(p.json(&["stage", "show", "A"])["sessions"][0]["title"], "Implement auth");
    assert_eq!(p.json(&["log", "--limit", "1"])["entries"][0]["session"]["client"], "maestro");
    // --session-client alone, and invalid sessions, are errors
    assert!(!p.run(&["task", "claim", "A-01", "--session-client", "maestro"]).status.success());
    assert!(!p.run(&["task", "claim", "A-01", "--session-client", "M", "--session-id", "1"]).status.success());
}

#[test]
fn skill_install_refuses_overwrite_without_force() {
    let p = Proj::new();
    let file = p.dir.path().join(".agents/skills/pathloom/SKILL.md");
    let v = p.json(&["skill", "install"]);
    assert!(v["path"].as_str().unwrap().ends_with("SKILL.md"));
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(text.starts_with("---") && text.contains("pathloom"), "{text}");
    std::fs::write(&file, "mine").unwrap();
    let o = p.run(&["--json", "skill", "install"]);
    assert!(!o.status.success());
    assert!(String::from_utf8_lossy(&o.stderr).contains("ALREADY_EXISTS"));
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "mine");
    p.json(&["skill", "install", "--force"]);
    assert_eq!(std::fs::read_to_string(&file).unwrap(), text);
    p.json(&["skill", "install", "--dir", "custom/skills"]);
    assert!(p.dir.path().join("custom/skills/pathloom/SKILL.md").is_file());
    assert!(!p.run(&["skill", "install", "--dir", "../out"]).status.success());
}

#[test]
fn init_agents_skill() {
    let d = tempfile::tempdir().unwrap();
    let o = Command::new(env!("CARGO_BIN_EXE_pathloom"))
        .arg("--project")
        .arg(d.path())
        .args(["init", "--agents-skill"])
        .output()
        .unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    assert!(d.path().join(".agents/skills/pathloom/SKILL.md").is_file());
}

/// Spawn `pathloom watch --json`, return the child and a channel of its stdout lines.
fn spawn_watch(p: &Proj, extra: &[&str]) -> (std::process::Child, std::sync::mpsc::Receiver<String>) {
    use std::io::BufRead;
    let mut child = p.cmd(&["--json", "watch"]).args(extra).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
    let out = child.stdout.take().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for l in std::io::BufReader::new(out).lines().map_while(Result::ok) {
            let _ = tx.send(l);
        }
    });
    (child, rx)
}

fn next_line(rx: &std::sync::mpsc::Receiver<String>, secs: u64) -> Option<Value> {
    rx.recv_timeout(std::time::Duration::from_secs(secs)).ok().map(|l| serde_json::from_str(&l).unwrap())
}

#[test]
fn watch_json_hello_then_stage_event() {
    let p = Proj::new();
    let (mut child, rx) = spawn_watch(&p, &[]);
    let hello = next_line(&rx, 10).expect("hello");
    assert_eq!(hello["type"], "hello");
    assert_eq!(hello["protocol"], "pathloom/1");
    assert!(p.run(&["stage", "add", "AUTH", "Authentication", "--direct"]).status.success());
    let mut seen = Vec::new();
    let end = std::time::Instant::now() + std::time::Duration::from_secs(8);
    let mut found = false;
    while std::time::Instant::now() < end {
        let Some(v) = next_line(&rx, 1) else { continue };
        if v["type"] == "stage" && v["key"] == "AUTH" {
            assert_eq!(v["change"], "created");
            found = true;
            break;
        }
        seen.push(v["type"].to_string());
    }
    let _ = child.kill();
    assert!(found, "no stage event; saw {seen:?}");
}

#[test]
fn watch_since_replays_log_then_goes_live() {
    let p = Proj::new();
    p.json(&["stage", "add", "A", "Alpha", "--direct"]);
    let (mut child, rx) = spawn_watch(&p, &["--since", "2000-01-01T00:00:00Z"]);
    assert_eq!(next_line(&rx, 10).expect("hello")["type"], "hello");
    let v = next_line(&rx, 10).expect("replayed entry");
    assert_eq!((v["type"].as_str(), v["entry"]["action"].as_str()), (Some("activity"), Some("stage add")));
    let _ = child.kill();
    // a future --since replays nothing; a malformed one is an error
    let (mut child, rx) = spawn_watch(&p, &["--since", "2999-01-01T00:00:00Z"]);
    assert_eq!(next_line(&rx, 10).expect("hello")["type"], "hello");
    assert!(next_line(&rx, 1).is_none());
    let _ = child.kill();
    assert!(!p.run(&["watch", "--since", "yesterday"]).status.success());
}
