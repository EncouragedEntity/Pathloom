//! Layered left-to-right auto-layout of cards on a board (spec §5).
//!
//! Longest-path layering over hard+soft `depends` among the cards on the board; inside a layer cards are
//! ordered by the barycenter (mean Y) of their prerequisites. Non-card elements (except frames and
//! linear shapes: arrow/line/freedraw) are obstacles: a card is shifted down until it overlaps nothing.

use crate::error::{Error, Result};
use crate::model::{Board, Stage};
use crate::project::{Project, check_board_name};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet, VecDeque};

pub(crate) const X_STEP: f64 = 320.0;
pub(crate) const Y_STEP: f64 = 220.0;
pub(crate) const CARD_W: f64 = 250.0;
pub(crate) const CARD_H: f64 = 140.0;
/// Must stay below half the gap between layout columns (X_STEP - CARD_W = 70) so neighbouring frames never overlap.
pub(crate) const FRAME_PAD: f64 = 24.0;
const GAP: f64 = 20.0;

pub(crate) type El = Map<String, Value>;

#[derive(Clone, Copy)]
pub(crate) struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    fn bottom(&self) -> f64 {
        self.y + self.h
    }
    fn right(&self) -> f64 {
        self.x + self.w
    }
    fn overlaps(&self, o: &Rect) -> bool {
        self.x < o.right() && o.x < self.right() && self.y < o.bottom() && o.y < self.bottom()
    }
    fn grow(&self, d: f64) -> Rect {
        Rect { x: self.x - d, y: self.y - d, w: self.w + 2.0 * d, h: self.h + 2.0 * d }
    }
}

fn f(el: &El, k: &str) -> Option<f64> {
    el.get(k).and_then(Value::as_f64)
}

pub(crate) fn rect_of(el: &El) -> Option<Rect> {
    Some(Rect { x: f(el, "x")?, y: f(el, "y")?, w: f(el, "w").unwrap_or(0.0), h: f(el, "h").unwrap_or(0.0) })
}

pub(crate) fn el_type(el: &El) -> &str {
    el.get("type").and_then(Value::as_str).unwrap_or("")
}

pub(crate) fn el_id(el: &El) -> &str {
    el.get("id").and_then(Value::as_str).unwrap_or("")
}

pub(crate) fn card_ref(el: &El) -> Option<&str> {
    if el_type(el) == "card" { el.get("ref").and_then(Value::as_str) } else { None }
}

/// JSON number: integer when the value is whole.
pub(crate) fn num(v: f64) -> Value {
    if v.fract() == 0.0 && v.abs() < 1e15 { Value::from(v as i64) } else { Value::from(v) }
}

pub(crate) fn card_rect(el: &El) -> Rect {
    let r = rect_of(el).unwrap_or(Rect { x: 0.0, y: 0.0, w: CARD_W, h: CARD_H });
    Rect { w: if r.w > 0.0 { r.w } else { CARD_W }, h: if r.h > 0.0 { r.h } else { CARD_H }, ..r }
}

/// Lay out cards. `movers = None` moves every card; `Some(keys)` moves only those (others are fixed).
/// `after` maps a mover to a card it should be placed right of. Returns moved keys.
pub(crate) fn layout_elements(
    els: &mut [El],
    stages: &[Stage],
    movers: Option<&HashSet<String>>,
    after: &HashMap<String, String>,
) -> Result<Vec<String>> {
    let mut order: Vec<String> = Vec::new();
    let mut card_of: HashMap<String, usize> = HashMap::new();
    for (i, el) in els.iter().enumerate() {
        if let Some(r) = card_ref(el)
            && !card_of.contains_key(r)
        {
            card_of.insert(r.to_string(), i);
            order.push(r.to_string());
        }
    }
    let by_key: HashMap<&str, &Stage> = stages.iter().map(|s| (s.key.as_str(), s)).collect();
    let deps_of = |k: &str| -> Vec<String> {
        by_key
            .get(k)
            .map(|s| {
                s.depends
                    .iter()
                    .filter(|d| d.id != k && card_of.contains_key(&d.id))
                    .map(|d| d.id.clone())
                    .collect()
            })
            .unwrap_or_default()
    };

    // Layers (Kahn, longest path). A cycle among the cards is an error.
    let mut indeg: HashMap<&str, usize> = order.iter().map(|k| (k.as_str(), 0)).collect();
    let mut succ: HashMap<String, Vec<&str>> = HashMap::new();
    for k in &order {
        for d in deps_of(k) {
            *indeg.entry(k.as_str()).or_default() += 1;
            succ.entry(d).or_default().push(k.as_str());
        }
    }
    let mut layer: HashMap<&str, usize> = HashMap::new();
    let mut queue: VecDeque<&str> = order.iter().map(String::as_str).filter(|k| indeg[k] == 0).collect();
    for k in &queue {
        layer.insert(k, 0);
    }
    let mut seen = 0;
    while let Some(k) = queue.pop_front() {
        seen += 1;
        let lk = layer[k];
        for &s in succ.get(k).map(Vec::as_slice).unwrap_or_default() {
            let e = layer.entry(s).or_insert(0);
            *e = (*e).max(lk + 1);
            if let Some(n) = indeg.get_mut(s) {
                *n -= 1;
                if *n == 0 {
                    queue.push_back(s);
                }
            }
        }
    }
    if seen < order.len() {
        return Err(Error::Cycle(order.iter().filter(|k| indeg[k.as_str()] > 0).cloned().collect()));
    }

    let is_mover = |k: &str| movers.is_none_or(|m| m.contains(k));
    let mover_keys: Vec<&String> = order.iter().filter(|k| is_mover(k)).collect();
    if mover_keys.is_empty() {
        return Ok(vec![]);
    }
    let mover_idx: HashSet<usize> = mover_keys.iter().map(|k| card_of[k.as_str()]).collect();

    // Obstacles: (rect, is_placed_mover).
    let mut obstacles: Vec<(Rect, bool)> = Vec::new();
    for (i, el) in els.iter().enumerate() {
        if mover_idx.contains(&i) {
            continue;
        }
        match el_type(el) {
            "card" => obstacles.push((card_rect(el), false)),
            "frame" | "arrow" | "line" | "freedraw" => {}
            _ => {
                if let Some(r) = rect_of(el).filter(|r| r.w > 0.0 && r.h > 0.0) {
                    obstacles.push((r, false));
                }
            }
        }
    }
    let (root_x, root_y) = if movers.is_none() {
        let rs: Vec<Rect> = mover_keys.iter().map(|k| card_rect(&els[card_of[k.as_str()]])).collect();
        (
            rs.iter().map(|r| r.x).fold(f64::INFINITY, f64::min),
            rs.iter().map(|r| r.y).fold(f64::INFINITY, f64::min),
        )
    } else if obstacles.is_empty() {
        (0.0, 0.0)
    } else {
        (
            obstacles.iter().map(|(r, _)| r.right()).fold(f64::NEG_INFINITY, f64::max) + (X_STEP - CARD_W),
            obstacles.iter().map(|(r, _)| r.y).fold(f64::INFINITY, f64::min),
        )
    };

    let mut placed: HashSet<&str> = HashSet::new();
    let max_layer = mover_keys.iter().map(|k| layer[k.as_str()]).max().unwrap_or(0);
    for l in 0..=max_layer {
        // (key, x, desired y, current y)
        let mut items: Vec<(u8, &String, f64, f64, f64)> = Vec::new();
        for &k in mover_keys.iter().filter(|k| layer[k.as_str()] == l) {
            let cur_y = f(&els[card_of[k.as_str()]], "y").unwrap_or(0.0);
            let pos_of = |t: &str| rect_of(&els[card_of[t]]);
            let hint = after
                .get(k)
                .filter(|t| card_of.contains_key(t.as_str()) && (!is_mover(t) || placed.contains(t.as_str())))
                .and_then(|t| pos_of(t));
            let deps: Vec<Rect> = deps_of(k).iter().filter_map(|d| pos_of(d)).collect();
            let (x, y) = if let Some(h) = hint {
                (h.x + X_STEP, h.y)
            } else if !deps.is_empty() {
                (
                    deps.iter().map(|r| r.x).fold(f64::NEG_INFINITY, f64::max) + X_STEP,
                    deps.iter().map(|r| r.y).sum::<f64>() / deps.len() as f64,
                )
            } else {
                (root_x, root_y)
            };
            // Isolated roots go below the roots that have dependents.
            let rank = u8::from(l == 0 && !succ.contains_key(k.as_str()));
            items.push((rank, k, x, y, cur_y));
        }
        items.sort_by(|a, b| a.0.cmp(&b.0).then(a.3.total_cmp(&b.3)).then(a.4.total_cmp(&b.4)).then_with(|| a.1.cmp(b.1)));
        for (_, k, x, mut y, _) in items {
            let h = card_rect(&els[card_of[k.as_str()]]).h;
            for _ in 0..10_000 {
                let me = Rect { x, y, w: CARD_W, h };
                let Some((o, mv)) = obstacles.iter().find(|(o, _)| me.overlaps(&o.grow(GAP))) else { break };
                y = (o.bottom() + GAP).max(if *mv { o.y + Y_STEP } else { 0.0 });
            }
            let el = &mut els[card_of[k.as_str()]];
            el.insert("x".into(), num(x));
            el.insert("y".into(), num(y));
            obstacles.push((Rect { x, y, w: CARD_W, h }, true));
            placed.insert(k.as_str());
        }
    }
    Ok(mover_keys.into_iter().cloned().collect())
}

/// Bounding box of all elements whose `frame` is `frame_id`.
pub(crate) fn members_bbox(els: &[El], frame_id: &str) -> Option<Rect> {
    let rs: Vec<Rect> = els
        .iter()
        .filter(|e| e.get("frame").and_then(Value::as_str) == Some(frame_id))
        .filter_map(|e| if el_type(e) == "card" { Some(card_rect(e)) } else { rect_of(e) })
        .collect();
    if rs.is_empty() {
        return None;
    }
    let x = rs.iter().map(|r| r.x).fold(f64::INFINITY, f64::min);
    let y = rs.iter().map(|r| r.y).fold(f64::INFINITY, f64::min);
    let r = rs.iter().map(Rect::right).fold(f64::NEG_INFINITY, f64::max);
    let b = rs.iter().map(Rect::bottom).fold(f64::NEG_INFINITY, f64::max);
    Some(Rect { x, y, w: r - x, h: b - y })
}

/// Resize frame `frame_id` to enclose its members with [`FRAME_PAD`].
pub(crate) fn fit_frame(els: &mut [El], frame_id: &str) {
    let Some(bb) = members_bbox(els, frame_id) else { return };
    if let Some(fr) = els.iter_mut().find(|e| el_type(e) == "frame" && el_id(e) == frame_id) {
        fr.insert("x".into(), num(bb.x - FRAME_PAD));
        fr.insert("y".into(), num(bb.y - FRAME_PAD));
        fr.insert("w".into(), num(bb.w + 2.0 * FRAME_PAD));
        fr.insert("h".into(), num(bb.h + 2.0 * FRAME_PAD));
    }
}

impl Project {
    /// Layered LR layout of the cards on `board` and save. `only_new` empty = move every card;
    /// otherwise only the cards of these stage keys move (others stay and act as obstacles).
    /// Frames that contained a moved card are refitted. Cycle among the cards -> `Error::Cycle`.
    pub fn layout_board(&self, board: &str, only_new: &[String]) -> Result<Board> {
        check_board_name(board)?;
        let mut b = self.load_board(board)?;
        let stages = self.load_stages()?;
        let set: HashSet<String> = only_new.iter().cloned().collect();
        for k in &set {
            if !b.elements.iter().any(|e| card_ref(e) == Some(k.as_str())) {
                return Err(Error::NotFound(format!("card for stage {k} on board {board}")));
            }
        }
        let moved = layout_elements(&mut b.elements, &stages, (!set.is_empty()).then_some(&set), &HashMap::new())?;
        let frames: HashSet<String> = b
            .elements
            .iter()
            .filter(|e| card_ref(e).is_some_and(|r| moved.iter().any(|m| m == r)))
            .filter_map(|e| e.get("frame").and_then(Value::as_str).map(String::from))
            .collect();
        for fid in frames {
            fit_frame(&mut b.elements, &fid);
        }
        self.save_board(board, &b)?;
        Ok(b)
    }
}

/// Estimated rendered height of a stage card. Mirrors `cardLayout` in packages/canvas/src/stage.ts
/// (same constants), so frames and layout made by agents fit what the app draws.
pub(crate) fn card_height(stage: &crate::model::Stage) -> f64 {
    use crate::model::Priority;
    const PAD_TOP: f64 = 12.0;
    const HEAD: f64 = 20.0 + 8.0;
    const TITLE_LH: f64 = 20.0;
    const TITLE_GAP: f64 = 8.0;
    const PROG: f64 = 14.0;
    const PROG_GAP: f64 = 8.0;
    const TASK_H: f64 = 22.0;
    const TASK_GAP: f64 = 2.0;
    const FOOTER: f64 = 8.0 + 1.0 + 8.0 + 14.0;
    const PAD_BOTTOM: f64 = 10.0;
    const MAX_TASKS: usize = 12;
    // ~26 characters fit on one title line at 15px in a 226px wide column.
    let title_lines = if stage.title.chars().count() > 26 { 2.0 } else { 1.0 };
    let mut h = PAD_TOP + HEAD + title_lines * TITLE_LH + TITLE_GAP + PROG;
    let shown = stage.tasks.len().min(MAX_TASKS);
    if shown > 0 {
        h += PROG_GAP + shown as f64 * (TASK_H + TASK_GAP) - TASK_GAP;
    }
    if stage.tasks.len() > MAX_TASKS {
        h += TASK_GAP + TASK_H;
    }
    if stage.due.is_some() || stage.priority == Priority::High || stage.branch.is_some() {
        h += FOOTER;
    }
    h + PAD_BOTTOM
}
