//! Pathloom core: project files, boards, stages, dependency graph and computed statuses.
//! See `README.md` for the file-format notes.

mod agents;
mod apply;
mod board;
mod claims;
mod error;
mod evidence;
mod import;
pub mod events;
mod fsutil;
mod hash;
mod indexkey;
mod keygen;
mod layout;
mod log;
mod model;
mod next;
mod project;
mod proposals;
mod rename;
mod protocol;
mod session;
mod stagefile;
mod status;
mod validate;
pub mod writes;

pub use agents::{AgentProfile, is_valid_agent_id};
pub use apply::{
    ApplyOptions, ApplyReport, ApplySpec, CardPlacement, CommentSpec, DepSpec, FrameSpec, LinkSpec, Place, StageSpec,
    UnlinkSpec,
};
pub use board::BOARD_FORMAT;
pub use claims::{Claim, ClaimView, DEFAULT_CLAIM_TTL_SECS, MAX_CLAIM_TTL_SECS, SILENT_AFTER_SECS};
pub use log::{LogEntry, Usage, UsageSummary};
pub use fsutil::{now_rfc3339, write_file_atomic};
pub use hash::hash_bytes;
pub use next::NextTask;
pub use proposals::Proposal;
pub use protocol::{PROTOCOL, capabilities};
pub use session::{MAX_STAGE_SESSIONS, SessionRef};
pub use validate::Issue;
pub use error::{Error, Result};
pub use evidence::Evidence;
pub use import::ImportReport;
pub use keygen::generate_key;
pub use model::{
    AgentChanges, Board, Comment, Dep, Priority, ProjectConfig, Stage, StageKind, StageMeta, StageView, Status,
    Task, TaskInfo, Who,
};
pub use project::Project;
pub use stagefile::is_valid_key;
pub use status::{compute_statuses, stage_views};
