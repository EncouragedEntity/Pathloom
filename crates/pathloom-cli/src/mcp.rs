//! MCP server (`pathloom mcp`): tools from spec §7.2 plus guide/schema resources. stdio transport.
//!
//! Kept thin: every tool calls `ops` (shared with the CLI). rmcp is pinned to an exact version
//! because its API changed between majors.

use crate::cli::SchemaKind;
use crate::ops::{self, ApiError, ApiResult, StageFilter};
use crate::schema::schema;
use pathloom_core::{Project, SessionRef};
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{
    CallToolResult, ContentBlock, Implementation, ListResourcesResult, PaginatedRequestParams,
    ReadResourceRequestParams, ReadResourceResponse, ReadResourceResult, Resource, ResourceContents,
    ServerCapabilities, ServerConfig,
};
use rmcp::service::RequestContext;
use rmcp::transport::stdio;
use rmcp::{ErrorData, RoleServer, ServerHandler, ServiceExt, tool, tool_handler, tool_router};
use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::PathBuf;

const GUIDE: &str = include_str!("guide.md");

#[derive(Debug, Deserialize, JsonSchema)]
struct ListStagesParams {
    /// Filter by computed status: done | active | ready | blocked
    status: Option<String>,
    /// Filter by assignee: me | ai | both | ai:<name> | human:<name>
    who: Option<String>,
    /// Only stages that have a card on this board
    board: Option<String>,
    /// Case-insensitive substring of key or title
    query: Option<String>,
    /// Page size (default 50, max 500)
    limit: Option<usize>,
    /// `next_cursor` of the previous page
    cursor: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct KeyParams {
    /// Stage key, e.g. M0
    key: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct NextParams {
    /// Max tasks (default 10)
    limit: Option<usize>,
    /// Agent name to plan for (default: you). Your claimed tasks come first; tasks claimed by others are hidden.
    agent: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ClaimParams {
    /// Task or subtask id, e.g. AUTH-02 or AUTH-02a
    task_id: String,
    /// How long the claim lasts, in minutes (default 30, max 480). Claim again to renew.
    ttl_minutes: Option<u64>,
    /// Short note about what you are doing
    note: Option<String>,
    /// External client session you act from (client, id, url?, title?). Logged with the action.
    session: Option<SessionRef>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ReleaseParams {
    /// Task or subtask id
    task_id: String,
    /// Release a claim held by another agent. Only when the user asked you to.
    force: Option<bool>,
    /// External client session you act from (client, id, url?, title?). Logged with the action.
    session: Option<SessionRef>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ActivityParams {
    /// Max entries (default 20, max 200)
    limit: Option<usize>,
    /// Only entries that touch this stage key
    stage: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct SearchParams {
    /// Case-insensitive text to find in keys, titles, descriptions and task titles
    query: String,
    /// Max results (default 20)
    limit: Option<usize>,
}

fn spec_schema(g: &mut SchemaGenerator) -> Schema {
    schemars::json_schema!({
        "description": "Apply spec as a JSON object, or YAML/JSON text. See pathloom://schema/spec and pathloom://guide/workflow.",
        "anyOf": [g.subschema_for::<pathloom_core::ApplySpec>(), {"type": "string"}]
    })
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ApplyParams {
    #[schemars(schema_with = "spec_schema")]
    spec: Value,
    /// Validate and report only; write nothing
    dry_run: Option<bool>,
    /// External client session you act from (client, id, url?, title?). Logged with the action.
    session: Option<SessionRef>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct SetTaskParams {
    /// Task id, e.g. AUTH-02 or AUTH-02a
    task_id: String,
    /// true = done, false = not done
    done: bool,
    /// Proof for done=true: the check you ran (command, exit_code 0, duration_ms?, summary?, log?).
    /// The task shows as verified. Required when the project has require_evidence on.
    evidence: Option<pathloom_core::Evidence>,
    /// External client session you act from (client, id, url?, title?). Logged with the action.
    session: Option<SessionRef>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct InitParams {
    /// Project name (default: folder name)
    name: Option<String>,
    /// Also write .agents/skills/pathloom/SKILL.md for other agents (Codex, Gemini CLI, Cursor)
    agents_skill: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct HeartbeatParams {
    /// Only this task (default: all your claims); claims it when you do not hold it yet
    task_id: Option<String>,
    /// What you are doing now, e.g. "running tests" (replaces the claim note)
    note: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct GateParams {
    /// Gate stage key (kind: gate)
    key: String,
    /// Result of running the gate's `check` command: command, exit_code, duration_ms?, summary?, log?
    evidence: pathloom_core::Evidence,
    session: Option<SessionRef>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct UsageParams {
    tokens_in: u64,
    tokens_out: u64,
    /// US dollars, if known
    cost_usd: Option<f64>,
    /// Stage the work was for
    stage: Option<String>,
    /// Short note, e.g. "planning session"
    note: Option<String>,
    session: Option<SessionRef>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ImportParams {
    /// Format of `text`: spec-kit (GitHub Spec Kit tasks.md)
    format: String,
    /// File contents
    text: String,
    /// Stage key prefix, 1-5 letters (default: initials of the feature name)
    prefix: Option<String>,
    /// Board for new cards (default roadmap)
    board: Option<String>,
    /// Report only; write nothing
    dry_run: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct CommentParams {
    /// Stage key
    stage: String,
    /// One-line comment text
    text: String,
    /// External client session you act from (client, id, url?, title?). Logged with the action.
    session: Option<SessionRef>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct LayoutParams {
    /// Board name (default roadmap)
    board: Option<String>,
    /// Move only the cards of these stage keys; omit to lay out every card
    only_new: Option<Vec<String>>,
    /// External client session you act from (client, id, url?, title?). Logged with the action.
    session: Option<SessionRef>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct RegisterParams {
    /// Display name, up to 40 characters
    name: Option<String>,
    /// #rgb or #rrggbb
    color: Option<String>,
    /// One emoji (up to 2 characters) or assets/<file>.png|jpg|webp|svg
    avatar: Option<String>,
    /// Free label: agent (default), orchestrator, reviewer, ...
    kind: Option<String>,
}

#[derive(Clone)]
pub struct PathloomServer {
    root: PathBuf,
    read_only: bool,
    author: Option<String>,
}

fn finish(r: ApiResult<Value>) -> CallToolResult {
    match r {
        Ok(v) => CallToolResult::success(vec![ContentBlock::text(v.to_string())]),
        Err(e) => CallToolResult::error(vec![ContentBlock::text(e.to_json().to_string())]),
    }
}

impl PathloomServer {
    fn project(&self) -> ApiResult<Project> {
        ops::open_project(&self.root).map_err(|mut e| {
            if e.code == "NOT_FOUND" {
                e.message = format!("{} in {}: call init_project to create one here", e.message, self.root.display());
            }
            e
        })
    }

    fn guard(&self) -> ApiResult<()> {
        if self.read_only { Err(ApiError::read_only()) } else { Ok(()) }
    }

    /// Placeholder actor for read-only tools (never logs).
    fn actor_anon(&self) -> ops::Actor {
        ops::Actor::new("agent", "mcp")
    }

    /// Identity for claims and the log: normalized client name (or `--author`), with the optional session.
    fn actor(&self, ctx: &RequestContext<RoleServer>, session: Option<SessionRef>) -> ApiResult<ops::Actor> {
        ops::Actor::new(&self.author(ctx), "mcp").with_session(session)
    }

    fn author(&self, ctx: &RequestContext<RoleServer>) -> String {
        if let Some(a) = &self.author {
            return a.clone();
        }
        match ctx.peer.peer_info() {
            Some(info) if !info.client_info.name.trim().is_empty() => format!("agent:{}", info.client_info.name.trim()),
            _ => "agent".into(),
        }
    }
}

#[tool_router]
impl PathloomServer {
    #[tool(
        description = "Create a Pathloom project (.pathloom/ and plan/) in the folder this server runs in. Only when project_info says there is none and the user wants a plan here."
    )]
    async fn init_project(&self, Parameters(a): Parameters<InitParams>) -> CallToolResult {
        finish((|| {
            self.guard()?;
            let name = a.name.filter(|n| !n.trim().is_empty()).unwrap_or_else(|| {
                self.root.file_name().map_or_else(|| "project".into(), |n| n.to_string_lossy().into_owned())
            });
            let p = Project::init(&self.root, name.trim())?;
            let mut v = json!({"name": name.trim(), "root": p.root.to_string_lossy(), "plan_dir": p.config.plan_dir});
            if a.agents_skill.unwrap_or(false) {
                let path = ops::install_skill(&p.root, std::path::Path::new(".agents/skills"), false)?;
                v["skill"] = json!(path.to_string_lossy());
            }
            Ok(v)
        })())
    }

    #[tool(
        description = "Project summary: boards, stage counts per status, top 5 next tasks, review mode. Call this first.",
        annotations(read_only_hint = true)
    )]
    async fn project_info(&self) -> CallToolResult {
        finish(self.project().and_then(|p| ops::project_info(&p, self.read_only)))
    }

    #[tool(
        description = "List stages (key, title, status, progress, who, priority, due). Filters: status, who, board, query. Paginated.",
        annotations(read_only_hint = true)
    )]
    async fn list_stages(&self, Parameters(a): Parameters<ListStagesParams>) -> CallToolResult {
        finish((|| {
            let f = StageFilter {
                status: a.status.as_deref().map(ops::parse_status).transpose()?,
                who: a.who.as_deref().map(ops::parse_who).transpose()?,
                board: a.board,
                query: a.query,
            };
            ops::list_stages(&self.project()?, &f, a.limit.unwrap_or(0), a.cursor.as_deref())
        })())
    }

    #[tool(
        description = "One stage in full (tasks, comments, depends, status, live `claims`) plus `hash`. Pass the hash in apply.expected to detect concurrent edits.",
        annotations(read_only_hint = true)
    )]
    async fn get_stage(&self, Parameters(a): Parameters<KeyParams>) -> CallToolResult {
        finish(self.project().and_then(|p| ops::get_stage(&p, &a.key)))
    }

    #[tool(
        description = "Open tasks you can work on now (stages that are ready or active), sorted by priority, due date, file order. Tasks you claimed come first (`claimed_by`); tasks claimed by other agents are hidden.",
        annotations(read_only_hint = true)
    )]
    async fn next(&self, Parameters(a): Parameters<NextParams>, ctx: RequestContext<RoleServer>) -> CallToolResult {
        finish((|| {
            let agent = match a.agent.as_deref() {
                Some(x) => ops::normalize_agent(x),
                None => self.actor(&ctx, None)?.name,
            };
            let tasks = self.project()?.next_tasks_for(a.limit.unwrap_or(10), Some(&agent))?;
            Ok(ops::next_result(json!(tasks)))
        })())
    }

    #[tool(
        description = "Call this when you START a task, before doing the work: the claim is how the user sees on the board what you are working on right now (your name on the card), and other agents skip the task. Same agent claiming again renews. Fails with CLAIMED (details: task_id, by, expires_at) when someone else holds it. Marking the task done releases the claim.",
        annotations(idempotent_hint = true)
    )]
    async fn claim_task(&self, Parameters(a): Parameters<ClaimParams>, ctx: RequestContext<RoleServer>) -> CallToolResult {
        finish((|| {
            self.guard()?;
            let secs = a.ttl_minutes.unwrap_or(0).saturating_mul(60);
            ops::claim_task(&self.project()?, &self.actor(&ctx, a.session)?, &a.task_id, secs, a.note.as_deref().unwrap_or(""))
        })())
    }

    #[tool(description = "Release your claim on a task without finishing it. force=true takes over another agent's claim: only when the user asks.")]
    async fn release_task(&self, Parameters(a): Parameters<ReleaseParams>, ctx: RequestContext<RoleServer>) -> CallToolResult {
        finish((|| {
            self.guard()?;
            ops::release_task(&self.project()?, &self.actor(&ctx, a.session)?, &a.task_id, a.force.unwrap_or(false))
        })())
    }

    #[tool(
        description = "Recent actions of agents and humans on this plan (who did what, newest first). Check it to see what others changed. Optional stage filter.",
        annotations(read_only_hint = true)
    )]
    async fn activity(&self, Parameters(a): Parameters<ActivityParams>) -> CallToolResult {
        finish(self.project().and_then(|p| ops::activity(&p, a.limit.unwrap_or(0), a.stage.as_deref())))
    }

    #[tool(
        description = "Case-insensitive text search over stage keys/titles/descriptions and task titles.",
        annotations(read_only_hint = true)
    )]
    async fn search(&self, Parameters(a): Parameters<SearchParams>) -> CallToolResult {
        finish(self.project().and_then(|p| ops::search(&p, &a.query, a.limit.unwrap_or(0))))
    }

    #[tool(
        description = "Batch create/update stages, tasks, links, frames, comments from a spec. All or nothing. Use dry_run first. In review mode it creates a proposal instead of writing."
    )]
    async fn apply(&self, Parameters(a): Parameters<ApplyParams>, ctx: RequestContext<RoleServer>) -> CallToolResult {
        finish((|| {
            let dry = a.dry_run.unwrap_or(false);
            if !dry {
                self.guard()?;
            }
            let spec = ops::parse_spec_value(&a.spec)?;
            let p = self.project()?;
            let done: Vec<String> = spec.stages.iter().flat_map(|s| s.tasks_done.iter().cloned()).collect();
            ops::require_no_evidence_policy(&p, &done)?;
            let v = ops::submit(&p, &spec, &self.author(&ctx), dry, false)?;
            Ok(ops::log_submit(&p, &self.actor(&ctx, a.session)?, "apply", &spec, v))
        })())
    }

    #[tool(
        description = "Mark a task or subtask done (true) or not done (false); claim_task it first when you start the work. Attach `evidence` (the check you ran, exit_code 0) so the task shows as verified. Returns the stage's new status."
    )]
    async fn set_task(&self, Parameters(a): Parameters<SetTaskParams>, ctx: RequestContext<RoleServer>) -> CallToolResult {
        finish((|| {
            self.guard()?;
            ops::set_task(&self.project()?, &self.actor(&ctx, a.session)?, "set_task", &a.task_id, a.done, a.evidence, true)
        })())
    }

    #[tool(
        description = "Still working: refresh your claims so the app does not show you as silent (after 10 min without any action) and they do not expire. Call every few minutes during long steps; `note` tells the user what you are doing. With a task_id you have not claimed yet it claims that task.",
        annotations(idempotent_hint = true)
    )]
    async fn heartbeat(&self, Parameters(a): Parameters<HeartbeatParams>, ctx: RequestContext<RoleServer>) -> CallToolResult {
        finish((|| {
            self.guard()?;
            ops::heartbeat(&self.project()?, &self.actor(&ctx, None)?, a.task_id.as_deref(), a.note.as_deref())
        })())
    }

    #[tool(
        description = "Import another tool's task list as stages with tasks and dependencies. format=spec-kit takes a GitHub Spec Kit tasks.md (phases become stages). Re-import updates the same stages. Use dry_run first."
    )]
    async fn import_tasks(&self, Parameters(a): Parameters<ImportParams>, ctx: RequestContext<RoleServer>) -> CallToolResult {
        finish((|| {
            let dry = a.dry_run.unwrap_or(false);
            if !dry {
                self.guard()?;
            }
            if a.format != "spec-kit" {
                return Err(ApiError::new("INVALID_SPEC", format!("unknown format `{}` (supported: spec-kit)", a.format)));
            }
            ops::import(&self.project()?, &self.actor(&ctx, None)?, &a.text, a.prefix.as_deref(), a.board.as_deref(), dry, false)
        })())
    }

    #[tool(
        description = "Record the result of a gate stage's check (kind: gate, its `check` command, e.g. npm test). Run the command yourself first. exit_code 0 makes the gate done; non-zero reopens it."
    )]
    async fn set_gate(&self, Parameters(a): Parameters<GateParams>, ctx: RequestContext<RoleServer>) -> CallToolResult {
        finish((|| {
            self.guard()?;
            ops::set_gate(&self.project()?, &self.actor(&ctx, a.session)?, &a.key, a.evidence)
        })())
    }

    #[tool(
        description = "Optional: report tokens/cost of your work (for a stage) so the user sees spending per stage and agent. Pathloom only stores what you report."
    )]
    async fn report_usage(&self, Parameters(a): Parameters<UsageParams>, ctx: RequestContext<RoleServer>) -> CallToolResult {
        finish((|| {
            self.guard()?;
            let u = pathloom_core::Usage { tokens_in: a.tokens_in, tokens_out: a.tokens_out, cost_usd: a.cost_usd };
            ops::report_usage(&self.project()?, &self.actor(&ctx, a.session)?, u, a.stage.as_deref(), a.note.as_deref().unwrap_or(""))
        })())
    }

    #[tool(description = "Add a one-line comment to a stage, authored as the connected agent.")]
    async fn add_comment(&self, Parameters(a): Parameters<CommentParams>, ctx: RequestContext<RoleServer>) -> CallToolResult {
        finish((|| {
            self.guard()?;
            ops::add_comment(&self.project()?, &self.actor(&ctx, a.session)?, &a.stage, &self.author(&ctx), &a.text)
        })())
    }

    #[tool(description = "Auto-layout cards on a board, left to right by dependencies. only_new limits which cards move.")]
    async fn layout_board(&self, Parameters(a): Parameters<LayoutParams>, ctx: RequestContext<RoleServer>) -> CallToolResult {
        finish((|| {
            self.guard()?;
            ops::layout(&self.project()?, &self.actor(&ctx, a.session)?, a.board.as_deref().unwrap_or("roadmap"), &a.only_new.unwrap_or_default())
        })())
    }

    #[tool(
        description = "Register or update your own display profile (name, color, avatar, kind) shown in the app and in logs. Your id is your caller identity. Call once at session start."
    )]
    async fn register_agent(&self, Parameters(a): Parameters<RegisterParams>, ctx: RequestContext<RoleServer>) -> CallToolResult {
        finish((|| {
            self.guard()?;
            let actor = self.actor(&ctx, None)?;
            let patch = ops::ProfilePatch { name: a.name, color: a.color, avatar: a.avatar, kind: a.kind };
            ops::set_agent(&self.project()?, &actor, "register_agent", &actor.name, patch)
        })())
    }

    #[tool(description = "All agent profiles (id, name, color, avatar, kind).", annotations(read_only_hint = true))]
    async fn list_agents(&self) -> CallToolResult {
        finish(self.project().and_then(|p| ops::list_agents(&p)))
    }

    #[tool(
        description = "Check project integrity: broken depends, cycles, bad task ids, cards of missing stages. `hints` lists readability fixes (redundant links, oversized stages, missing descriptions): apply them.",
        annotations(read_only_hint = true)
    )]
    async fn validate(&self) -> CallToolResult {
        finish(self.project().and_then(|p| ops::validate(&p, &self.actor_anon(), false)))
    }
}

fn resources() -> Vec<(&'static str, &'static str, &'static str, String)> {
    let js = |k| serde_json::to_string_pretty(&schema(k)).unwrap_or_default();
    vec![
        ("pathloom://guide/workflow", "Workflow guide", "text/markdown", GUIDE.to_string()),
        ("pathloom://schema/stage", "Stage JSON Schema", "application/json", js(SchemaKind::Stage)),
        ("pathloom://schema/board", "Board JSON Schema", "application/json", js(SchemaKind::Board)),
        ("pathloom://schema/spec", "Apply spec JSON Schema", "application/json", js(SchemaKind::Spec)),
    ]
}

#[tool_handler]
impl ServerHandler for PathloomServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().enable_resources().build())
            .with_server_info(Implementation::new("pathloom", env!("CARGO_PKG_VERSION")))
            .with_instructions(
                "Pathloom project plan. Start with project_info, then next. When you start a task, call claim_task first: the user watches the board and sees what you are doing only through your claim. set_task done releases it. Read pathloom://guide/workflow for the rules."
                    .to_string(),
            )
    }

    async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, ErrorData> {
        let items = resources()
            .into_iter()
            .map(|(uri, name, mime, _)| Resource::new(uri, name).with_mime_type(mime))
            .collect();
        Ok(ListResourcesResult::with_all_items(items))
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, ErrorData> {
        let Some((uri, _, mime, text)) = resources().into_iter().find(|r| r.0 == request.uri) else {
            return Err(ErrorData::resource_not_found(format!("unknown resource {}", request.uri), None));
        };
        let contents = ResourceContents::TextResourceContents {
            uri: uri.to_string(),
            mime_type: Some(mime.to_string()),
            text,
            meta: None,
        };
        Ok(ReadResourceResult::new(vec![contents]).into())
    }
}

/// Serve MCP on stdio until the client disconnects. Nothing else may write to stdout.
pub fn run(root: PathBuf, read_only: bool, author: Option<String>) -> Result<(), String> {
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().map_err(|e| e.to_string())?;
    rt.block_on(async {
        let server = PathloomServer { root, read_only, author };
        let service = server.serve(stdio()).await.map_err(|e| e.to_string())?;
        service.waiting().await.map_err(|e| e.to_string())?;
        Ok(())
    })
}
