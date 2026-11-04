//! Computed stage status (spec §5) and dependency-cycle detection.

use crate::model::*;
use petgraph::algo::astar;
use petgraph::graph::DiGraph;
use std::collections::{BTreeMap, HashMap, HashSet};

fn tasks_done(s: &Stage) -> bool {
    !s.tasks.is_empty() && s.tasks.iter().all(Task::is_done)
}

struct Ctx<'a> {
    by_key: HashMap<&'a str, &'a Stage>,
    memo: HashMap<&'a str, bool>,
    visiting: HashSet<&'a str>,
}

impl<'a> Ctx<'a> {
    /// Unknown keys are "not done" here; callers skip them first. Cycles count as not done.
    fn is_done(&mut self, key: &'a str) -> bool {
        if let Some(&d) = self.memo.get(key) {
            return d;
        }
        let Some(&s) = self.by_key.get(key) else { return false };
        if !self.visiting.insert(key) {
            return false;
        }
        let d = match s.kind {
            StageKind::Stage => tasks_done(s),
            StageKind::Milestone => {
                let hard = self.hard_deps(s);
                !hard.is_empty() && hard.into_iter().all(|k| self.is_done(k))
            }
        };
        self.visiting.remove(key);
        self.memo.insert(key, d);
        d
    }

    fn hard_deps(&self, s: &'a Stage) -> Vec<&'a str> {
        s.depends
            .iter()
            .filter(|d| !d.soft && self.by_key.contains_key(d.id.as_str()))
            .map(|d| d.id.as_str())
            .collect()
    }
}

/// done / blocked / active / ready for every stage, per spec §5.
///
/// Stage with zero tasks is never done. A milestone with no (known) hard deps is `ready`.
/// Unknown dependency keys are ignored.
pub fn compute_statuses(stages: &[Stage]) -> BTreeMap<String, Status> {
    let mut cx = Ctx {
        by_key: stages.iter().map(|s| (s.key.as_str(), s)).collect(),
        memo: HashMap::new(),
        visiting: HashSet::new(),
    };
    let mut out = BTreeMap::new();
    for s in stages {
        let status = if cx.is_done(&s.key) {
            Status::Done
        } else if cx.hard_deps(s).into_iter().any(|k| !cx.is_done(k)) {
            Status::Blocked
        } else if s.tasks.iter().any(Task::is_done) {
            Status::Active
        } else {
            Status::Ready
        };
        out.insert(s.key.clone(), status);
    }
    out
}

/// Stages plus computed status and progress (done top-level tasks, total top-level tasks).
pub fn stage_views(stages: &[Stage]) -> Vec<StageView> {
    let statuses = compute_statuses(stages);
    stages
        .iter()
        .map(|s| StageView {
            status: statuses.get(&s.key).copied().unwrap_or_default(),
            progress: (
                s.tasks.iter().filter(|t| t.is_done()).count() as u32,
                s.tasks.len() as u32,
            ),
            stage: s.clone(),
        })
        .collect()
}

/// If adding the dependency `from -> to` (from is a prerequisite of to) would create a cycle,
/// return the cycle nodes: `[to, ..., from]` (the new edge closes it).
pub(crate) fn cycle_for_link(stages: &[Stage], from: &str, to: &str) -> Option<Vec<String>> {
    if from == to {
        return Some(vec![from.into(), to.into()]);
    }
    let mut g: DiGraph<&str, ()> = DiGraph::new();
    let idx: HashMap<&str, _> = stages.iter().map(|s| (s.key.as_str(), g.add_node(s.key.as_str()))).collect();
    for s in stages {
        for d in &s.depends {
            if let (Some(&a), Some(&b)) = (idx.get(d.id.as_str()), idx.get(s.key.as_str())) {
                g.add_edge(a, b, ());
            }
        }
    }
    let (&t, &f) = (idx.get(to)?, idx.get(from)?);
    let (_, path) = astar(&g, t, |n| n == f, |_| 1, |_| 0)?;
    Some(path.into_iter().map(|n| g[n].to_string()).collect())
}
