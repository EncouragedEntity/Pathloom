import { describe, expect, it } from 'vitest';
import type { Element } from '../src/types';
import {
  computeFrames, execAlpha, execAllows, execToolAllowed, frameFontWorld, frameMembers, frameProgress, planRemoveStageCards,
  reorderKeys, unboundArrows, type ExecAction,
} from '../src/ops';
import { compareIndex, keyAfter } from '../src/index-key';

const box = (id: string, x: number, y: number, w: number, h: number, extra: object = {}, type = 'rect') =>
  ({ id, type, x, y, w, h, index: id, ...extra }) as unknown as Element;
const frame = (id: string, x: number, y: number, w: number, h: number, extra: object = {}) => box(id, x, y, w, h, { name: id, ...extra }, 'frame');
const card = (id: string, ref: string, x: number, y: number, extra: object = {}) => box(id, x, y, 250, 100, { ref, ...extra }, 'card');

describe('frame membership', () => {
  it('assigns by element centre', () => {
    const els = [frame('F', 0, 0, 100, 100), box('in', 80, 40, 40, 20), box('out', 95, 10, 40, 20)];
    const m = computeFrames(els);
    expect(m.get('in')).toBe('F'); // centre (100,50) is on the edge: inside
    expect(m.has('out')).toBe(false); // centre (115,20) is outside, no frame to leave
  });
  it('innermost frame wins and a frame needs a larger parent', () => {
    const els = [frame('big', 0, 0, 400, 400), frame('small', 50, 50, 100, 100), box('x', 60, 60, 20, 20)];
    const m = computeFrames(els);
    expect(m.get('x')).toBe('small');
    expect(m.get('small')).toBe('big');
    expect(m.has('big')).toBe(false); // big never nests in small
  });
  it('reports leaving and re-parenting, nothing when unchanged', () => {
    const els = [frame('A', 0, 0, 100, 100), frame('B', 200, 0, 100, 100), box('m', 10, 10, 20, 20, { frame: 'A' }), box('n', 210, 10, 20, 20, { frame: 'B' }), box('o', 500, 500, 10, 10, { frame: 'A' })];
    const m = computeFrames(els);
    expect(m.has('m')).toBe(false);
    expect(m.has('n')).toBe(false);
    expect(m.has('o') && m.get('o')).toBeUndefined();
    expect(m.has('o')).toBe(true);
  });
  it('`only` limits the check', () => {
    const els = [frame('F', 0, 0, 100, 100), box('a', 10, 10, 10, 10), box('b', 20, 20, 10, 10)];
    expect([...computeFrames(els, new Set(['a'])).keys()]).toEqual(['a']);
  });
  it('frameMembers is recursive', () => {
    const els = [frame('A', 0, 0, 500, 500), frame('B', 10, 10, 200, 200, { frame: 'A' }), box('x', 20, 20, 5, 5, { frame: 'B' }), box('y', 300, 300, 5, 5, { frame: 'A' }), box('z', 900, 900, 5, 5)];
    expect([...frameMembers(els, ['A'])].sort()).toEqual(['B', 'x', 'y']);
    expect([...frameMembers(els, ['B'])]).toEqual(['x']);
  });
  it('progress counts only card members, done = status done', () => {
    const els = [frame('F', 0, 0, 900, 900), card('c1', 'S1', 0, 0, { frame: 'F' }), card('c2', 'S2', 0, 0, { frame: 'F' }), card('c3', 'S3', 0, 0, { frame: 'F' }), card('c4', 'S1', 0, 0), box('r', 0, 0, 5, 5, { frame: 'F' })];
    const st: Record<string, 'done' | 'active' | 'ready'> = { S1: 'done', S2: 'active', S3: 'ready' };
    const p = frameProgress(els, (r) => st[r]);
    expect(p.get('F')).toEqual({ done: 1, total: 3 });
    expect(p.size).toBe(1);
  });
  it('header font is screen-constant at normal zoom and shrinks below the LOD scale', () => {
    expect(frameFontWorld(1) * 1).toBe(13);
    expect(frameFontWorld(2) * 2).toBeCloseTo(13);
    expect(frameFontWorld(0.5) * 0.5).toBeCloseTo(13);
    expect(frameFontWorld(0.25) * 0.25).toBeLessThan(13);
  });
});

describe('Execution mode permissions', () => {
  const blocked: ExecAction[] = ['create', 'move', 'resize', 'delete', 'edit', 'link', 'convert', 'duplicate', 'paste', 'reorder', 'lock', 'undo', 'rename'];
  const allowed: ExecAction[] = ['select', 'pan', 'zoom', 'toggleTask', 'openStage'];
  it('blocks every editing action', () => { for (const a of blocked) expect(execAllows(a), a).toBe(false); });
  it('allows viewing actions', () => { for (const a of allowed) expect(execAllows(a), a).toBe(true); });
  it('only select and hand tools stay enabled', () => {
    expect(execToolAllowed('select')).toBe(true);
    expect(execToolAllowed('hand')).toBe(true);
    for (const t of ['rect', 'ellipse', 'diamond', 'arrow', 'line', 'pencil', 'text', 'stage', 'frame'] as const) expect(execToolAllowed(t), t).toBe(false);
  });
  it('dims by class', () => {
    expect(execAlpha('card', 'done')).toBe(0.3);
    expect(execAlpha('card', 'blocked')).toBe(0.5);
    expect(execAlpha('card', 'ready')).toBe(1);
    expect(execAlpha('card', 'active')).toBe(1);
    expect(execAlpha('rect', undefined)).toBe(0.15);
    expect(execAlpha('arrow', undefined)).toBe(0.15);
    expect(execAlpha('frame', undefined)).toBe(1);
  });
});

describe('z-order keys', () => {
  const mk = (...ids: string[]) => { let k: string | null = null; return ids.map((id) => { k = keyAfter(k); return box(id, 0, 0, 1, 1, { index: k }); }); };
  const order = (els: Element[], m: Map<string, string>) => els.map((e) => ({ ...e, index: m.get(e.id) ?? e.index })).sort(compareIndex).map((e) => e.id);
  it('bring to front keeps relative order', () => {
    const els = mk('a', 'b', 'c', 'd');
    const m = reorderKeys(els, new Set(['a', 'b']), 'front');
    expect(order(els, m)).toEqual(['c', 'd', 'a', 'b']);
    expect(m.size).toBe(2);
  });
  it('send to back keeps relative order', () => {
    const els = mk('a', 'b', 'c', 'd');
    expect(order(els, reorderKeys(els, new Set(['c', 'd']), 'back'))).toEqual(['c', 'd', 'a', 'b']);
  });
  it('nothing changes when already at that end, or when everything is selected', () => {
    const els = mk('a', 'b', 'c');
    expect(reorderKeys(els, new Set(['c']), 'front').size).toBe(0);
    expect(reorderKeys(els, new Set(['a']), 'back').size).toBe(0);
    expect(reorderKeys(els, new Set(['a', 'b', 'c']), 'front').size).toBe(0);
  });
  it('repeated reorders stay sortable', () => {
    let els = mk('a', 'b', 'c');
    for (let i = 0; i < 30; i++) {
      const m = reorderKeys(els, new Set([i % 2 ? 'a' : 'c']), i % 3 ? 'back' : 'front');
      els = els.map((e) => ({ ...e, index: m.get(e.id) ?? e.index }));
    }
    expect(new Set(els.map((e) => e.index)).size).toBe(3);
  });
  it('frames are reordered among frames only', () => {
    const els = [box('f1', 0, 0, 1, 1, { index: 'a0' }, 'frame'), box('f2', 0, 0, 1, 1, { index: 'a1' }, 'frame'), box('x', 0, 0, 1, 1, { index: 'a2' }), box('y', 0, 0, 1, 1, { index: 'a3' })];
    const m = reorderKeys(els, new Set(['f1']), 'front');
    expect(order(els, m)).toEqual(['f2', 'f1', 'x', 'y']); // f1 above f2, still under the non-frames
    const m2 = reorderKeys(els, new Set(['y']), 'back');
    expect(order(els, m2).indexOf('y')).toBeLessThan(order(els, m2).indexOf('x'));
  });
  it('mixed selection moves each group on its own', () => {
    const els = [box('f1', 0, 0, 1, 1, { index: 'a0' }, 'frame'), box('f2', 0, 0, 1, 1, { index: 'a1' }, 'frame'), box('x', 0, 0, 1, 1, { index: 'a2' }), box('y', 0, 0, 1, 1, { index: 'a3' })];
    const m = reorderKeys(els, new Set(['f1', 'x']), 'front');
    expect(order(els, m)).toEqual(['f2', 'f1', 'y', 'x']);
  });
});

describe('removeStageCards plan', () => {
  const arrow = (id: string, start?: string, end?: string) => box(id, 0, 0, 10, 0, { points: [[0, 0], [10, 0]], ...(start ? { start: { el: start } } : {}), ...(end ? { end: { el: end } } : {}) }, 'arrow');
  it('removes only the cards of that stage', () => {
    const els = [card('c1', 'A', 0, 0), card('c2', 'B', 0, 0), box('r', 0, 0, 1, 1)];
    const p = planRemoveStageCards(els, 'A');
    expect([...p.remove]).toEqual(['c1']);
  });
  it('unbinds arrows attached to the removed cards, keeps other bindings', () => {
    const els = [card('c1', 'A', 0, 0), card('c2', 'B', 0, 0), arrow('a1', 'c1', 'c2'), arrow('a2', 'c2', 'c1'), arrow('a3', 'c2')];
    const p = planRemoveStageCards(els, 'A');
    const byId = Object.fromEntries(p.arrows.map((a) => [a.id, a]));
    expect(Object.keys(byId).sort()).toEqual(['a1', 'a2']);
    expect(byId.a1.start).toBeUndefined();
    expect(byId.a1.end).toEqual({ el: 'c2' });
    expect(byId.a2.end).toBeUndefined();
    expect(byId.a2.start).toEqual({ el: 'c2' });
  });
  it('unknown stage is a no-op', () => {
    const p = planRemoveStageCards([card('c1', 'A', 0, 0)], 'Z');
    expect(p.remove.size).toBe(0);
    expect(p.arrows).toEqual([]);
  });
  it('unboundArrows does not mutate its input', () => {
    const a = arrow('a', 'c1');
    unboundArrows([a], new Set(['c1']));
    expect((a as unknown as { start: unknown }).start).toEqual({ el: 'c1' });
  });
});
