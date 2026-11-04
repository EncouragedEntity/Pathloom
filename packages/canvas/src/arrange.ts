import type { Element } from './types';
import { elementBounds, unionBounds, type Bounds, type Point } from './geometry';
import type { Scene } from './scene';

/** Pure M4 rules: groups, align/distribute, grid + smart-guide snapping, eraser, image sizing, search. No DOM; unit-tested. */

// ---- groups ----------------------------------------------------------------------------------

/** `ids` plus every element that shares a `group` with one of them. */
export function expandGroups(els: readonly Element[], ids: Iterable<string>): Set<string> {
  const out = new Set(ids);
  const groups = new Set<string>();
  const byId = new Map(els.map((e) => [e.id, e]));
  for (const id of out) { const g = byId.get(id)?.group; if (g) groups.add(g); }
  if (groups.size) for (const e of els) if (e.group && groups.has(e.group)) out.add(e.id);
  return out;
}

/** Selected elements that can be grouped (unlocked); needs at least two. Empty map = nothing to do. */
export function groupUpdates(els: readonly Element[], ids: ReadonlySet<string>, groupId: string): Map<string, string> {
  const sel = els.filter((e) => ids.has(e.id) && !e.locked);
  if (sel.length < 2) return new Map();
  if (sel.every((e) => e.group && e.group === sel[0].group) && sel.length === els.filter((e) => e.group === sel[0].group).length) return new Map();
  return new Map(sel.map((e) => [e.id, groupId]));
}

/** Ids whose `group` should be dropped: every unlocked member of the groups the selection touches. */
export function ungroupIds(els: readonly Element[], ids: ReadonlySet<string>): Set<string> {
  const groups = new Set(els.filter((e) => ids.has(e.id) && e.group).map((e) => e.group!));
  return new Set(els.filter((e) => e.group && groups.has(e.group) && !e.locked).map((e) => e.id));
}

// ---- align / distribute ----------------------------------------------------------------------

export type AlignMode = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';

/** One thing that moves as a whole: a group (all its selected members) or a loose element. */
export interface Unit { key: string; ids: string[]; b: Bounds }

export function unitsOf(els: readonly Element[]): Unit[] {
  const by = new Map<string, Element[]>();
  for (const e of els) { const k = e.group ?? e.id; by.set(k, [...(by.get(k) ?? []), e]); }
  return [...by].map(([key, list]) => ({ key, ids: list.map((e) => e.id), b: unionBounds(list.map(elementBounds))! }));
}

/** Per-unit translation that aligns all units to the common edge/centre. Needs >= 2 units. */
export function alignDeltas(units: readonly Unit[], mode: AlignMode): Map<string, Point> {
  const out = new Map<string, Point>();
  if (units.length < 2) return out;
  const bs = units.map((u) => u.b);
  const minX = Math.min(...bs.map((b) => b.minX)), maxX = Math.max(...bs.map((b) => b.maxX));
  const minY = Math.min(...bs.map((b) => b.minY)), maxY = Math.max(...bs.map((b) => b.maxY));
  for (const u of units) {
    const { b } = u;
    let dx = 0, dy = 0;
    if (mode === 'left') dx = minX - b.minX;
    else if (mode === 'right') dx = maxX - b.maxX;
    else if (mode === 'center') dx = (minX + maxX) / 2 - (b.minX + b.maxX) / 2;
    else if (mode === 'top') dy = minY - b.minY;
    else if (mode === 'bottom') dy = maxY - b.maxY;
    else dy = (minY + maxY) / 2 - (b.minY + b.maxY) / 2;
    if (dx || dy) out.set(u.key, [dx, dy]);
  }
  return out;
}

/** Equal gaps between units along an axis; the two outermost stay put. Needs >= 3 units. */
export function distributeDeltas(units: readonly Unit[], axis: 'h' | 'v'): Map<string, Point> {
  const out = new Map<string, Point>();
  if (units.length < 3) return out;
  const lo = (b: Bounds) => (axis === 'h' ? b.minX : b.minY), hi = (b: Bounds) => (axis === 'h' ? b.maxX : b.maxY);
  const sorted = [...units].sort((a, c) => lo(a.b) - lo(c.b));
  const span = Math.max(...sorted.map((u) => hi(u.b))) - lo(sorted[0].b);
  const gap = (span - sorted.reduce((s, u) => s + hi(u.b) - lo(u.b), 0)) / (sorted.length - 1);
  let pos = lo(sorted[0].b);
  for (const u of sorted) {
    const d = pos - lo(u.b);
    if (d) out.set(u.key, axis === 'h' ? [d, 0] : [0, d]);
    pos += hi(u.b) - lo(u.b) + gap;
  }
  return out;
}

// ---- snapping --------------------------------------------------------------------------------

export const GRID = 20;
export const snapGrid = (v: number, size = GRID) => Math.round(v / size) * size;
export const snapPoint = (p: Point, size = GRID): Point => [snapGrid(p[0], size), snapGrid(p[1], size)];
/** Translation that puts the top-left corner of `b`, moved by (dx,dy), on the grid. */
export function snapMove(b: Bounds, dx: number, dy: number, size = GRID): Point {
  return [snapGrid(b.minX + dx, size) - b.minX, snapGrid(b.minY + dy, size) - b.minY];
}

/** An alignment guide in world units: a vertical (axis 'x') or horizontal ('y') line at `pos` spanning from..to. */
export interface Guide { axis: 'x' | 'y'; pos: number; from: number; to: number }

const lines = (b: Bounds, axis: 'x' | 'y') => (axis === 'x' ? [b.minX, (b.minX + b.maxX) / 2, b.maxX] : [b.minY, (b.minY + b.maxY) / 2, b.maxY]);

/**
 * Smart guides: offset (dx,dy) to add to `moving` so one of its edges/centres lines up with an edge/centre of one
 * of `others`, if within `tol` (world units); plus the guide lines at the snapped position.
 */
export function findSnap(moving: Bounds, others: readonly Bounds[], tol: number): { dx: number; dy: number; guides: Guide[] } {
  const best = { x: { d: Infinity }, y: { d: Infinity } };
  for (const axis of ['x', 'y'] as const) {
    const mine = lines(moving, axis);
    for (const o of others) {
      for (const t of lines(o, axis)) for (const m of mine) {
        const d = t - m;
        if (Math.abs(d) < Math.abs(best[axis].d)) best[axis] = { d };
      }
    }
  }
  const dx = Math.abs(best.x.d) <= tol ? best.x.d : 0, dy = Math.abs(best.y.d) <= tol ? best.y.d : 0;
  const m: Bounds = { minX: moving.minX + dx, maxX: moving.maxX + dx, minY: moving.minY + dy, maxY: moving.maxY + dy };
  const guides: Guide[] = [];
  const eps = 0.5;
  for (const axis of ['x', 'y'] as const) {
    if (Math.abs(best[axis].d) > tol) continue; // nothing within reach on this axis
    const mine = lines(m, axis);
    for (const o of others) {
      for (const t of lines(o, axis)) {
        if (!mine.some((v) => Math.abs(v - t) <= eps)) continue;
        const [a0, a1] = axis === 'x' ? [Math.min(m.minY, o.minY), Math.max(m.maxY, o.maxY)] : [Math.min(m.minX, o.minX), Math.max(m.maxX, o.maxX)];
        const g = guides.find((q) => q.axis === axis && Math.abs(q.pos - t) <= eps);
        if (g) { g.from = Math.min(g.from, a0); g.to = Math.max(g.to, a1); } else guides.push({ axis, pos: t, from: a0, to: a1 });
      }
    }
  }
  return { dx, dy, guides };
}

/** Bounds of snap targets near `around`: everything but frames and `exclude`, nearest `cap` kept. */
export function guideCandidates(scene: Scene, around: Bounds, reach: number, exclude: ReadonlySet<string>, cap = 300): Bounds[] {
  const q = { minX: around.minX - reach, minY: around.minY - reach, maxX: around.maxX + reach, maxY: around.maxY + reach };
  const out: Bounds[] = [];
  for (const e of scene.query(q)) {
    if (e.type === 'frame' || exclude.has(e.id)) continue;
    out.push(elementBounds(e));
    if (out.length >= cap) break;
  }
  return out;
}

// ---- eraser ----------------------------------------------------------------------------------

/** Frames are never erased by a sweep (their border is easy to cross); locked elements never. */
export const erasable = (e: Element) => !e.locked && e.type !== 'frame';

/** Elements under the segment a->b (sampled every <= `step` world units), topmost first per sample. */
export function sweepHits(scene: Scene, a: Point, b: Point, tol: number, step = tol): Element[] {
  const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / Math.max(step, 1e-6)));
  const seen = new Map<string, Element>();
  for (let i = 0; i <= n; i++) {
    const p: Point = [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n];
    const hit = scene.hit(p, tol, erasable);
    if (hit) seen.set(hit.id, hit);
  }
  return [...seen.values()];
}

// ---- images ----------------------------------------------------------------------------------

export const IMAGE_MAX = 800;

/** Natural size capped at `max` on the long side (never upscaled); degenerate input gives a small square. */
export function imageFit(nw: number, nh: number, max = IMAGE_MAX): { w: number; h: number } {
  if (!(nw > 0) || !(nh > 0)) return { w: 160, h: 160 };
  const k = Math.min(1, max / Math.max(nw, nh));
  return { w: Math.max(1, nw * k), h: Math.max(1, nh * k) };
}

// ---- search ----------------------------------------------------------------------------------

interface SearchStage { key: string; title: string; tasks: { title: string; sub: SearchStage['tasks'] }[] }

function taskTitles(tasks: SearchStage['tasks'], out: string[]) {
  for (const t of tasks) { out.push(t.title); taskTitles(t.sub, out); }
}

/** Ids (z-order) of elements whose text / label / frame name / stage key, title or task titles contain `query` (case-insensitive). */
export function findElements(els: readonly Element[], stageOf: (ref: string) => SearchStage | undefined, query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: string[] = [];
  for (const e of els) {
    const hay: string[] = [];
    const any = e as { text?: string; name?: string; ref?: string };
    if (any.text) hay.push(any.text);
    if (any.name) hay.push(any.name);
    if (e.type === 'card' && any.ref) {
      const s = stageOf(any.ref);
      if (s) { hay.push(s.key, s.title); taskTitles(s.tasks, hay); }
    }
    if (hay.some((h) => h.toLowerCase().includes(q))) out.push(e.id);
  }
  return out;
}

// ---- text wrapping (sticky notes) ------------------------------------------------------------

export const STICKY_PAD = 12;
export const STICKY_LINE = 1.25;

/** Greedy word wrap of every paragraph to `maxW`; words longer than a line are split by characters. */
export function wrapLines(text: string, maxW: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  const flush = (line: string) => {
    let cur = line.trimEnd();
    while (cur.length > 1 && measure(cur) > maxW) {
      let k = cur.length - 1;
      while (k > 1 && measure(cur.slice(0, k)) > maxW) k--;
      out.push(cur.slice(0, k)); cur = cur.slice(k);
    }
    out.push(cur);
  };
  for (const para of text.split('\n')) {
    let cur = '';
    for (const word of para.split(/(?<=\s)/)) {
      if (cur && measure((cur + word).trimEnd()) > maxW) { flush(cur); cur = word; } else cur += word;
    }
    flush(cur);
  }
  return out;
}

/** Height a sticky needs for `lineCount` lines of `size` px text. */
export const stickyNeeded = (lineCount: number, size: number) => lineCount * size * STICKY_LINE + STICKY_PAD * 2;
