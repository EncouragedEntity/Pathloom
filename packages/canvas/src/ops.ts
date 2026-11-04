import type { Element, LinearElement, StageStatus } from './types';
import { elementCenter, isLinear } from './geometry';
import { keyAfter, keyBetween, compareIndex } from './index-key';
import type { Tool } from './editor-types';

/** Pure editor rules (frames, Execution mode, z-order, stage-card removal). No DOM; unit-tested. */

// ---- frames ----------------------------------------------------------------------------------

const area = (e: Element) => Math.abs(e.w * e.h);
const inside = (c: [number, number], f: Element) => c[0] >= f.x && c[0] <= f.x + f.w && c[1] >= f.y && c[1] <= f.y + f.h;

/**
 * New `frame` value per element: the innermost frame whose bounds contain the element centre (a frame can only
 * sit in a strictly larger frame). `only` limits the check to those ids. Returns just the elements whose value changes
 * (`undefined` = leaves its frame).
 */
export function computeFrames(els: readonly Element[], only?: ReadonlySet<string> | null): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  const frames = els.filter((e) => e.type === 'frame');
  for (const el of els) {
    if (only && !only.has(el.id)) continue;
    let best: Element | undefined;
    if (frames.length) {
      const c = elementCenter(el);
      for (const f of frames) {
        if (f.id === el.id || !inside(c, f)) continue;
        if (el.type === 'frame' && area(f) <= area(el)) continue;
        if (!best || area(f) < area(best)) best = f;
      }
    }
    if (best?.id !== el.frame) out.set(el.id, best?.id);
  }
  return out;
}

/** Ids of the members of the given frames, nested frames' members included. */
export function frameMembers(els: readonly Element[], frameIds: Iterable<string>): Set<string> {
  const out = new Set<string>();
  const todo = new Set(frameIds);
  while (todo.size) {
    const next = new Set<string>();
    for (const e of els) {
      if (e.frame && todo.has(e.frame) && !out.has(e.id)) { out.add(e.id); if (e.type === 'frame') next.add(e.id); }
    }
    todo.clear();
    for (const id of next) todo.add(id);
  }
  return out;
}

/** done/total over the `card` members of every frame (done = stage status 'done'). */
export function frameProgress(els: readonly Element[], status: (ref: string) => StageStatus | undefined): Map<string, { done: number; total: number }> {
  const out = new Map<string, { done: number; total: number }>();
  for (const e of els) {
    if (e.type !== 'card' || !e.frame) continue;
    const p = out.get(e.frame) ?? { done: 0, total: 0 };
    p.total++;
    if (status((e as { ref: string }).ref) === 'done') p.done++;
    out.set(e.frame, p);
  }
  return out;
}

/** Screen px of the frame title at normal zoom; below FRAME_LOD_SCALE it shrinks with the board like other text. */
export const FRAME_FONT_PX = 13;
export const FRAME_LOD_SCALE = 0.5;
export const frameFontWorld = (scale: number) => (scale >= FRAME_LOD_SCALE ? FRAME_FONT_PX / scale : FRAME_FONT_PX / FRAME_LOD_SCALE);

/** Header strip just above the frame's top-left corner (world units). */
export function frameHeaderRect(f: Element, scale: number): { x: number; y: number; w: number; h: number; fs: number } {
  const fs = frameFontWorld(scale), h = fs * 1.7, gap = fs * 0.3;
  return { x: f.x, y: f.y - gap - h, w: Math.max(f.w, fs * 8), h, fs };
}

// ---- Execution mode --------------------------------------------------------------------------

export type ExecAction =
  | 'select' | 'pan' | 'zoom' | 'toggleTask' | 'openStage'
  | 'create' | 'move' | 'resize' | 'delete' | 'edit' | 'link' | 'convert' | 'duplicate' | 'paste' | 'reorder' | 'lock' | 'undo' | 'rename';

const EXEC_OK = new Set<ExecAction>(['select', 'pan', 'zoom', 'toggleTask', 'openStage']);
/** Execution mode allows only viewing actions; every editing action is refused. */
export const execAllows = (a: ExecAction) => EXEC_OK.has(a);
export const execToolAllowed = (t: Tool) => t === 'select' || t === 'hand';

/** Draw opacity factor in Execution mode: done/blocked cards fade, other content fades more, frames stay. */
export function execAlpha(type: string, status: StageStatus | undefined): number {
  if (type === 'frame') return 1;
  if (type !== 'card') return 0.15;
  return status === 'done' ? 0.3 : status === 'ready' || status === 'active' ? 1 : 0.5;
}

// ---- z-order ---------------------------------------------------------------------------------

type Keyed = { id: string; index: string; type: string };

/**
 * New fractional keys that bring `ids` to the front / send them to the back, keeping their relative order.
 * Frames are ordered among themselves (they always render below everything else). Returns only changed keys;
 * empty when the selection is already at that end.
 */
export function reorderKeys(els: readonly Keyed[], ids: ReadonlySet<string>, dir: 'front' | 'back'): Map<string, string> {
  const sorted = [...els].sort(compareIndex);
  const out = new Map<string, string>();
  const group = (isFrame: boolean) => {
    const list = sorted.filter((e) => (e.type === 'frame') === isFrame);
    const sel = list.filter((e) => ids.has(e.id));
    if (!sel.length) return;
    const rest = list.filter((e) => !ids.has(e.id));
    if (!rest.length) return;
    let prev: string | null;
    if (dir === 'front') {
      if (list.slice(-sel.length).every((e) => ids.has(e.id))) return;
      const lo = rest[rest.length - 1].index;
      // frames must not jump above non-frame keys; others go after the very last key
      const above = isFrame ? sorted.find((e) => e.index > lo && !ids.has(e.id))?.index ?? null : null;
      prev = isFrame ? lo : sorted[sorted.length - 1].index;
      for (const e of sel) { prev = isFrame ? keyBetween(prev, above) : keyAfter(prev); out.set(e.id, prev); }
    } else {
      if (list.slice(0, sel.length).every((e) => ids.has(e.id))) return;
      const hi = rest[0].index;
      prev = null;
      for (const e of sel) { prev = keyBetween(prev, hi); out.set(e.id, prev); }
    }
  };
  group(true); group(false);
  return out;
}

// ---- stage cards -----------------------------------------------------------------------------

/** Arrows bound to any of `ids`, with those bindings dropped. */
export function unboundArrows(els: readonly Element[], ids: ReadonlySet<string>): LinearElement[] {
  const out: LinearElement[] = [];
  for (const el of els) {
    if (!isLinear(el)) continue;
    const s = !!el.start && ids.has(el.start.el), e = !!el.end && ids.has(el.end.el);
    if (!s && !e) continue;
    const n = { ...el };
    if (s) delete n.start;
    if (e) delete n.end;
    out.push(n);
  }
  return out;
}

/** What `removeStageCards(key)` changes: the cards to delete and the arrows to unbind from them. */
export function planRemoveStageCards(els: readonly Element[], key: string): { remove: Set<string>; arrows: LinearElement[] } {
  const remove = new Set(els.filter((e) => e.type === 'card' && (e as { ref: string }).ref === key).map((e) => e.id));
  return { remove, arrows: remove.size ? unboundArrows(els, remove).filter((a) => !remove.has(a.id)) : [] };
}
