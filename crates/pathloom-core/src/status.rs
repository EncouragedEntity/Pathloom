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
            StageKind::Gate => s.gate_passed() && s.tasks.iter().all(Task::is_done),
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
            // A gate's check counts as one more item.
            progress: {
                let gate = u32::from(s.kind == StageKind::Gate);
                (
                    s.tasks.iter().filter(|t| t.is_done()).count() as u32 + u32::from(s.gate_passed()),
                    s.tasks.len() as u32 + gate,
                )
            },
            stage: s.clone(),
            claims: Vec::new(),
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

/// Any dependency cycle among known stages, as `[a, b, .., z]` (z depends back on a). `None` if acyclic.
pub(crate) fn find_cycle(stages: &[Stage]) -> Option<Vec<String>> {
    use petgraph::algo::tarjan_scc;
    let mut g: DiGraph<&str, ()> = DiGraph::new();
    let idx: HashMap<&str, _> = stages.iter().map(|s| (s.key.as_str(), g.add_node(s.key.as_str()))).collect();
    for s in stages {
        for d in &s.depends {
            if let (Some(&a), Some(&b)) = (idx.get(d.id.as_str()), idx.get(s.key.as_str())) {
                g.add_edge(a, b, ());
            }
        }
    }
    let scc = tarjan_scc(&g)
        .into_iter()
        .filter(|c| c.len() > 1 || c.iter().any(|&n| g.contains_edge(n, n)))
        .min_by_key(|c| c.iter().map(|&n| g[n]).min().unwrap_or(""))?;
    let start = *scc.iter().min_by_key(|&&n| g[n])?;
    // BFS inside the component from `start` back to `start`.
    let mut parent: HashMap<_, _> = HashMap::new();
    let mut queue = std::collections::VecDeque::from([start]);
    while let Some(n) = queue.pop_front() {
        for m in g.neighbors(n) {
            if m == start {
                let mut path = vec![n];
                while let Some(&p) = parent.get(path.last()?) {
                    path.push(p);
                }
                path.reverse();
                if path.first() != Some(&start) {
                    path.insert(0, start);
                }
                return Some(path.into_iter().map(|n| g[n].to_string()).collect());
            }
            if scc.contains(&m) && !parent.contains_key(&m) && m != start {
                parent.insert(m, n);
                queue.push_back(m);
            }
        }
    }
    Some(scc.into_iter().map(|n| g[n].to_string()).collect())
}
