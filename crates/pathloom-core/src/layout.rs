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

// ---------- full layout: phases as column groups, fewer crossings ----------

/// Extra space between the column groups of two frames (phases).
pub(crate) const FRAME_GAP: f64 = 80.0;
const ROW_GAP: f64 = 40.0;

/// Longest-path layer of every key over `deps` (only edges between `keys`). `None` on a cycle.
fn longest_layers(keys: &[String], deps: &dyn Fn(&str) -> Vec<String>) -> Option<HashMap<String, usize>> {
    let set: HashSet<&str> = keys.iter().map(String::as_str).collect();
    let mut indeg: HashMap<&str, usize> = keys.iter().map(|k| (k.as_str(), 0)).collect();
    let mut succ: HashMap<String, Vec<String>> = HashMap::new();
    for k in keys {
        for d in deps(k).into_iter().filter(|d| set.contains(d.as_str())) {
            *indeg.get_mut(k.as_str())? += 1;
            succ.entry(d).or_default().push(k.clone());
        }
    }
    let mut layer: HashMap<String, usize> = HashMap::new();
    let mut queue: VecDeque<String> = keys.iter().filter(|k| indeg[k.as_str()] == 0).cloned().collect();
    for k in &queue {
        layer.insert(k.clone(), 0);
    }
    let mut seen = 0;
    while let Some(k) = queue.pop_front() {
        seen += 1;
        let lk = layer[&k];
        for s in succ.get(&k).cloned().unwrap_or_default() {
            let e = layer.entry(s.clone()).or_insert(0);
            *e = (*e).max(lk + 1);
            let n = indeg.get_mut(s.as_str())?;
            *n -= 1;
            if *n == 0 {
                queue.push_back(s);
            }
        }
    }
    (seen == keys.len()).then_some(layer)
}

/// Lay out every card on the board, left to right:
/// - each frame (phase) gets its own block of columns, frames ordered by their dependencies (unframed cards form
///   one more block); when frames depend on each other in a circle, all cards share one global layering;
/// - inside a column, cards are ordered by the barycenter of their neighbours (fewer crossing arrows) and placed
///   level with their prerequisites where there is room;
/// - cards with `"pinned": true` (moved by hand) keep their place and act as obstacles, like shapes and images.
///
/// Card heights are refreshed from the stage content. Frames are refitted. Cycle among the cards -> `Error::Cycle`.
pub(crate) fn layout_full(els: &mut [El], stages: &[Stage]) -> Result<Vec<String>> {
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
    if order.is_empty() {
        return Ok(vec![]);
    }
    let by_key: HashMap<&str, &Stage> = stages.iter().map(|s| (s.key.as_str(), s)).collect();
    for k in &order {
        if let Some(s) = by_key.get(k.as_str()) {
            els[card_of[k]].insert("h".into(), num(card_height(s)));
        }
    }
    let deps_of = |k: &str| -> Vec<String> {
        by_key
            .get(k)
            .map(|s| s.depends.iter().filter(|d| d.id != k && card_of.contains_key(&d.id)).map(|d| d.id.clone()).collect())
            .unwrap_or_default()
    };
    let global = longest_layers(&order, &deps_of)
        .ok_or_else(|| Error::Cycle(order.clone()))?;
    let pinned = |k: &str| els[card_of[k]].get("pinned").and_then(Value::as_bool).unwrap_or(false);
    let movers: Vec<String> = order.iter().filter(|k| !pinned(k)).cloned().collect();

    // Groups: top-level frame id (a frame inside a frame belongs to its parent's block), or "" for unframed cards.
    let parent: HashMap<String, String> = els
        .iter()
        .filter(|e| el_type(e) == "frame")
        .filter_map(|e| Some((el_id(e).to_string(), e.get("frame").and_then(Value::as_str)?.to_string())))
        .collect();
    let top = |f: &str| -> String {
        let mut cur = f.to_string();
        for _ in 0..32 {
            match parent.get(&cur) {
                Some(p) if p != &cur => cur.clone_from(p),
                _ => break,
            }
        }
        cur
    };
    let group_of: HashMap<String, String> = order
        .iter()
        .map(|k| (k.clone(), top(els[card_of[k]].get("frame").and_then(Value::as_str).unwrap_or(""))))
        .collect();
    let mut groups: Vec<String> = Vec::new();
    for k in &order {
        if !groups.contains(&group_of[k]) {
            groups.push(group_of[k].clone());
        }
    }
    let group_deps = |g: &str| -> Vec<String> {
        let mut v: Vec<String> = order
            .iter()
            .filter(|k| group_of[k.as_str()] == g)
            .flat_map(|k| deps_of(k))
            .map(|d| group_of[&d].clone())
            .filter(|dg| dg != g)
            .collect();
        v.sort();
        v.dedup();
        v
    };
    let min_layer = |g: &str| order.iter().filter(|k| group_of[k.as_str()] == g).map(|k| global[k]).min().unwrap_or(0);
    // (column, block index) per card
    let mut col: HashMap<String, (usize, usize)> = HashMap::new();
    match longest_layers(&groups, &group_deps).filter(|_| groups.len() > 1) {
        Some(glayer) => {
            groups.sort_by_key(|g| (glayer[g], min_layer(g)));
            let mut offset = 0;
            for (gi, g) in groups.iter().enumerate() {
                let members: Vec<String> = order.iter().filter(|k| &group_of[k.as_str()] == g).cloned().collect();
                let local = longest_layers(&members, &deps_of).ok_or_else(|| Error::Cycle(members.clone()))?;
                let width = local.values().max().copied().unwrap_or(0) + 1;
                for k in &members {
                    col.insert(k.clone(), (offset + local[k], gi));
                }
                offset += width;
            }
        }
        None => {
            for k in &order {
                col.insert(k.clone(), (global[k], 0));
            }
        }
    }

    let rects: HashMap<String, Rect> = order.iter().map(|k| (k.clone(), card_rect(&els[card_of[k]]))).collect();
    let root_x = rects.values().map(|r| r.x).fold(f64::INFINITY, f64::min);
    let root_y = rects.values().map(|r| r.y).fold(f64::INFINITY, f64::min);
    let ncols = col.values().map(|c| c.0).max().unwrap_or(0) + 1;
    let mut cols: Vec<Vec<String>> = vec![Vec::new(); ncols];
    for k in &order {
        cols[col[k].0].push(k.clone());
    }
    for c in &mut cols {
        c.sort_by(|a, b| rects[a].y.total_cmp(&rects[b].y).then_with(|| a.cmp(b)));
    }

    // Crossing reduction: barycenter sweeps, down then up.
    let succs: HashMap<String, Vec<String>> = {
        let mut m: HashMap<String, Vec<String>> = HashMap::new();
        for k in &order {
            for d in deps_of(k) {
                m.entry(d).or_default().push(k.clone());
            }
        }
        m
    };
    let rel = |cols: &Vec<Vec<String>>| -> HashMap<String, f64> {
        let mut m = HashMap::new();
        for c in cols {
            for (i, k) in c.iter().enumerate() {
                m.insert(k.clone(), (i as f64 + 0.5) / c.len() as f64);
            }
        }
        m
    };
    for round in 0..8 {
        let down = round % 2 == 0;
        let range: Vec<usize> = if down { (1..ncols).collect() } else { (0..ncols.saturating_sub(1)).rev().collect() };
        for ci in range {
            let p = rel(&cols);
            let bary = |k: &String| -> f64 {
                let nb: Vec<String> = if down { deps_of(k) } else { succs.get(k).cloned().unwrap_or_default() };
                if nb.is_empty() { p[k] } else { nb.iter().map(|n| p[n]).sum::<f64>() / nb.len() as f64 }
            };
            let mut keyed: Vec<(f64, String)> = cols[ci].iter().map(|k| (bary(k), k.clone())).collect();
            keyed.sort_by(|a, b| a.0.total_cmp(&b.0));
            cols[ci] = keyed.into_iter().map(|(_, k)| k).collect();
        }
    }

    // Coordinates: column x; y level with the prerequisites when there is room.
    let heights: HashMap<String, f64> = order.iter().map(|k| (k.clone(), card_rect(&els[card_of[k]]).h)).collect();
    let height = |k: &str| heights[k];
    let mut pos: HashMap<String, (f64, f64)> = HashMap::new();
    for (ci, c) in cols.iter().enumerate() {
        let mut bottom = f64::NEG_INFINITY;
        for k in c {
            let x = root_x + ci as f64 * X_STEP + col[k].1 as f64 * FRAME_GAP;
            let h = height(k);
            // Level with the prerequisites (fewer crossings than starting every phase at the top).
            let pre: Vec<f64> = deps_of(k).iter().filter_map(|d| pos.get(d).map(|(_, y)| y + height(d) / 2.0)).collect();
            let want = if pre.is_empty() { root_y } else { pre.iter().sum::<f64>() / pre.len() as f64 - h / 2.0 };
            let y = want.max(root_y).max(bottom + ROW_GAP);
            bottom = y + h;
            pos.insert(k.clone(), (x, y));
        }
    }

    // Pinned cards and other shapes stay; movers slide down past them.
    let mover_set: HashSet<&str> = movers.iter().map(String::as_str).collect();
    let mut obstacles: Vec<Rect> = Vec::new();
    for (i, el) in els.iter().enumerate() {
        match el_type(el) {
            "card" => {
                if card_ref(el).is_some_and(|r| !mover_set.contains(r) || card_of.get(r) != Some(&i)) {
                    obstacles.push(card_rect(el));
                }
            }
            "frame" | "arrow" | "line" | "freedraw" => {}
            _ => {
                if let Some(r) = rect_of(el).filter(|r| r.w > 0.0 && r.h > 0.0) {
                    obstacles.push(r);
                }
            }
        }
    }
    let mut ordered: Vec<&String> = movers.iter().collect();
    ordered.sort_by(|a, b| pos[*a].0.total_cmp(&pos[*b].0).then(pos[*a].1.total_cmp(&pos[*b].1)));
    let mut shift: HashMap<usize, f64> = HashMap::new(); // per column: how far earlier cards were pushed
    for k in ordered {
        let (x, y0) = pos[k];
        let h = height(k);
        let ci = col[k].0;
        let mut y = y0 + shift.get(&ci).copied().unwrap_or(0.0);
        for _ in 0..10_000 {
            let me = Rect { x, y, w: CARD_W, h };
            let Some(o) = obstacles.iter().find(|o| me.overlaps(&o.grow(GAP))) else { break };
            y = o.bottom() + GAP;
        }
        shift.insert(ci, y - y0);
        let el = &mut els[card_of[k]];
        el.insert("x".into(), num(x));
        el.insert("y".into(), num(y));
        obstacles.push(Rect { x, y, w: CARD_W, h });
    }

    // Inner frames first, so an outer frame fits around them.
    let depth = |f: &str| {
        let (mut d, mut cur) = (0, f.to_string());
        while let Some(p) = parent.get(&cur).filter(|_| d < 32) {
            cur.clone_from(p);
            d += 1;
        }
        d
    };
    let mut frames: Vec<(usize, String)> =
        els.iter().filter(|e| el_type(e) == "frame").map(|e| (depth(el_id(e)), el_id(e).to_string())).collect();
    frames.sort_by_key(|f| std::cmp::Reverse(f.0));
    for (_, fid) in frames {
        fit_frame(els, &fid);
    }
    Ok(movers)
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
    /// Turn auto-layout of `board` on or off and save; turning it on arranges the board right away.
    pub fn set_board_auto_layout(&self, board: &str, on: bool) -> Result<Board> {
        check_board_name(board)?;
        let mut b = self.load_board(board)?;
        b.auto_layout = on;
        if on {
            layout_full(&mut b.elements, &self.load_stages()?)?;
        }
        self.save_board(board, &b)?;
        Ok(b)
    }

    /// Layered LR layout of the cards on `board` and save. `only_new` empty = full layout ([`layout_full`]:
    /// phases as column blocks, fewer crossings, pinned cards stay); otherwise only the cards of these stage keys
    /// move (others stay and act as obstacles). Frames that contained a moved card are refitted.
    /// Cycle among the cards -> `Error::Cycle`.
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
        if set.is_empty() {
            layout_full(&mut b.elements, &stages)?;
            self.save_board(board, &b)?;
            return Ok(b);
        }
        let moved = layout_elements(&mut b.elements, &stages, Some(&set), &HashMap::new())?;
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
