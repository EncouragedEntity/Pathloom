// Which dependency arrows to draw and how: hide redundant ones, bundle arrows between frames (phases),
// and focus on one card's chain. Pure functions; the editor caches the result.
import type { DepEdge } from './stage';

export const edgeKey = (e: { from: string; to: string }) => `${e.from}>${e.to}`;

/**
 * Arrows implied by others: A→C is redundant when A reaches C through 2+ other arrows (A→B→C).
 * A hard arrow is redundant only through hard arrows (otherwise it would hide a real block).
 */
export function redundantEdges(edges: readonly DepEdge[]): Set<string> {
  const out = new Set<string>();
  const next = (soft: boolean) => {
    const m = new Map<string, string[]>();
    for (const e of edges) if (soft || !e.soft) (m.get(e.from) ?? m.set(e.from, []).get(e.from)!).push(e.to);
    return m;
  };
  const all = next(true), hard = next(false);
  for (const e of edges) {
    const adj = e.soft ? all : hard;
    // start from the other successors of e.from, so the direct arrow itself is not the path
    const stack = (adj.get(e.from) ?? []).filter((t) => t !== e.to);
    const seen = new Set(stack);
    let found = false;
    while (stack.length && !found) {
      const n = stack.pop()!;
      for (const t of adj.get(n) ?? []) {
        if (t === e.to) { found = true; break; }
        if (!seen.has(t)) { seen.add(t); stack.push(t); }
      }
    }
    if (found) out.add(edgeKey(e));
  }
  return out;
}

/** Everything `key` waits for (upstream) and everything waiting for it (downstream), plus the arrows between them. */
export function chainOf(key: string, edges: readonly DepEdge[]): { nodes: Set<string>; edges: Set<string> } {
  const walk = (dir: 'up' | 'down') => {
    const seen = new Set<string>([key]);
    const stack = [key];
    while (stack.length) {
      const n = stack.pop()!;
      for (const e of edges) {
        const [a, b] = dir === 'up' ? [e.to, e.from] : [e.from, e.to];
        if (a === n && !seen.has(b)) { seen.add(b); stack.push(b); }
      }
    }
    return seen;
  };
  const up = walk('up'), down = walk('down');
  const nodes = new Set([...up, ...down]);
  const keys = new Set<string>();
  for (const e of edges) if ((up.has(e.from) && up.has(e.to)) || (down.has(e.from) && down.has(e.to))) keys.add(edgeKey(e));
  return { nodes, edges: keys };
}

export interface EdgeBundle {
  fromFrame: string;
  toFrame: string;
  edges: DepEdge[];
}

/** Arrows from one frame to another, grouped when there are at least `min` of them. */
export function bundleEdges(edges: readonly DepEdge[], frameOf: (key: string) => string | undefined, min = 2): EdgeBundle[] {
  const m = new Map<string, EdgeBundle>();
  for (const e of edges) {
    const a = frameOf(e.from), b = frameOf(e.to);
    if (!a || !b || a === b) continue;
    const k = `${a}>${b}`;
    (m.get(k) ?? m.set(k, { fromFrame: a, toFrame: b, edges: [] }).get(k)!).edges.push(e);
  }
  return [...m.values()].filter((b) => b.edges.length >= min);
}

export interface EdgeOptions {
  /** Hide A→C when A→B→C exists. */
  hideRedundant: boolean;
  /** Draw arrows between two frames as one thick arrow with a count. */
  bundle: boolean;
}

export interface EdgeView {
  /** Arrows drawn on their own (not hidden, not part of a bundle). */
  visible: DepEdge[];
  bundles: EdgeBundle[];
  /** Hovered or selected card: its chain is highlighted, everything else fades. */
  focus: { key: string; nodes: Set<string>; edges: Set<string> } | null;
}

export function edgeView(edges: readonly DepEdge[], opts: EdgeOptions, frameOf: (key: string) => string | undefined, focusKey: string | null): EdgeView {
  const redundant = opts.hideRedundant ? redundantEdges(edges) : new Set<string>();
  const shown = edges.filter((e) => !redundant.has(edgeKey(e)));
  const focus = focusKey ? { key: focusKey, ...chainOf(focusKey, shown) } : null;
  if (!opts.bundle) return { visible: shown, bundles: [], focus };
  const bundles = bundleEdges(shown, frameOf);
  const inBundle = new Set(bundles.flatMap((b) => b.edges.map(edgeKey)));
  // a focused chain is always drawn arrow by arrow
  const visible = shown.filter((e) => !inBundle.has(edgeKey(e)) || focus?.edges.has(edgeKey(e)));
  return { visible, bundles, focus };
}

/** Vertical push so no card overlaps a card that grew: cards below a grown card (and below them) move down. */
export function pushApart(rects: readonly { id: string; x: number; y: number; w: number; h: number }[], grown: Iterable<string>, gap = 20): Map<string, number> {
  const r = new Map(rects.map((c) => [c.id, { ...c }]));
  const moved = new Map<string, number>();
  const queue = [...grown].filter((id) => r.has(id));
  for (let guard = 0; queue.length && guard < 10_000; guard++) {
    const g = r.get(queue.shift()!)!;
    for (const c of r.values()) {
      if (c.id === g.id || c.x >= g.x + g.w || g.x >= c.x + c.w) continue;
      if (c.y < g.y || c.y >= g.y + g.h + gap) continue;
      c.y = g.y + g.h + gap;
      moved.set(c.id, c.y);
      queue.push(c.id);
    }
  }
  return moved;
}
