use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

macro_rules! lower_enum {
    ($(#[$m:meta])* $name:ident { $($var:ident = $s:literal),+ } default $def:ident) => {
        $(#[$m])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(rename_all = "lowercase")]
        pub enum $name { $(#[allow(missing_docs)] $var),+ }
        impl Default for $name { fn default() -> Self { Self::$def } }
        #[allow(dead_code)]
        impl $name {
            pub(crate) fn as_str(self) -> &'static str { match self { $(Self::$var => $s),+ } }
            pub(crate) fn parse(s: &str) -> Option<Self> { match s { $($s => Some(Self::$var),)+ _ => None } }
        }
    };
}

lower_enum!(StageKind { Stage = "stage", Milestone = "milestone" } default Stage);
lower_enum!(Who { Me = "me", Ai = "ai", Both = "both" } default Ai);
lower_enum!(Priority { Low = "low", Med = "med", High = "high" } default Med);
lower_enum!(AgentChanges { Auto = "auto", Review = "review" } default Auto);
lower_enum!(Status { Done = "done", Active = "active", Ready = "ready", Blocked = "blocked" } default Ready);

impl Stage {
    /// New empty stage (kind=stage, who=ai, priority=med).
    pub fn new(key: &str, title: &str) -> Self {
        Stage {
            key: key.into(),
            title: title.into(),
            kind: StageKind::Stage,
            who: Who::Ai,
            due: None,
            priority: Priority::Med,
            branch: None,
            pr: None,
            tags: vec![],
            depends: vec![],
            description: String::new(),
            tasks: vec![],
            comments: vec![],
            extra: Map::new(),
            layout: Layout::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Dep {
    pub id: String,
    pub soft: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub done: bool,
    pub sub: Vec<Task>,
}

impl Task {
    /// A task with subtasks is done when all of them are; otherwise its own flag.
    pub fn is_done(&self) -> bool {
        if self.sub.is_empty() { self.done } else { self.sub.iter().all(|s| s.done) }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Comment {
    pub at: String,
    pub author: String,
    pub text: String,
}

/// Raw pieces of the markdown body that Pathloom does not manage.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Layout {
    /// Blank lines that followed the description (kept to stay byte-identical).
    pub desc_tail: String,
    /// Everything after the first managed section, in file order.
    pub segments: Vec<Seg>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Seg {
    Tasks { tail: String },
    Comments { tail: String },
    Text(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stage {
    pub key: String,
    pub title: String,
    pub kind: StageKind,
    pub who: Who,
    pub due: Option<String>,
    pub priority: Priority,
    pub branch: Option<String>,
    pub pr: Option<String>,
    pub tags: Vec<String>,
    pub depends: Vec<Dep>,
    pub description: String,
    pub tasks: Vec<Task>,
    pub comments: Vec<Comment>,
    /// Unknown frontmatter keys (not exposed to the UI).
    #[serde(skip)]
    pub(crate) extra: Map<String, Value>,
    /// Unmanaged body text (not exposed to the UI).
    #[serde(skip)]
    pub(crate) layout: Layout,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageView {
    #[serde(flatten)]
    pub stage: Stage,
    pub status: Status,
    pub progress: (u32, u32),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    pub format: String,
    pub title: String,
    pub style: String,
    pub elements: Vec<Map<String, Value>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConfig {
    pub format: u32,
    pub name: String,
    pub plan_dir: String,
    pub agent_changes: AgentChanges,
}
