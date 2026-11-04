import type { Bounds } from './geometry';
import { unionBounds } from './geometry';
import type { Ghost, StageView } from './types';
import { cardW, type CardRect } from './stage';

/** Pure helpers for highlights, ghost cards and live reload (unit-tested). */

export interface Highlight { start: number; ms: number }

/** Add/restart highlights; repeated keys restart their timer (and take the new duration). */
export function addHighlights(map: Map<string, Highlight>, keys: string[], now: number, ms: number): void {
  for (const k of keys) map.set(k, { start: now, ms });
}

/** 1 -> 0 over the duration, ease-out (fast drop, slow tail). */
export function highlightAlpha(h: Highlight, now: number): number {
  const p = Math.min(1, Math.max(0, (now - h.start) / Math.max(1, h.ms)));
  return (1 - p) * (1 - p);
}

/** Drop expired entries; returns true while any remain (keep animating). */
export function pruneHighlights(map: Map<string, Highlight>, now: number): boolean {
  for (const [k, h] of map) if (now - h.start >= h.ms) map.delete(k);
  return map.size > 0;
}

export interface GhostEdge { from: string; to: string; soft: boolean }

/**
 * Dependency edges that touch a ghost. `from` = dependency, `to` = dependent (like DepEdge).
 * - ghost depends on a real card or another ghost: from -> ghost
 * - a real stage already lists a ghost key in `depends`: ghost -> card
 * Only endpoints that have a card (real on board, or ghost) are kept.
 */
export function ghostEdges(ghosts: Ghost[], stages: Iterable<StageView>, onBoard: ReadonlySet<string>): GhostEdge[] {
  const gKeys = new Set(ghosts.map((g) => g.stage.key));
  const has = (k: string) => onBoard.has(k) || gKeys.has(k);
  const out: GhostEdge[] = [];
  for (const g of ghosts) {
    for (const d of g.stage.depends) if (d.id !== g.stage.key && has(d.id)) out.push({ from: d.id, to: g.stage.key, soft: d.soft });
  }
  for (const s of stages) {
    if (!onBoard.has(s.key) || gKeys.has(s.key)) continue;
    for (const d of s.depends) if (gKeys.has(d.id)) out.push({ from: d.id, to: s.key, soft: d.soft });
  }
  return out;
}

export const ghostRect = (g: Ghost, h: number): CardRect => ({ x: g.x, y: g.y, w: cardW(g.stage), h });

/** Bounds of scene content plus ghost cards (zoomToFit). */
export function boundsWithGhosts(base: Bounds[], ghosts: Ghost[], heightOf: (s: StageView) => number): Bounds | null {
  return unionBounds([...base, ...ghosts.map((g) => ({ minX: g.x, minY: g.y, maxX: g.x + cardW(g.stage), maxY: g.y + heightOf(g.stage) }))]);
}

/** Selection to keep across setBoard(keepCamera): only ids that still exist. */
export const keepSelection = (selected: ReadonlySet<string>, ids: ReadonlySet<string>): Set<string> =>
  new Set([...selected].filter((id) => ids.has(id)));
