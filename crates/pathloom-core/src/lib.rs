//! Pathloom core: project files, boards, stages, dependency graph and computed statuses.
//! See `README.md` for the file-format notes.

mod apply;
mod board;
mod error;
mod fsutil;
mod hash;
mod indexkey;
mod keygen;
mod layout;
mod model;
mod next;
mod project;
mod proposals;
mod stagefile;
mod status;
mod validate;
pub mod writes;

pub use apply::{
    ApplyOptions, ApplyReport, ApplySpec, CardPlacement, CommentSpec, DepSpec, FrameSpec, LinkSpec, Place, StageSpec,
    UnlinkSpec,
};
pub use board::BOARD_FORMAT;
pub use fsutil::write_file_atomic;
pub use hash::hash_bytes;
pub use next::NextTask;
pub use proposals::Proposal;
pub use validate::Issue;
pub use error::{Error, Result};
pub use keygen::generate_key;
pub use model::{
    AgentChanges, Board, Comment, Dep, Priority, ProjectConfig, Stage, StageKind, StageMeta, StageView, Status,
    Task, Who,
};
pub use project::Project;
pub use stagefile::is_valid_key;
pub use status::{compute_statuses, stage_views};
