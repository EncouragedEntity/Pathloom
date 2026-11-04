//! MCP server (`pathloom mcp`): tools from spec §7.2 plus guide/schema resources. stdio transport.
//!
//! Kept thin: every tool calls `ops` (shared with the CLI). rmcp is pinned to an exact version
//! because its API changed between majors.

use crate::cli::SchemaKind;
use crate::ops::{self, ApiError, ApiResult, StageFilter};
use crate::schema::schema;
use pathloom_core::Project;
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
    /// Filter by assignee: me | ai | both
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
}

#[derive(Debug, Deserialize, JsonSchema)]
struct SetTaskParams {
    /// Task id, e.g. AUTH-02 or AUTH-02a
    task_id: String,
    /// true = done, false = not done
    done: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct CommentParams {
    /// Stage key
    stage: String,
    /// One-line comment text
    text: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct LayoutParams {
    /// Board name (default roadmap)
    board: Option<String>,
    /// Move only the cards of these stage keys; omit to lay out every card
    only_new: Option<Vec<String>>,
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
        ops::open_project(&self.root)
    }

    fn guard(&self) -> ApiResult<()> {
        if self.read_only { Err(ApiError::read_only()) } else { Ok(()) }
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
        description = "One stage in full (tasks, comments, depends, status) plus `hash`. Pass the hash in apply.expected to detect concurrent edits.",
        annotations(read_only_hint = true)
    )]
    async fn get_stage(&self, Parameters(a): Parameters<KeyParams>) -> CallToolResult {
        finish(self.project().and_then(|p| ops::get_stage(&p, &a.key)))
    }

    #[tool(
        description = "Open tasks you can work on now (stages that are ready or active), sorted by priority, due date, file order.",
        annotations(read_only_hint = true)
    )]
    async fn next(&self, Parameters(a): Parameters<NextParams>) -> CallToolResult {
        finish((|| {
            let tasks = self.project()?.next_tasks(a.limit.unwrap_or(10))?;
            Ok(json!({"tasks": tasks}))
        })())
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
            ops::submit(&self.project()?, &spec, &self.author(&ctx), dry, false)
        })())
    }

    #[tool(description = "Mark a task or subtask done (true) or not done (false). Returns the stage's new status.")]
    async fn set_task(&self, Parameters(a): Parameters<SetTaskParams>) -> CallToolResult {
        finish((|| {
            self.guard()?;
            ops::set_task(&self.project()?, &a.task_id, a.done)
        })())
    }

    #[tool(description = "Add a one-line comment to a stage, authored as the connected agent.")]
    async fn add_comment(&self, Parameters(a): Parameters<CommentParams>, ctx: RequestContext<RoleServer>) -> CallToolResult {
        finish((|| {
            self.guard()?;
            ops::add_comment(&self.project()?, &a.stage, &self.author(&ctx), &a.text)
        })())
    }

    #[tool(description = "Auto-layout cards on a board, left to right by dependencies. only_new limits which cards move.")]
    async fn layout_board(&self, Parameters(a): Parameters<LayoutParams>) -> CallToolResult {
        finish((|| {
            self.guard()?;
            ops::layout(&self.project()?, a.board.as_deref().unwrap_or("roadmap"), &a.only_new.unwrap_or_default())
        })())
    }

    #[tool(
        description = "Check project integrity: broken depends, cycles, bad task ids, cards of missing stages.",
        annotations(read_only_hint = true)
    )]
    async fn validate(&self) -> CallToolResult {
        finish(self.project().and_then(|p| ops::validate(&p, false)))
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
                "Pathloom project plan. Start with project_info, then next. Read pathloom://guide/workflow for the rules."
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
