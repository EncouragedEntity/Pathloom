//! Pathloom core: project files, boards, stages, dependency graph and computed statuses.
//! See `README.md` for the file-format notes.

mod board;
mod error;
mod fsutil;
mod keygen;
mod model;
mod project;
mod stagefile;
mod status;

pub use board::BOARD_FORMAT;
pub use error::{Error, Result};
pub use keygen::generate_key;
pub use model::{
    AgentChanges, Board, Comment, Dep, Priority, ProjectConfig, Stage, StageKind, StageView, Status,
    Task, Who,
};
pub use project::Project;
pub use stagefile::is_valid_key;
pub use status::{compute_statuses, stage_views};
