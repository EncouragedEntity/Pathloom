//! Spawns `pathloom mcp` and talks newline-delimited JSON-RPC over stdio.

use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, channel};
use std::time::Duration;

struct Client {
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<Value>,
    next_id: u64,
}

impl Client {
    fn start(dir: &std::path::Path, extra: &[&str]) -> Client {
        let mut child = Command::new(env!("CARGO_BIN_EXE_pathloom"))
            .arg("--project")
            .arg(dir)
            .arg("mcp")
            .args(extra)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let out = child.stdout.take().unwrap();
        let (tx, rx) = channel();
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    let _ = tx.send(v);
                }
            }
        });
        Client { child, stdin, rx, next_id: 1 }
    }

    fn send(&mut self, v: &Value) {
        writeln!(self.stdin, "{v}").unwrap();
        self.stdin.flush().unwrap();
    }

    fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        self.send(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
        loop {
            let v = self.rx.recv_timeout(Duration::from_secs(20)).expect("no response from server");
            if v["id"] == json!(id) {
                return v;
            }
        }
    }

    fn handshake(&mut self) -> Value {
        let r = self.request(
            "initialize",
            json!({"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test-client", "version": "1"}}),
        );
        self.send(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"}));
        r
    }

    fn call(&mut self, name: &str, args: Value) -> (bool, Value) {
        let r = self.request("tools/call", json!({"name": name, "arguments": args}));
        let res = &r["result"];
        let text = res["content"][0]["text"].as_str().unwrap_or("null");
        (res["isError"] == json!(true), serde_json::from_str(text).unwrap_or(Value::Null))
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

fn project() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    pathloom_core_init(d.path());
    d
}

fn pathloom_core_init(p: &std::path::Path) {
    assert!(Command::new(env!("CARGO_BIN_EXE_pathloom")).arg("--project").arg(p).args(["init", "--name", "demo"]).status().unwrap().success());
}

#[test]
fn initialize_list_tools_and_call() {
    let d = project();
    let mut c = Client::start(d.path(), &[]);
    let init = c.handshake();
    assert_eq!(init["result"]["serverInfo"]["name"], "pathloom");
    assert!(init["result"]["capabilities"]["tools"].is_object());

    let tools = c.request("tools/list", json!({}));
    let names: Vec<&str> = tools["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    for n in ["project_info", "list_stages", "get_stage", "next", "search", "apply", "set_task", "add_comment", "layout_board", "validate"] {
        assert!(names.contains(&n), "missing tool {n}: {names:?}");
    }

    let (err, v) = c.call("project_info", json!({}));
    assert!(!err);
    assert_eq!(v["name"], "demo");

    let spec = json!({"stages": [{"id": "A", "title": "Alpha", "tasks": ["one"]}, {"id": "B", "title": "Beta", "depends": ["A"]}]});
    let (err, v) = c.call("apply", json!({"spec": spec, "dry_run": true}));
    assert!(!err, "{v}");
    assert_eq!(v["mode"], "dry_run");
    assert!(!d.path().join("plan/stages/A.md").exists());
    let (err, v) = c.call("apply", json!({"spec": "stages: [{id: A, title: Alpha, tasks: [one]}]"}));
    assert!(!err, "{v}");
    assert_eq!(v["report"]["created"][0], "A");

    let (_, v) = c.call("get_stage", json!({"key": "A"}));
    assert_eq!(v["hash"].as_str().unwrap().len(), 64);
    let (err, v) = c.call("set_task", json!({"task_id": "A-01", "done": true}));
    assert!(!err);
    assert_eq!(v["stage"]["status"], "done");
    let (err, v) = c.call("add_comment", json!({"stage": "A", "text": "hi"}));
    assert!(!err);
    assert_eq!(v["author"], "agent:test-client");
    let (_, v) = c.call("search", json!({"query": "alp"}));
    assert_eq!(v["results"][0]["stage"], "A");
    let (_, v) = c.call("list_stages", json!({"status": "done"}));
    assert_eq!(v["total"], 1);
    let (_, v) = c.call("next", json!({}));
    assert_eq!(v["tasks"].as_array().unwrap().len(), 0);
    let (_, v) = c.call("validate", json!({}));
    assert_eq!(v["ok"], true);

    // structured errors
    let (err, v) = c.call("get_stage", json!({"key": "NOPE"}));
    assert!(err);
    assert_eq!(v["code"], "NOT_FOUND");
    let (err, v) = c.call("apply", json!({"spec": {"stages": [{"id": "A", "depends": ["A"]}]}}));
    assert!(err);
    assert_eq!(v["code"], "CYCLE");
    let (err, v) = c.call("apply", json!({"spec": {"bogus": 1}}));
    assert!(err);
    assert_eq!(v["code"], "INVALID_SPEC");

    // resources
    let r = c.request("resources/list", json!({}));
    assert_eq!(r["result"]["resources"].as_array().unwrap().len(), 4);
    let r = c.request("resources/read", json!({"uri": "pathloom://guide/workflow"}));
    assert!(r["result"]["contents"][0]["text"].as_str().unwrap().contains("Recommended workflow"));
    let r = c.request("resources/read", json!({"uri": "pathloom://schema/spec"}));
    assert!(r["result"]["contents"][0]["text"].as_str().unwrap().contains("tasks_done"));
}

#[test]
fn read_only_blocks_writes() {
    let d = project();
    let mut c = Client::start(d.path(), &["--read-only"]);
    c.handshake();
    let (err, v) = c.call("apply", json!({"spec": {"stages": [{"id": "A", "title": "A"}]}}));
    assert!(err);
    assert_eq!(v["code"], "READ_ONLY");
    let (err, v) = c.call("apply", json!({"spec": {"stages": [{"id": "A", "title": "A"}]}, "dry_run": true}));
    assert!(!err, "{v}");
    let (err, v) = c.call("set_task", json!({"task_id": "A-01", "done": true}));
    assert!(err);
    assert_eq!(v["code"], "READ_ONLY");
    let (err, _) = c.call("layout_board", json!({}));
    assert!(err);
    let (err, _) = c.call("project_info", json!({}));
    assert!(!err);
}
