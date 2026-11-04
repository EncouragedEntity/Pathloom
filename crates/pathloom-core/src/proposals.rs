//! Agent proposals for `agent_changes = "review"` (`.pathloom/proposals/<id>.json`).

use crate::apply::{ApplyOptions, ApplyReport, ApplySpec};
use crate::error::{Error, Result};
use crate::fsutil::{now_minute, write_atomic};
use crate::project::{Project, read_text};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct Proposal {
    /// Time-sortable id (ULID).
    pub id: String,
    pub created_at: String,
    pub author: String,
    pub spec: ApplySpec,
    /// Dry-run result at proposal time.
    pub preview: ApplyReport,
}

impl Project {
    fn proposals_dir(&self) -> PathBuf {
        self.root.join(".pathloom/proposals")
    }

    fn proposal_path(&self, id: &str) -> Result<PathBuf> {
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err(Error::InvalidName(format!("proposal id {id}")));
        }
        Ok(self.proposals_dir().join(format!("{id}.json")))
    }

    /// Validate `spec` (dry-run) and store it as a proposal. Nothing in `plan/` changes.
    pub fn propose(&self, spec: &ApplySpec, author: &str) -> Result<Proposal> {
        let opts = ApplyOptions { dry_run: true, author: author.into() };
        let preview = self.apply(spec, &opts)?;
        let p = Proposal {
            id: ulid::Ulid::generate().to_string(),
            created_at: now_minute(),
            author: author.into(),
            spec: spec.clone(),
            preview,
        };
        let text = serde_json::to_string_pretty(&p).map_err(|e| Error::InvalidSpec(e.to_string()))?;
        write_atomic(&self.proposal_path(&p.id)?, text.as_bytes())?;
        Ok(p)
    }

    fn load_proposal(&self, id: &str) -> Result<Proposal> {
        let path = self.proposal_path(id)?;
        if !path.is_file() {
            return Err(Error::NotFound(format!("proposal {id}")));
        }
        serde_json::from_str(&read_text(&path)?).map_err(|e| crate::error::parse_err(&path, e))
    }

    /// Pending proposals, oldest first. Unreadable files are skipped.
    pub fn list_proposals(&self) -> Result<Vec<Proposal>> {
        let mut out = Vec::new();
        if let Ok(rd) = std::fs::read_dir(self.proposals_dir()) {
            for e in rd {
                let path = e?.path();
                if path.extension().is_some_and(|x| x == "json")
                    && let Some(id) = path.file_stem().and_then(|s| s.to_str())
                    && let Ok(p) = self.load_proposal(id)
                {
                    out.push(p);
                }
            }
        }
        out.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(out)
    }

    /// Apply the proposal for real (as its author) and delete it. On error the proposal is kept.
    pub fn accept_proposal(&self, id: &str) -> Result<ApplyReport> {
        let p = self.load_proposal(id)?;
        let report = self.apply(&p.spec, &ApplyOptions { dry_run: false, author: p.author })?;
        std::fs::remove_file(self.proposal_path(id)?)?;
        Ok(report)
    }

    pub fn reject_proposal(&self, id: &str) -> Result<()> {
        let path = self.proposal_path(id)?;
        if !path.is_file() {
            return Err(Error::NotFound(format!("proposal {id}")));
        }
        std::fs::remove_file(path)?;
        Ok(())
    }
}
