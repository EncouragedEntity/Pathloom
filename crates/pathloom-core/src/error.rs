use std::path::PathBuf;

/// Errors returned by `pathloom-core`.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("cannot parse {}: {message}", path.display())]
    Parse { path: PathBuf, message: String },
    #[error("not a Pathloom project (no .pathloom/project.toml)")]
    NotAProject,
    #[error("not found: {0}")]
    NotFound(String),
    #[error("duplicate key: {0}")]
    DuplicateKey(String),
    #[error("invalid key: {0}")]
    InvalidKey(String),
    #[error("dependency cycle: {}", .0.join(" -> "))]
    Cycle(Vec<String>),
    /// Board name with `..`, empty segments, absolute path or backslashes.
    #[error("invalid name: {0}")]
    InvalidName(String),
    /// Optimistic-concurrency failure: the stage file changed since the caller read it.
    #[error("conflict: stage {key} changed since it was read")]
    Conflict { key: String },
    /// Malformed or inconsistent `apply` spec / argument.
    #[error("invalid spec: {0}")]
    InvalidSpec(String),
    #[error("project already initialized at {}", .0.display())]
    AlreadyInitialized(PathBuf),
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

pub(crate) fn parse_err(path: &std::path::Path, message: impl std::fmt::Display) -> Error {
    Error::Parse { path: path.to_path_buf(), message: message.to_string() }
}
