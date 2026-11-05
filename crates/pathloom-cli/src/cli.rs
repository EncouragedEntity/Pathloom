//! clap definitions (spec §7.1).

use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(name = "pathloom", version, about = "Pathloom: plan files, roadmap and MCP server for AI agents")]
pub struct Cli {
    /// Project root (default: search `.pathloom/` upwards from the current dir)
    #[arg(long, global = true, value_name = "PATH")]
    pub project: Option<PathBuf>,
    /// Machine-readable JSON output (errors as JSON on stderr)
    #[arg(long, global = true)]
    pub json: bool,
    /// Author recorded on comments, claims and the activity log (`agent:` prefix is ignored)
    #[arg(long, global = true, default_value = "agent")]
    pub author: String,
    #[command(subcommand)]
    pub command: Cmd,
}

#[derive(Subcommand, Debug)]
pub enum Cmd {
    /// Create a Pathloom project in the project dir (or current dir)
    Init {
        #[arg(long, default_value = "plan")]
        plan_dir: String,
        /// Project name (default: folder name)
        #[arg(long)]
        name: Option<String>,
        /// Also write .agents/skills/pathloom/SKILL.md (Agent Skills format)
        #[arg(long)]
        agents_skill: bool,
    },
    /// Manage boards
    #[command(subcommand)]
    Board(BoardCmd),
    /// Manage stages
    #[command(subcommand)]
    Stage(StageCmd),
    /// Manage tasks
    #[command(subcommand)]
    Task(TaskCmd),
    /// Make FROM a prerequisite of TO
    Link {
        from: String,
        to: String,
        /// Soft dependency (does not block)
        #[arg(long)]
        soft: bool,
        /// Skip the review proposal and write directly
        #[arg(long)]
        direct: bool,
    },
    /// Remove the dependency FROM -> TO
    Unlink {
        from: String,
        to: String,
        #[arg(long)]
        direct: bool,
    },
    /// Add a comment to a stage
    Comment { key: String, text: String },
    /// Tasks claimed right now (by whom, until when)
    Claims,
    /// Recent agent activity, newest first
    Log {
        #[arg(long, default_value_t = 20)]
        limit: usize,
        /// Only entries that touch this stage
        #[arg(long, value_name = "KEY")]
        stage: Option<String>,
    },
    /// Open tasks you can work on now (your claimed tasks first; tasks claimed by others are hidden)
    Next {
        #[arg(long, default_value_t = 10)]
        limit: usize,
    },
    /// Apply a YAML/JSON spec (file or `-` for stdin)
    Apply {
        file: String,
        /// Validate and report, write nothing
        #[arg(long)]
        dry_run: bool,
        /// Write directly even when the project is in review mode
        #[arg(long)]
        direct: bool,
    },
    /// Auto-layout the cards of a board (layered, left to right)
    Layout {
        board: String,
        /// Move only the cards of these stage keys
        #[arg(long, num_args = 1.., value_name = "KEY")]
        only_new: Vec<String>,
    },
    /// Check project integrity
    Validate {
        /// Safe fixes only: drop broken depends, remove cards of missing stages
        #[arg(long)]
        fix: bool,
    },
    /// Print a JSON Schema
    Schema { what: SchemaKind },
    /// Review mode: pending agent proposals
    #[command(subcommand)]
    Proposals(ProposalCmd),
    /// Protocol version, capabilities, counts and agent profiles
    Info,
    /// Agent profiles: display name, color, avatar
    #[command(subcommand)]
    Agent(AgentCmd),
    /// Stream project events until killed: `hello`, then live changes (use --json for NDJSON)
    Watch {
        /// First replay activity-log entries newer than this time (RFC3339, e.g. 2026-11-05T10:00:00Z)
        #[arg(long, value_name = "RFC3339")]
        since: Option<String>,
    },
    /// Agent Skills export
    #[command(subcommand)]
    Skill(SkillCmd),
    /// Run the MCP server on stdio
    Mcp {
        /// Expose read-only tools only
        #[arg(long)]
        read_only: bool,
    },
}

#[derive(Subcommand, Debug)]
pub enum BoardCmd {
    Create {
        name: String,
        #[arg(long)]
        title: Option<String>,
    },
    List,
}

#[derive(Subcommand, Debug)]
pub enum StageCmd {
    /// Create a stage (and its card)
    Add {
        key: String,
        title: String,
        /// Depend on this stage and place the card right of it
        #[arg(long)]
        after: Option<String>,
        #[arg(long, default_value = "ai")]
        who: String,
        #[arg(long, default_value = "roadmap")]
        board: String,
        #[arg(long)]
        direct: bool,
    },
    Show {
        key: String,
    },
    List {
        /// done | active | ready | blocked
        #[arg(long)]
        status: Option<String>,
        #[arg(long)]
        who: Option<String>,
        #[arg(long)]
        board: Option<String>,
        #[arg(long)]
        query: Option<String>,
    },
}

#[derive(Subcommand, Debug)]
pub enum TaskCmd {
    Add {
        key: String,
        title: String,
        #[arg(long)]
        direct: bool,
    },
    Done {
        task_id: String,
    },
    Undo {
        task_id: String,
    },
    /// Claim a task so other agents skip it (renews when you already hold it)
    Claim {
        task_id: String,
        /// Lifetime: 90s, 30m, 2h (bare number = minutes); max 8h
        #[arg(long, default_value = "30m")]
        ttl: String,
        #[arg(long, default_value = "")]
        note: String,
        /// External client of the session this claim comes from (e.g. maestro)
        #[arg(long, requires = "session_id")]
        session_client: Option<String>,
        /// Session id in that client
        #[arg(long, requires = "session_client")]
        session_id: Option<String>,
        #[arg(long, requires = "session_client")]
        session_url: Option<String>,
        #[arg(long, requires = "session_client")]
        session_title: Option<String>,
    },
    /// Release your claim on a task
    Release {
        task_id: String,
        /// Release a claim held by another agent
        #[arg(long)]
        force: bool,
    },
}

#[derive(Subcommand, Debug)]
pub enum AgentCmd {
    /// Create or update a profile (unset flags keep the current value)
    Set {
        /// Agent id `[a-z0-9._-]{1,32}`, the same as in `who: ai:<id>`
        id: String,
        #[arg(long)]
        name: Option<String>,
        /// #rgb or #rrggbb
        #[arg(long)]
        color: Option<String>,
        /// One emoji or assets/<file>.png
        #[arg(long)]
        avatar: Option<String>,
        #[arg(long)]
        kind: Option<String>,
    },
    List,
    Remove {
        id: String,
    },
}

#[derive(Subcommand, Debug)]
pub enum SkillCmd {
    /// Write .agents/skills/pathloom/SKILL.md into the project
    Install {
        /// Skills folder, relative to the project root
        #[arg(long, default_value = ".agents/skills")]
        dir: PathBuf,
        /// Overwrite an existing file
        #[arg(long)]
        force: bool,
    },
}

#[derive(clap::ValueEnum, Clone, Copy, Debug)]
pub enum SchemaKind {
    Stage,
    Board,
    Spec,
}

#[derive(Subcommand, Debug)]
pub enum ProposalCmd {
    List,
    Accept { id: String },
    Reject { id: String },
}
