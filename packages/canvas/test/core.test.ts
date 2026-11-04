import { describe, expect, it } from 'vitest';
import type { Element, StageView, ThemeTokens } from '../src/types';
import { clampScale, fitBounds, screenToWorld, worldToScreen, zoomAt } from '../src/camera';
import { compareIndex, keyAfter, keyBetween } from '../src/index-key';
import { History } from '../src/history';
import { CARD, CARD_W, cardLayout, edgeCurve, extractEdges, hitCheckbox, mixColors, statusColors, withAlpha, wrapText } from '../src/stage';
import { Scene } from '../src/scene';
import { newId } from '../src/id';

describe('camera', () => {
  const cam = { x: 100, y: 50, scale: 2 };
  it('screen <-> world round trip', () => {
    const w = screenToWorld(cam, [300, 250]);
    expect(w).toEqual([100, 100]);
    expect(worldToScreen(cam, w)).toEqual([300, 250]);
  });
  it('zoomAt keeps the point under the cursor fixed', () => {
    const p: [number, number] = [412, 187];
    const before = screenToWorld(cam, p);
    const next = zoomAt(cam, 0.8, p);
    const after = screenToWorld(next, p);
    expect(after[0]).toBeCloseTo(before[0]); expect(after[1]).toBeCloseTo(before[1]);
    expect(next.scale).toBe(0.8);
  });
  it('clamps zoom to 0.1..4', () => {
    expect(clampScale(50)).toBe(4);
    expect(clampScale(0.001)).toBe(0.1);
    expect(zoomAt(cam, 100, [0, 0]).scale).toBe(4);
  });
  it('fitBounds centres content', () => {
    const c = fitBounds({ minX: 0, minY: 0, maxX: 1000, maxY: 500 }, 1000, 600, 50, 1);
    expect(c.scale).toBeCloseTo(0.9);
    const mid = worldToScreen(c, [500, 250]);
    expect(mid[0]).toBeCloseTo(500); expect(mid[1]).toBeCloseTo(300);
    expect(fitBounds(null, 800, 600).scale).toBe(1);
  });
});

describe('fractional index', () => {
  it('keyAfter is strictly increasing', () => {
    let k = keyAfter(null);
    for (let i = 0; i < 200; i++) { const n = keyAfter(k); expect(n > k).toBe(true); k = n; }
  });
  it('keyAfter keeps keys short over thousands of appends', () => {
    let k: string | null = null;
    for (let i = 0; i < 5000; i++) { const n = keyAfter(k); expect(k === null || n > k).toBe(true); k = n; }
    expect(k!.length).toBeLessThanOrEqual(4);
    expect(keyAfter('Vz') > 'Vz').toBe(true);
    expect(keyAfter('zz') > 'zz').toBe(true);
  });
  it('keyBetween stays between, even when repeatedly bisecting', () => {
    let a = keyAfter(null), b = keyAfter(a);
    for (let i = 0; i < 60; i++) {
      const m = keyBetween(a, b);
      expect(m > a && m < b).toBe(true);
      if (i % 2) a = m; else b = m;
    }
  });
  it('keyBefore (null lower bound) works and foreign keys do not throw', () => {
    const first = keyAfter(null);
    expect(keyBetween(null, first) < first).toBe(true);
    expect(keyAfter('a0') > 'a0').toBe(true);
    expect(keyAfter('a1') > 'a1').toBe(true);
  });
  it('compareIndex orders by index then id', () => {
    const list = [{ index: 'b', id: '1' }, { index: 'a', id: '2' }, { index: 'a', id: '1' }].sort(compareIndex);
    expect(list.map((x) => x.index + x.id)).toEqual(['a1', 'a2', 'b1']);
  });
  it('ids are 11 chars, unique', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId()));
    expect(ids.size).toBe(500);
    expect([...ids][0]).toMatch(/^e[0-9a-z]{10}$/);
  });
});

describe('history', () => {
  const el = (x: number): Element => ({ id: 'a', type: 'rect', x, y: 0, w: 1, h: 1, index: 'a' });
  it('undo/redo apply before/after, new push clears redo', () => {
    const h = new History();
    expect(h.undo()).toBeNull();
    h.push({ changes: [{ id: 'a', before: null, after: el(1) }] });
    h.push({ changes: [{ id: 'a', before: el(1), after: el(2) }] });
    expect(h.canUndo).toBe(true);
    expect(h.undo()!.changes[0].before).toEqual(el(1));
    expect(h.canRedo).toBe(true);
    expect(h.redo()!.changes[0].after).toEqual(el(2));
    h.undo();
    h.push({ changes: [{ id: 'a', before: el(1), after: el(9) }] });
    expect(h.canRedo).toBe(false);
  });
  it('ignores empty entries and respects the limit', () => {
    const h = new History(2);
    h.push({ changes: [] });
    expect(h.canUndo).toBe(false);
    for (let i = 0; i < 5; i++) h.push({ changes: [{ id: 'a', before: null, after: el(i) }] });
    h.undo(); h.undo();
    expect(h.undo()).toBeNull();
  });
});

const stage = (o: Partial<StageView> = {}): StageView => ({
  key: 'M0', title: 'Core', kind: 'stage', who: 'ai', due: null, priority: 'med', branch: null, pr: null, tags: [],
  depends: [], description: '', tasks: [], comments: [], status: 'ready', progress: [0, 0], ...o,
});
const task = (id: string, done = false) => ({ id, title: id, done, sub: [] });
const m7 = (s: string) => s.length * 7;

describe('card layout', () => {
  it('height grows by one row per task', () => {
    const h0 = cardLayout(stage(), m7).h;
    const h3 = cardLayout(stage({ tasks: [task('a'), task('b'), task('c')] }), m7).h;
    // progress -> first row gap, then 3 rows with gaps between
    expect(h3 - h0).toBe(CARD.progGap + 3 * CARD.taskH + 2 * CARD.taskGap);
    const h4 = cardLayout(stage({ tasks: [task('a'), task('b'), task('c'), task('d')] }), m7).h;
    expect(h4 - h3).toBe(CARD.taskH + CARD.taskGap);
  });
  it('exact height without tasks/footer', () => {
    const l = cardLayout(stage(), m7, 20);
    expect(l.h).toBe(CARD.padTop + CARD.headH + CARD.headGap + 20 + CARD.titleGap + CARD.progH + CARD.padBottom);
  });
  it('footer only with due/high priority/branch', () => {
    const plain = cardLayout(stage(), m7).h;
    for (const o of [{ due: 'Nov 5' }, { priority: 'high' as const }, { branch: 'feat/x' }]) {
      expect(cardLayout(stage(o), m7).h - plain).toBe(CARD.footTop + 1 + CARD.footPad + CARD.footH);
    }
  });
  it('caps visible tasks and adds a "more" row', () => {
    const tasks = Array.from({ length: 20 }, (_, i) => task('T' + i));
    const l = cardLayout(stage({ tasks }), m7);
    expect(l.tasks.length).toBe(CARD.maxTasks);
    expect(l.hiddenTasks).toBe(8);
  });
  it('long titles wrap to at most two lines', () => {
    const l = cardLayout(stage({ title: 'word '.repeat(60) }), m7);
    expect(l.titleLines.length).toBe(2);
    expect(l.titleLines[1].endsWith('…')).toBe(true);
    expect(wrapText('short', 200, m7, 2)).toEqual(['short']);
  });
  it('checkbox hit-test', () => {
    const l = cardLayout(stage({ tasks: [task('A-1'), task('A-2')] }), m7);
    const row2 = l.tasks[1];
    expect(hitCheckbox(l, CARD.padX + 8, row2.y + 11)).toBe('A-2');
    expect(hitCheckbox(l, 120, row2.y + 11)).toBeNull();
    expect(hitCheckbox(l, CARD.padX + 8, 2)).toBeNull();
  });
});

describe('dependency edges', () => {
  const stages = [
    stage({ key: 'A', status: 'done' }),
    stage({ key: 'B', depends: [{ id: 'A', soft: false }, { id: 'X', soft: false }, { id: 'C', soft: true }] }),
    stage({ key: 'C' }),
    stage({ key: 'D', depends: [{ id: 'A', soft: false }] }),
  ];
  it('keeps only edges with both cards on the board, with soft flag and source state', () => {
    const e = extractEdges(stages, new Set(['A', 'B', 'C']));
    expect(e).toEqual([
      { from: 'A', to: 'B', soft: false, fromDone: true },
      { from: 'C', to: 'B', soft: true, fromDone: false },
    ]);
  });
  it('no cards -> no edges; missing stage ignored', () => {
    expect(extractEdges(stages, new Set())).toEqual([]);
    expect(extractEdges(stages, new Set(['B', 'ZZ']))).toEqual([]);
  });
  it('curve goes from right-middle to left-middle', () => {
    const c = edgeCurve({ x: 0, y: 0, w: CARD_W, h: 100 }, { x: 400, y: 200, w: CARD_W, h: 60 });
    expect(c[0]).toEqual([CARD_W, 50]);
    expect(c[3]).toEqual([400, 230]);
    expect(c[1][0]).toBeGreaterThan(c[0][0]);
    expect(c[2][0]).toBeLessThan(c[3][0]);
  });
});

describe('status colours', () => {
  const t = { ok: '#4cc38a', warn: '#e8b04a', accent: '#9b87f5', muted: '#7d769a', card2: '#221e31' } as ThemeTokens;
  it('maps statuses to theme tokens', () => {
    expect(statusColors('done', t).fg).toBe(t.ok);
    expect(statusColors('active', t).fg).toBe(t.warn);
    expect(statusColors('ready', t).fg).toBe(t.accent);
    expect(statusColors('blocked', t)).toEqual({ fg: t.muted, bg: t.card2 });
  });
  it('alpha and mix helpers', () => {
    expect(withAlpha('#ff0000', 0.5)).toBe('rgba(255,0,0,0.5)');
    expect(statusColors('done', t).bg).toBe('rgba(76,195,138,0.16)');
    expect(mixColors('#ffffff', '#000000', 0.5)).toBe('#808080');
  });
});

describe('scene', () => {
  const r = (id: string, x: number, index: string, extra: object = {}): Element => ({ id, type: 'rect', x, y: 0, w: 10, h: 10, index, fill: '#fff', ...extra } as Element);
  it('orders by index, culls with the spatial index, hits topmost', () => {
    const s = new Scene();
    s.load([r('b', 0, 'b'), r('a', 0, 'a'), r('far', 1000, 'c')]);
    expect(s.all().map((e) => e.id)).toEqual(['a', 'b', 'far']);
    expect(s.query({ minX: -5, minY: -5, maxX: 20, maxY: 20 }).map((e) => e.id)).toEqual(['a', 'b']);
    expect(s.hit([5, 5], 2)!.id).toBe('b');
    s.set(r('a', 0, 'z'));
    expect(s.hit([5, 5], 2)!.id).toBe('a');
    expect(s.all().find((e) => e.id === 'b')).toBeDefined();
    s.remove('a');
    expect(s.hit([5, 5], 2)!.id).toBe('b');
    expect(s.version('b')).toBe(1);
  });
  it('all() reflects in-place updates with an unchanged index', () => {
    const s = new Scene();
    s.load([r('a', 0, 'a')]);
    s.all();
    s.set(r('a', 7, 'a'));
    expect(s.all()[0].x).toBe(7);
  });
  it('moves elements in the index', () => {
    const s = new Scene();
    s.load([r('a', 0, 'a')]);
    s.set(r('a', 500, 'a'));
    expect(s.query({ minX: -5, minY: -5, maxX: 20, maxY: 20 })).toEqual([]);
    expect(s.query({ minX: 495, minY: -5, maxX: 520, maxY: 20 }).length).toBe(1);
  });
});
