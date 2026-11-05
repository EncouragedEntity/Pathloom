//! `pathloom`: CLI and MCP server for Pathloom projects.

mod cli;
mod mcp;
mod ops;
mod schema;

use clap::Parser;
use cli::{AgentCmd, BoardCmd, Cli, Cmd, GateCmd, ProposalCmd, SkillCmd, StageCmd, TaskCmd};
use ops::{ApiError, ApiResult};
use pathloom_core::events::{Event, EventWatcher};
use pathloom_core::{ApplySpec, DepSpec, Place, Project, SessionRef, StageSpec};
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

/// Run `cmd` through the system shell with inherited output and record it as evidence.
fn run_check(cmd: &str, summary: &Option<String>, log: &Option<String>) -> ApiResult<pathloom_core::Evidence> {
    let mut c = if cfg!(windows) {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", cmd]);
        c
    } else {
        let mut c = std::process::Command::new("sh");
        c.args(["-c", cmd]);
        c
    };
    let start = std::time::Instant::now();
    let status = c.status().map_err(|e| ApiError::new("IO_ERROR", format!("cannot run `{cmd}`: {e}")))?;
    Ok(pathloom_core::Evidence {
        command: cmd.into(),
        // No code = killed by a signal: count as failure.
        exit_code: status.code().unwrap_or(-1),
        duration_ms: Some(u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX)),
        summary: summary.clone(),
        log: log.clone(),
        at: String::new(),
        by: String::new(),
    })
}

fn open(cli: &Cli) -> ApiResult<Project> {
    ops::open_project(&ops::locate_root(cli.project.as_deref())?)
}

/// Print `json` (with --json) or the human text. A failed activity-log write is a warning on stderr.
fn emit(cli: &Cli, json: &Value, human: impl FnOnce() -> String) {
    if let Some(w) = json["log_warning"].as_str() {
        eprintln!("warning: {w}");
    }
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
    if let Some(by) = t["claimed_by"].as_str() {
        meta.push(format!("claimed by {by}"));
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
    let actor = ops::Actor::new(&cli.author, "cli");
    match &cli.command {
        Cmd::Init { plan_dir, name, agents_skill } => {
            let root = match &cli.project {
                Some(p) => std::path::absolute(p),
                None => std::env::current_dir(),
            }
            .map_err(|e| ApiError::new("IO_ERROR", e.to_string()))?;
            let name = name.clone().unwrap_or_else(|| {
                root.file_name().map_or_else(|| "project".into(), |n| n.to_string_lossy().into_owned())
            });
            let p = Project::init_with(&root, &name, plan_dir)?;
            let mut j = json!({"name": name, "root": p.root.to_string_lossy(), "plan_dir": plan_dir});
            if *agents_skill {
                let path = ops::install_skill(&p.root, std::path::Path::new(".agents/skills"), false)?;
                j["skill"] = json!(path.to_string_lossy());
            }
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
            let v = ops::log_submit(&p, &actor, "stage add", &spec, v);
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
            v = ops::log_submit(&p, &actor, "task add", &spec, v);
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
        Cmd::Task(TaskCmd::Done { task_id, .. }) | Cmd::Task(TaskCmd::Undo { task_id }) => {
            let done = matches!(cli.command, Cmd::Task(TaskCmd::Done { .. }));
            let p = open(cli)?;
            let evidence = match &cli.command {
                Cmd::Task(TaskCmd::Done { run: Some(cmd), summary, log, .. }) => Some(run_check(cmd, summary, log)?),
                _ => None,
            };
            if let Some(e) = evidence.as_ref().filter(|e| !e.passed()) {
                return Err(ApiError::new(
                    "CHECK_FAILED",
                    format!("`{}` exited with {}: {task_id} stays open", e.command, e.exit_code),
                ));
            }
            let verified = evidence.is_some();
            let v = ops::set_task(&p, &actor, if done { "task done" } else { "task undo" }, task_id, done, evidence, false)?;
            emit(cli, &v, || {
                let st = &v["stage"];
                format!(
                    "{task_id} {} · {} is {} ({}/{})",
                    match (done, verified) {
                        (true, true) => "done (verified)",
                        (true, false) => "done",
                        _ => "reopened",
                    },
                    s(st, "key"),
                    s(st, "status"),
                    st["progress"]["done"],
                    st["progress"]["total"]
                )
            });
        }
        Cmd::Task(TaskCmd::Claim { task_id, ttl, note, session_client, session_id, session_url, session_title }) => {
            let session = session_client.as_ref().zip(session_id.as_ref()).map(|(c, i)| SessionRef {
                client: c.clone(),
                id: i.clone(),
                url: session_url.clone(),
                title: session_title.clone(),
            });
            let actor = actor.clone().with_session(session)?;
            let v = ops::claim_task(&open(cli)?, &actor, task_id, ops::parse_ttl(ttl)?, note)?;
            emit(cli, &v, || format!("Claimed {task_id} for {} until {}", actor.name, s(&v, "expires_at")));
        }
        Cmd::Task(TaskCmd::Heartbeat { task_id, note }) => {
            let v = ops::heartbeat(&open(cli)?, &actor, task_id.as_deref(), note.as_deref())?;
            emit(cli, &v, || {
                let n = v["claims"].as_array().map_or(0, Vec::len);
                if n == 0 { "No claims to refresh.".into() } else { format!("Refreshed {n} claim(s) of {}", actor.name) }
            });
        }
        Cmd::Gate(GateCmd::Run { key }) => {
            let p = open(cli)?;
            let st = p.load_stage(key)?;
            let check = st.check.clone().ok_or_else(|| ApiError::new("INVALID_SPEC", format!("{key} has no `check` command")))?;
            let ev = run_check(&check, &None, &None)?;
            let v = ops::set_gate(&p, &actor, key, ev)?;
            emit(cli, &v, || {
                if v["passed"] == true { format!("Gate {key} passed") } else { format!("Gate {key} FAILED: `{check}`") }
            });
            if v["passed"] != true {
                return Ok(ExitCode::FAILURE);
            }
        }
        Cmd::Usage { tokens_in, tokens_out, cost, stage, note } => {
            let p = open(cli)?;
            let v = if tokens_in.is_some() || tokens_out.is_some() || cost.is_some() {
                let u = pathloom_core::Usage { tokens_in: tokens_in.unwrap_or(0), tokens_out: tokens_out.unwrap_or(0), cost_usd: *cost };
                ops::report_usage(&p, &actor, u, stage.as_deref(), note)?
            } else {
                ops::usage_summary(&p)?
            };
            emit(cli, &v, || {
                if v["recorded"] == true {
                    return "Usage recorded.".into();
                }
                let row = |name: &str, u: &Value| {
                    let cost = u["cost_usd"].as_f64().map_or(String::new(), |c| format!("  ${c:.2}"));
                    format!("{name:<16} {:>10} in {:>10} out{cost}", u["tokens_in"], u["tokens_out"])
                };
                let mut out = vec![row("total", &v["total"])];
                for (title, k) in [("by agent:", "by_agent"), ("by stage:", "by_stage")] {
                    if let Some(m) = v[k].as_object().filter(|m| !m.is_empty()) {
                        out.push(title.into());
                        out.extend(m.iter().map(|(n, u)| row(&format!("  {n}"), u)));
                    }
                }
                out.join("\n")
            });
        }
        Cmd::Import { format: _, file, prefix, board, dry_run, direct } => {
            let p = open(cli)?;
            let v = ops::import(&p, &actor, &read_spec_text(file)?, prefix.as_deref(), board.as_deref(), *dry_run, *direct)?;
            emit(cli, &v, || {
                let i = &v["import"];
                format!(
                    "Spec Kit \"{}\": {} stage(s) {}, {} task(s)\n{}",
                    s(i, "feature"),
                    list(i, "stages").len(),
                    list(i, "stages").join(", "),
                    i["tasks"],
                    fmt_submit(&v)
                )
            });
        }
        Cmd::Task(TaskCmd::Release { task_id, force }) => {
            let v = ops::release_task(&open(cli)?, &actor, task_id, *force)?;
            emit(cli, &v, || format!("Released {task_id}"));
        }
        Cmd::Claims => {
            let v = ops::claims(&open(cli)?)?;
            emit(cli, &v, || {
                let rows: Vec<String> = v["claims"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|c| {
                        let silent = if c["silent"] == true { format!("  [silent since {}]", s(c, "heartbeat_at")) } else { String::new() };
                        format!("{:<9} {:<16} until {}  {}{silent}", s(c, "task_id"), s(c, "agent"), s(c, "expires_at"), s(c, "note"))
                    })
                    .collect();
                if rows.is_empty() { "No active claims.".into() } else { rows.join("\n") }
            });
        }
        Cmd::Log { limit, stage } => {
            let v = ops::activity(&open(cli)?, *limit, stage.as_deref())?;
            emit(cli, &v, || {
                let rows: Vec<String> = v["entries"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|e| format!("{}  {:<14} {:<4} {:<14} {}", s(e, "at"), s(e, "author"), s(e, "source"), s(e, "action"), s(e, "summary")))
                    .collect();
                if rows.is_empty() { "No activity yet.".into() } else { rows.join("\n") }
            });
        }
        Cmd::Link { from, to, soft, direct } => {
            let spec = ApplySpec { links: vec![pathloom_core::LinkSpec { from: from.clone(), to: to.clone(), soft: *soft }], ..Default::default() };
            let p = open(cli)?;
            let v = ops::submit(&p, &spec, &cli.author, false, *direct)?;
            let v = ops::log_submit(&p, &actor, "link", &spec, v);
            emit(cli, &v, || fmt_submit(&v));
        }
        Cmd::Unlink { from, to, direct } => {
            let spec = ApplySpec { unlinks: vec![pathloom_core::UnlinkSpec { from: from.clone(), to: to.clone() }], ..Default::default() };
            let p = open(cli)?;
            let v = ops::submit(&p, &spec, &cli.author, false, *direct)?;
            let v = ops::log_submit(&p, &actor, "unlink", &spec, v);
            emit(cli, &v, || fmt_submit(&v));
        }
        Cmd::Comment { key, text } => {
            let v = ops::add_comment(&open(cli)?, &actor, key, &cli.author, text)?;
            emit(cli, &v, || format!("Comment added to {key}"));
        }
        Cmd::Next { limit } => {
            let tasks = open(cli)?.next_tasks_for(*limit, Some(&actor.name))?;
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
            let v = ops::log_submit(&p, &actor, "apply", &spec, v);
            emit(cli, &v, || fmt_submit(&v));
        }
        Cmd::Layout { board, only_new } => {
            let v = ops::layout(&open(cli)?, &actor, board, only_new)?;
            emit(cli, &v, || format!("Laid out {} cards on board {board}", v["cards"].as_array().map_or(0, Vec::len)));
        }
        Cmd::Validate { fix } => {
            let v = ops::validate(&open(cli)?, &actor, *fix)?;
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
                    let stages: Vec<String> = r.created.iter().chain(&r.updated).cloned().collect();
                    let e = ops::entry("proposals accept", format!("accepted proposal {id}"), stages, vec![], r.files.clone());
                    let v = ops::log(&p, &actor, e, json!({"mode": "applied", "report": r}));
                    emit(cli, &v, || fmt_submit(&v));
                }
                ProposalCmd::Reject { id } => {
                    p.reject_proposal(id)?;
                    let e = ops::entry("proposals reject", format!("rejected proposal {id}"), vec![], vec![], vec![]);
                    let v = ops::log(&p, &actor, e, json!({"rejected": id}));
                    emit(cli, &v, || format!("Rejected proposal {id}"));
                }
            }
        }
        Cmd::Info => {
            let v = ops::project_info(&open(cli)?, false)?;
            emit(cli, &v, || {
                let counts = &v["stages"];
                format!(
                    "{} ({})\nprotocol: {} · pathloom {}\ncapabilities: {}\nagent_changes: {}\nstages: {} total · {} done · {} active · {} ready · {} blocked\nagents: {}",
                    s(&v, "name"),
                    s(&v, "root"),
                    s(&v, "protocol"),
                    s(&v, "version"),
                    list(&v, "capabilities").join(", "),
                    s(&v, "agent_changes"),
                    counts["total"],
                    counts["done"],
                    counts["active"],
                    counts["ready"],
                    counts["blocked"],
                    v["agents"].as_array().map_or(0, Vec::len),
                )
            });
        }
        Cmd::Agent(AgentCmd::Set { id, name, color, avatar, kind }) => {
            let patch = ops::ProfilePatch { name: name.clone(), color: color.clone(), avatar: avatar.clone(), kind: kind.clone() };
            let v = ops::set_agent(&open(cli)?, &actor, "agent set", id, patch)?;
            emit(cli, &v, || format!("Saved profile {id}"));
        }
        Cmd::Agent(AgentCmd::List) => {
            let v = ops::list_agents(&open(cli)?)?;
            emit(cli, &v, || {
                let rows: Vec<String> = v["agents"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|a| format!("{:<16} {:<20} {:<8} {:<4} {}", s(a, "id"), s(a, "name"), s(a, "color"), s(a, "avatar"), s(a, "kind")))
                    .collect();
                if rows.is_empty() { "No agent profiles.".into() } else { rows.join("\n") }
            });
        }
        Cmd::Agent(AgentCmd::Remove { id }) => {
            let v = ops::remove_agent(&open(cli)?, &actor, id)?;
            emit(cli, &v, || format!("Removed profile {id}"));
        }
        Cmd::Watch { since } => {
            let p = open(cli)?;
            let since = since.as_deref().map(ops::parse_since).transpose()?;
            watch(&p, cli.json, since.as_deref())?;
        }
        Cmd::Skill(SkillCmd::Install { dir, force }) => {
            let root = ops::locate_root(cli.project.as_deref())?;
            let path = ops::install_skill(&root, dir, *force)?;
            emit(cli, &json!({"path": path.to_string_lossy()}), || format!("Wrote {}", path.display()));
        }
        Cmd::Mcp { read_only } => {
            // Start even without a project (e.g. a user-wide MCP config in a fresh folder): tools report
            // NOT_FOUND until `init_project` creates one in this folder.
            let root = match ops::locate_root(cli.project.as_deref()) {
                Ok(r) => r,
                Err(_) => match cli.project.as_deref() {
                    Some(p) => std::path::absolute(p),
                    None => std::env::current_dir(),
                }
                .map_err(|e| ApiError::new("IO_ERROR", e.to_string()))?,
            };
            if root.join(".pathloom/project.toml").is_file() {
                ops::open_project(&root)?;
            }
            let author = (cli.author != "agent").then(|| cli.author.clone());
            mcp::run(root, *read_only, author).map_err(|e| ApiError::new("IO_ERROR", e))?;
        }
    }
    Ok(ExitCode::SUCCESS)
}

/// Print one event (JSON line or human text) and flush; `false` when stdout is gone.
fn print_event(e: &Event, json: bool) -> bool {
    use std::io::Write;
    let mut out = std::io::stdout().lock();
    let line = if json { e.to_json_line() } else { e.to_string() };
    writeln!(out, "{line}").and_then(|()| out.flush()).is_ok()
}

/// `pathloom watch`: `hello`, the log backlog since `since`, then live events until killed.
fn watch(p: &Project, json: bool, since: Option<&str>) -> ApiResult<()> {
    // Start first so nothing that happens while we print the backlog is lost.
    let w = EventWatcher::start(p)?;
    if !print_event(&Event::hello(), json) {
        return Ok(());
    }
    if let Some(since) = since {
        for entry in ops::entries_since(p, since)? {
            if !print_event(&Event::Activity { entry }, json) {
                return Ok(());
            }
        }
    }
    loop {
        if let Some(e) = w.recv_timeout(std::time::Duration::from_secs(1))
            && !print_event(&e, json)
        {
            return Ok(());
        }
    }
}
