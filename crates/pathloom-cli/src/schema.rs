//! JSON Schemas for stage, board and apply-spec (CLI `schema` and MCP resources).

use crate::cli::SchemaKind;
use pathloom_core::{ApplySpec, Board, Stage};
use serde_json::Value;

pub fn schema(kind: SchemaKind) -> Value {
    let s = match kind {
        SchemaKind::Stage => schemars::schema_for!(Stage),
        SchemaKind::Board => schemars::schema_for!(Board),
        SchemaKind::Spec => schemars::schema_for!(ApplySpec),
    };
    serde_json::to_value(s).unwrap_or(Value::Null)
}
