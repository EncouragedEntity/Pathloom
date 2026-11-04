//! `pathloom`: CLI and MCP server for Pathloom projects.

mod cli;
mod mcp;
mod ops;
mod schema;

use clap::Parser;
use cli::{BoardCmd, Cli, Cmd, ProposalCmd, StageCmd, TaskCmd};
use ops::{ApiError, ApiResult};
use pathloom_core::{ApplySpec, DepSpec, Place, Project, StageSpec};
use serde_json::{Value, json};
use std::io::Read;
use std::process::ExitCode;

fn main() -> ExitCode {
    let cli = Cli::parse();
    match run(&cli) {
        Ok(code) => code,
        Err(e) => {
            if cli.json {
                eprintln!("{}", e.to_json());
            } else {
                eprintln!("error [{}]: {}", e.code, e.message);
            }
            ExitCode::FAILURE
        }
    }
}

fn open(cli: &Cli) -> ApiResult<Project> {
    ops::open_project(&ops::locate_root(cli.project.as_deref())?)
}

/// Print `json` (with --json) or the human text.
fn emit(cli: &Cli, json: &Value, human: impl FnOnce() -> String) {
    if cli.json {
        println!("{json}");
    } else {
        println!("{}", human());
    }
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn list(v: &Value, k: &str) -> Vec<String> {
    v.get(k).and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
}

/// Human summary of a `submit` result.
fn fmt_submit(v: &Value) -> String {
    let r = &v["report"];
    let mut out = match s(v, "mode") {
        "dry_run" => "dry run (nothing written)".to_string(),
        "proposed" => format!("proposal {} saved; waiting for human review", s(v, "proposal_id")),
        _ => "applied".to_string(),
    };
    for (label, key) in [("created", "created"), ("updated", "updated"), ("frames", "frames_added"), ("warnings", "warnings")] {
        let l = list(r, key);
        if !l.is_empty() {
            out.push_str(&format!("\n  {label}: {}", l.join(", ")));
        }
    }
    if let Some(cards) = r["cards_added"].as_array().filter(|c| !c.is_empty()) {
        let c: Vec<String> = cards.iter().map(|c| format!("{} ({}, {})", s(c, "key"), c["x"].as_f64().unwrap_or(0.0), c["y"].as_f64().unwrap_or(0.0))).collect();
        out.push_str(&format!("\n  cards on {}: {}", s(r, "board"), c.join(", ")));
    }
    let files = list(r, "files");
    if !files.is_empty() {
        out.push_str(&format!("\n  files: {}", files.join(", ")));
    }
    out
}

fn fmt_task(t: &Value) -> String {
    let mut meta = vec![s(t, "stage_key").to_string(), s(t, "priority").to_string()];
    if let Some(d) = t["due"].as_str() {
        meta.push(format!("due {d}"));
    }
    format!("{:<9} {}  ({})", s(t, "task_id"), s(t, "title"), meta.join(" · "))
}

fn spec_for_stage(key: &str, f: impl FnOnce(&mut StageSpec)) -> ApplySpec {
    let mut st = StageSpec { id: Some(key.into()), ..Default::default() };
    f(&mut st);
    ApplySpec { stages: vec![st], ..Default::default() }
}

fn read_spec_text(file: &str) -> ApiResult<String> {
    let io = |e: std::io::Error| ApiError::new("IO_ERROR", format!("cannot read {file}: {e}"));
    if file == "-" {
        let mut t = String::new();
        std::io::stdin().read_to_string(&mut t).map_err(io)?;
        Ok(t)
    } else {
        std::fs::read_to_string(file).map_err(io)
    }
}

#[allow(clippy::too_many_lines)]
fn run(cli: &Cli) -> ApiResult<ExitCode> {
    match &cli.command {
        Cmd::Init { plan_dir, name } => {
            let root = match &cli.project {
                Some(p) => std::path::absolute(p),
                None => std::env::current_dir(),
            }
            .map_err(|e| ApiError::new("IO_ERROR", e.to_string()))?;
            let name = name.clone().unwrap_or_else(|| {
                root.file_name().map_or_else(|| "project".into(), |n| n.to_string_lossy().into_owned())
            });
            let p = Project::init_with(&root, &name, plan_dir)?;
            let j = json!({"name": name, "root": p.root.to_string_lossy(), "plan_dir": plan_dir});
            emit(cli, &j, || format!("Initialized Pathloom project `{name}` in {}", p.root.display()));
        }
        Cmd::Board(BoardCmd::Create { name, title }) => {
            let p = open(cli)?;
            p.create_board(name, title.as_deref().unwrap_or(name))?;
            emit(cli, &json!({"board": name}), || format!("Created board {name}"));
        }
        Cmd::Board(BoardCmd::List) => {
            let boards = open(cli)?.list_boards()?;
            emit(cli, &json!({"boards": boards}), || boards.join("\n"));
        }
        Cmd::Stage(StageCmd::Add { key, title, after, who, board, direct }) => {
            let p = open(cli)?;
            if p.load_stages()?.iter().any(|s| &s.key == key) {
                return Err(pathloom_core::Error::DuplicateKey(key.clone()).into());
            }
            let who = ops::parse_who(who)?;
            let mut spec = spec_for_stage(key, |st| {
                st.title = Some(title.clone());
                st.who = Some(who);
                if let Some(a) = after {
                    st.depends = Some(vec![DepSpec::Key(a.clone())]);
                    st.place = Some(Place { after: Some(a.clone()), ..Default::default() });
                }
            });
            spec.board = Some(board.clone());
            let v = ops::submit(&p, &spec, &cli.author, false, *direct)?;
            emit(cli, &v, || fmt_submit(&v));
        }
        Cmd::Stage(StageCmd::Show { key }) => {
            let v = ops::get_stage(&open(cli)?, key)?;
            emit(cli, &v, || {
                let mut o = format!(
                    "{} · {}  [{} · {}/{}]\nwho: {} · priority: {}",
                    s(&v, "key"),
                    s(&v, "title"),
                    s(&v, "status"),
                    v["progress"]["done"],
                    v["progress"]["total"],
                    s(&v, "who"),
                    s(&v, "priority")
                );
                if let Some(d) = v["due"].as_str() {
                    o.push_str(&format!(" · due {d}"));
                }
                let deps: Vec<String> = v["depends"]
                    .as_array()
                    .map(|a| a.iter().map(|d| format!("{}{}", s(d, "id"), if d["soft"] == true { " (soft)" } else { "" })).collect())
                    .unwrap_or_default();
                if !deps.is_empty() {
                    o.push_str(&format!("\ndepends: {}", deps.join(", ")));
                }
                for t in v["tasks"].as_array().into_iter().flatten() {
                    o.push_str(&format!("\n[{}] {} {}", if t["done"] == true { "x" } else { " " }, s(t, "id"), s(t, "title")));
                    for sub in t["sub"].as_array().into_iter().flatten() {
                        o.push_str(&format!("\n    [{}] {} {}", if sub["done"] == true { "x" } else { " " }, s(sub, "id"), s(sub, "title")));
                    }
                }
                o.push_str(&format!("\nhash: {}", s(&v, "hash")));
                o
            });
        }
        Cmd::Stage(StageCmd::List { status, who, board, query }) => {
            let p = open(cli)?;
            let f = ops::StageFilter {
                status: status.as_deref().map(ops::parse_status).transpose()?,
                who: who.as_deref().map(ops::parse_who).transpose()?,
                board: board.clone(),
                query: query.clone(),
            };
            let v = ops::list_stages(&p, &f, 500, None)?;
            emit(cli, &v, || {
                v["stages"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|r| {
                        format!(
                            "{:<8} {:<8} {}/{}  {}",
                            s(r, "key"),
                            s(r, "status"),
                            r["progress"]["done"],
                            r["progress"]["total"],
                            s(r, "title")
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            });
        }
        Cmd::Task(TaskCmd::Add { key, title, direct }) => {
            let p = open(cli)?;
            let spec = spec_for_stage(key, |st| st.tasks = vec![title.clone()]);
            if p.load_stages()?.iter().all(|s| &s.key != key) {
                return Err(pathloom_core::Error::NotFound(format!("stage {key}")).into());
            }
            let mut v = ops::submit(&p, &spec, &cli.author, false, *direct)?;
            if s(&v, "mode") == "applied"
                && let Some(t) = p.load_stage(key)?.tasks.iter().rev().find(|t| &t.title == title)
            {
                v["task_id"] = json!(t.id);
            }
            emit(cli, &v, || {
                let id = s(&v, "task_id");
                if id.is_empty() { fmt_submit(&v) } else { format!("Added {id} {title}") }
            });
        }
        Cmd::Task(TaskCmd::Done { task_id }) | Cmd::Task(TaskCmd::Undo { task_id }) => {
            let done = matches!(cli.command, Cmd::Task(TaskCmd::Done { .. }));
            let v = ops::set_task(&open(cli)?, task_id, done)?;
            emit(cli, &v, || {
                let st = &v["stage"];
                format!(
                    "{task_id} {} · {} is {} ({}/{})",
                    if done { "done" } else { "reopened" },
                    s(st, "key"),
                    s(st, "status"),
                    st["progress"]["done"],
                    st["progress"]["total"]
                )
            });
        }
        Cmd::Link { from, to, soft, direct } => {
            let spec = ApplySpec { links: vec![pathloom_core::LinkSpec { from: from.clone(), to: to.clone(), soft: *soft }], ..Default::default() };
            let v = ops::submit(&open(cli)?, &spec, &cli.author, false, *direct)?;
            emit(cli, &v, || fmt_submit(&v));
        }
        Cmd::Unlink { from, to, direct } => {
            let spec = ApplySpec { unlinks: vec![pathloom_core::UnlinkSpec { from: from.clone(), to: to.clone() }], ..Default::default() };
            let v = ops::submit(&open(cli)?, &spec, &cli.author, false, *direct)?;
            emit(cli, &v, || fmt_submit(&v));
        }
        Cmd::Comment { key, text } => {
            let v = ops::add_comment(&open(cli)?, key, &cli.author, text)?;
            emit(cli, &v, || format!("Comment added to {key}"));
        }
        Cmd::Next { limit } => {
            let tasks = open(cli)?.next_tasks(*limit)?;
            let v = json!({"tasks": tasks});
            emit(cli, &v, || {
                if tasks.is_empty() {
                    return "Nothing to do right now.".into();
                }
                v["tasks"].as_array().into_iter().flatten().map(fmt_task).collect::<Vec<_>>().join("\n")
            });
        }
        Cmd::Apply { file, dry_run, direct } => {
            let p = open(cli)?;
            let spec = Project::parse_spec(&read_spec_text(file)?)?;
            let v = ops::submit(&p, &spec, &cli.author, *dry_run, *direct)?;
            emit(cli, &v, || fmt_submit(&v));
        }
        Cmd::Layout { board, only_new } => {
            let v = ops::layout(&open(cli)?, board, only_new)?;
            emit(cli, &v, || format!("Laid out {} cards on board {board}", v["cards"].as_array().map_or(0, Vec::len)));
        }
        Cmd::Validate { fix } => {
            let v = ops::validate(&open(cli)?, *fix)?;
            emit(cli, &v, || {
                let mut o: Vec<String> = list(&v, "fixed").into_iter().map(|f| format!("fixed: {f}")).collect();
                for i in v["issues"].as_array().into_iter().flatten() {
                    o.push(format!("{}: {} ({})", s(i, "code"), s(i, "message"), s(i, "path")));
                }
                if o.is_empty() { "OK: no problems found".into() } else { o.join("\n") }
            });
            if v["ok"] != true {
                return Ok(ExitCode::FAILURE);
            }
        }
        Cmd::Schema { what } => {
            println!("{}", serde_json::to_string_pretty(&schema::schema(*what)).unwrap_or_default());
        }
        Cmd::Proposals(c) => {
            let p = open(cli)?;
            match c {
                ProposalCmd::List => {
                    let list = p.list_proposals()?;
                    let v = json!({"proposals": list});
                    emit(cli, &v, || {
                        if list.is_empty() {
                            return "No pending proposals.".into();
                        }
                        list.iter()
                            .map(|x| {
                                format!(
                                    "{}  {}  {}  +{} ~{} stages",
                                    x.id,
                                    x.created_at,
                                    x.author,
                                    x.preview.created.len(),
                                    x.preview.updated.len()
                                )
                            })
                            .collect::<Vec<_>>()
                            .join("\n")
                    });
                }
                ProposalCmd::Accept { id } => {
                    let r = p.accept_proposal(id)?;
                    let v = json!({"mode": "applied", "report": r});
                    emit(cli, &v, || fmt_submit(&v));
                }
                ProposalCmd::Reject { id } => {
                    p.reject_proposal(id)?;
                    emit(cli, &json!({"rejected": id}), || format!("Rejected proposal {id}"));
                }
            }
        }
        Cmd::Mcp { read_only } => {
            let root = ops::locate_root(cli.project.as_deref())?;
            ops::open_project(&root)?;
            let author = (cli.author != "agent").then(|| cli.author.clone());
            mcp::run(root, *read_only, author).map_err(|e| ApiError::new("IO_ERROR", e))?;
        }
    }
    Ok(ExitCode::SUCCESS)
}
