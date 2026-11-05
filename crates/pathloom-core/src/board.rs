//! Canonical `*.board.json` reader/writer (spec §4.3).

use crate::error::{Result, parse_err};
use crate::model::Board;
use serde_json::{Map, Value};
use std::path::Path;

pub const BOARD_FORMAT: &str = "pathloom.board/1";

const KEY_ORDER: [&str; 9] = ["id", "type", "ref", "x", "y", "w", "h", "angle", "index"];

impl Board {
    pub fn new(title: &str) -> Board {
        Board {
            format: BOARD_FORMAT.into(),
            title: title.into(),
            style: "clean".into(),
            auto_layout: false,
            elements: vec![],
        }
    }

    pub fn from_json(path: &Path, text: &str) -> Result<Board> {
        serde_json::from_str(text).map_err(|e| parse_err(path, e))
    }

    /// Canonical text: fixed top-level order, one element per line, fixed key order.
    pub fn to_canonical_json(&self) -> String {
        let q = |s: &str| serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into());
        let mut out = format!(
            "{{\n  \"format\": {},\n  \"title\": {},\n  \"style\": {},\n",
            q(&self.format),
            q(&self.title),
            q(&self.style)
        );
        if self.auto_layout {
            out.push_str("  \"autoLayout\": true,\n");
        }
        out.push_str("  \"elements\": [");
        if self.elements.is_empty() {
            out.push_str("]\n}\n");
            return out;
        }
        out.push('\n');
        let lines: Vec<String> = self.elements.iter().map(element_line).collect();
        out.push_str(&lines.join(",\n"));
        out.push_str("\n  ]\n}\n");
        out
    }
}

fn element_line(el: &Map<String, Value>) -> String {
    let mut keys: Vec<&String> = el.keys().collect();
    let rank = |k: &str| KEY_ORDER.iter().position(|o| *o == k).unwrap_or(KEY_ORDER.len());
    keys.sort_by(|a, b| rank(a).cmp(&rank(b)).then_with(|| a.cmp(b)));
    let parts: Vec<String> = keys
        .iter()
        .map(|k| {
            let key = serde_json::to_string(k).unwrap_or_default();
            let val = serde_json::to_string(&el[k.as_str()]).unwrap_or_else(|_| "null".into());
            format!("{key}:{val}")
        })
        .collect();
    format!("{{{}}}", parts.join(","))
}
