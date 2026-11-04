import { describe, expect, it } from 'vitest';
import type { Element } from '../src/types';
import { Scene } from '../src/scene';
import {
  alignDeltas, distributeDeltas, erasable, expandGroups, findElements, findSnap, groupUpdates, guideCandidates, imageFit, snapGrid, snapMove, snapPoint,
  stickyNeeded, sweepHits, ungroupIds, unitsOf, wrapLines,
} from '../src/arrange';
import { centerCameraOn, miniToWorld, miniTransform, miniWorld, viewportRect, worldToMini } from '../src/minimap';
import { DEFAULT_CANVAS_KEYMAP, findConflicts } from '../src/keymap';

const rect = (id: string, x: number, y: number, w = 100, h = 50, extra: Partial<Element> = {}): Element =>
  ({ id, type: 'rect', x, y, w, h, index: id, fill: '#fff', ...extra }) as Element;

describe('groups', () => {
  const els = [rect('a', 0, 0, 10, 10, { group: 'g' }), rect('b', 50, 0, 10, 10, { group: 'g' }), rect('c', 100, 0), rect('d', 200, 0, 10, 10, { group: 'h' })];
  it('expands a click on a member to the whole group', () => {
    expect([...expandGroups(els, ['a'])].sort()).toEqual(['a', 'b']);
    expect([...expandGroups(els, ['c'])]).toEqual(['c']);
    expect([...expandGroups(els, ['b', 'd'])].sort()).toEqual(['a', 'b', 'd']);
  });
  it('group needs 2+ unlocked elements and is a no-op on an already complete group', () => {
    expect(groupUpdates(els, new Set(['c']), 'n').size).toBe(0);
    expect([...groupUpdates(els, new Set(['c', 'd']), 'n')]).toEqual([['c', 'n'], ['d', 'n']]);
    expect(groupUpdates(els, new Set(['a', 'b']), 'n').size).toBe(0);
    const locked = [rect('x', 0, 0, 5, 5, { locked: true }), rect('y', 9, 0)];
    expect(groupUpdates(locked, new Set(['x', 'y']), 'n').size).toBe(0);
  });
  it('ungroup frees every member of the touched groups', () => {
    expect([...ungroupIds(els, new Set(['a', 'b']))].sort()).toEqual(['a', 'b']);
    expect(ungroupIds(els, new Set(['c'])).size).toBe(0);
  });
});

describe('align / distribute', () => {
  const units = unitsOf([rect('a', 0, 0, 100, 40), rect('b', 150, 30, 50, 60), rect('c', 400, 10, 100, 20)]);
  it('aligns edges and centres to the selection extremes', () => {
    expect(alignDeltas(units, 'left').get('b')).toEqual([-150, 0]);
    expect(alignDeltas(units, 'right').get('a')).toEqual([400, 0]);
    expect(alignDeltas(units, 'center').get('a')).toEqual([250 - 50, 0]); // span 0..500, centre 250
    expect(alignDeltas(units, 'top').get('c')).toEqual([0, -10]);
    expect(alignDeltas(units, 'bottom').get('a')).toEqual([0, 50]); // max bottom is 90
    expect(alignDeltas(units, 'middle').get('c')).toEqual([0, 45 - 20]); // span 0..90, centre 45
  });
  it('needs 2 units to align and 3 to distribute', () => {
    expect(alignDeltas(units.slice(0, 1), 'left').size).toBe(0);
    expect(distributeDeltas(units.slice(0, 2), 'h').size).toBe(0);
  });
  it('distributes with equal gaps, outer elements fixed', () => {
    const d = distributeDeltas(units, 'h');
    // widths 100+50+100 = 250 in span 500 -> gap 125: a at 0, b at 225, c at 400
    expect(d.get('a')).toBeUndefined();
    expect(d.get('b')).toEqual([75, 0]);
    expect(d.get('c')).toBeUndefined();
    const v = distributeDeltas(unitsOf([rect('a', 0, 0, 10, 10), rect('b', 0, 10, 10, 10), rect('c', 0, 100, 10, 10)]), 'v');
    expect(v.get('b')).toEqual([0, 40]); // gap (110-30)/2 = 40 -> b.y = 50
  });
  it('treats a group as one unit', () => {
    const u = unitsOf([rect('a', 0, 0, 10, 10, { group: 'g' }), rect('b', 20, 0, 10, 10, { group: 'g' }), rect('c', 100, 0, 10, 10)]);
    expect(u).toHaveLength(2);
    expect(u[0].ids).toEqual(['a', 'b']);
    expect(u[0].b).toMatchObject({ minX: 0, maxX: 30 });
    expect(alignDeltas(u, 'right').get('g')).toEqual([80, 0]);
  });
});

describe('snap', () => {
  it('grid math', () => {
    expect(snapGrid(29)).toBe(20);
    expect(snapGrid(31)).toBe(40);
    expect(snapGrid(-11)).toBe(-20);
    expect(snapPoint([49, 51])).toEqual([40, 60]);
    expect(snapMove({ minX: 5, minY: 5, maxX: 25, maxY: 25 }, 12, 3)).toEqual([15, -5]); // 17 -> 20, 8 -> 0
  });
  it('smart guides snap an edge/centre within tolerance and report the guide', () => {
    const others = [{ minX: 200, minY: 0, maxX: 300, maxY: 50 }];
    const r = findSnap({ minX: 103, minY: 100, maxX: 197, maxY: 150 }, others, 6);
    expect(r.dx).toBe(3); // maxX 197 -> 200
    expect(r.dy).toBe(0);
    expect(r.guides).toEqual([{ axis: 'x', pos: 200, from: 0, to: 150 }]);
  });
  it('picks the nearest candidate and ignores ones out of reach', () => {
    const others = [{ minX: 0, minY: 0, maxX: 100, maxY: 100 }, { minX: 300, minY: 300, maxX: 400, maxY: 400 }];
    const r = findSnap({ minX: 250, minY: 252, maxX: 290, maxY: 292 }, others, 6);
    expect(r.dx).toBe(0); // 290 vs 300 = 10 away
    expect(r.dy).toBe(0);
    expect(r.guides).toEqual([]);
    const c = findSnap({ minX: 10, minY: 2, maxX: 60, maxY: 52 }, [{ minX: 1000, minY: 0, maxX: 1100, maxY: 100 }], 6);
    expect(c.dx).toBe(0);
  });
  it('centre-to-centre snapping works on both axes', () => {
    const s = findSnap({ minX: 90, minY: 95, maxX: 110, maxY: 115 }, [{ minX: 87, minY: 98, maxX: 117, maxY: 118 }], 6);
    expect(s.dx).toBe(2); // centre 100 -> 102
    expect(s.dy).toBe(3);
    expect(new Set(s.guides.map((g) => g.axis))).toEqual(new Set(['x', 'y']));
  });
  it('guideCandidates skips frames, excluded ids and far elements', () => {
    const sc = new Scene();
    sc.load([rect('near', 120, 0), rect('far', 5000, 0), rect('moving', 0, 0), { ...rect('f', 0, 0, 500, 500), type: 'frame' } as Element]);
    const c = guideCandidates(sc, { minX: 0, minY: 0, maxX: 100, maxY: 50 }, 400, new Set(['moving']));
    expect(c).toHaveLength(1);
    expect(c[0].minX).toBe(120);
  });
});

describe('eraser', () => {
  const sc = new Scene();
  sc.load([
    rect('free', 0, 0), rect('locked', 0, 100, 100, 50, { locked: true }), { ...rect('fr', 300, 0, 200, 200), type: 'frame', fill: null } as Element,
    rect('far', 1000, 1000),
  ]);
  it('marks unlocked elements along the path only', () => {
    const hits = sweepHits(sc, [50, -10], [50, 125], 6, 4).map((e) => e.id);
    expect(hits).toContain('free');
    expect(hits).not.toContain('locked');
    expect(hits).not.toContain('far');
  });
  it('never erases locked elements or frames', () => {
    expect(erasable(rect('l', 0, 0, 1, 1, { locked: true }))).toBe(false);
    expect(erasable({ ...rect('f', 0, 0), type: 'frame' } as Element)).toBe(false);
    expect(erasable(rect('ok', 0, 0))).toBe(true);
    // a sweep straight across the frame border finds nothing
    expect(sweepHits(sc, [290, 100], [510, 100], 6, 4)).toEqual([]);
  });
  it('samples long segments so fast drags do not skip thin targets', () => {
    const thin = new Scene();
    thin.load([rect('t', 500, 0, 4, 100)]);
    expect(sweepHits(thin, [0, 50], [1000, 50], 3, 3).map((e) => e.id)).toEqual(['t']);
  });
});

describe('image sizing', () => {
  it('keeps natural size up to 800 on the long side and preserves aspect above it', () => {
    expect(imageFit(300, 200)).toEqual({ w: 300, h: 200 });
    expect(imageFit(1600, 800)).toEqual({ w: 800, h: 400 });
    expect(imageFit(500, 2000)).toEqual({ w: 200, h: 800 });
  });
  it('falls back for broken sizes', () => {
    expect(imageFit(0, 0)).toEqual({ w: 160, h: 160 });
    expect(imageFit(NaN, 10)).toEqual({ w: 160, h: 160 });
  });
});

describe('findElements', () => {
  const stages = new Map([['M1', { key: 'M1', title: 'Canvas: shapes', tasks: [{ title: 'Pan and Zoom', sub: [{ title: 'Inertia', sub: [] }] }] }]]);
  const els = [
    rect('r1', 0, 0, 10, 10, { text: 'Idea: Plugins' } as Partial<Element>),
    { id: 'f1', type: 'frame', name: 'Phase 1', x: 0, y: 0, w: 1, h: 1, index: 'b' } as Element,
    { id: 'c1', type: 'card', ref: 'M1', x: 0, y: 0, w: 1, h: 1, index: 'c' } as Element,
    { id: 'c2', type: 'card', ref: 'GONE', x: 0, y: 0, w: 1, h: 1, index: 'd' } as Element,
    rect('r2', 0, 0, 10, 10),
  ];
  const f = (q: string) => findElements(els, (r) => stages.get(r), q);
  it('matches text, frame names, stage title/key and nested task titles case-insensitively', () => {
    expect(f('plugin')).toEqual(['r1']);
    expect(f('PHASE')).toEqual(['f1']);
    expect(f('shapes')).toEqual(['c1']);
    expect(f('m1')).toEqual(['c1']);
    expect(f('inertia')).toEqual(['c1']);
    expect(f('zzz')).toEqual([]);
  });
  it('empty or blank query matches nothing', () => {
    expect(f('')).toEqual([]);
    expect(f('   ')).toEqual([]);
  });
});

describe('minimap mapping', () => {
  const world = { minX: 0, minY: 0, maxX: 1000, maxY: 500 };
  const t = miniTransform(world, 180, 110, 8);
  it('fits the world into the panel with padding, centred', () => {
    expect(t.scale).toBeCloseTo(0.164); // (180-16)/1000
    const a = worldToMini(t, [0, 0]), b = worldToMini(t, [1000, 500]);
    expect(a[0]).toBeCloseTo(8);
    expect(b[0]).toBeCloseTo(172);
    expect((a[1] + b[1]) / 2).toBeCloseTo(55);
  });
  it('mini <-> world round trips', () => {
    const p = miniToWorld(t, worldToMini(t, [321, 123]));
    expect(p[0]).toBeCloseTo(321);
    expect(p[1]).toBeCloseTo(123);
  });
  it('viewport rect follows the camera', () => {
    const v = viewportRect({ x: -200, y: -100, scale: 2 }, 800, 600, t);
    const topLeft = worldToMini(t, [100, 50]);
    expect(v.x).toBeCloseTo(topLeft[0]);
    expect(v.y).toBeCloseTo(topLeft[1]);
    expect(v.w).toBeCloseTo(400 * t.scale); // 800px / zoom 2
    expect(v.h).toBeCloseTo(300 * t.scale);
  });
  it('clicking the minimap centres the camera on that world point', () => {
    const cam = centerCameraOn({ x: 0, y: 0, scale: 2 }, [500, 250], 800, 600);
    expect(cam).toEqual({ scale: 2, x: 400 - 1000, y: 300 - 500 });
  });
  it('the shown world always includes the viewport', () => {
    const w = miniWorld({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, { x: -5000, y: 0, scale: 1 }, 800, 600);
    expect(w.minX).toBe(0);
    expect(w.maxX).toBe(5800);
    expect(miniWorld(null, { x: 0, y: 0, scale: 1 }, 800, 600)).toMatchObject({ maxX: 800, maxY: 600 });
  });
});

describe('sticky text', () => {
  const m = (s: string) => s.length * 10;
  it('wraps at word boundaries and honours newlines', () => {
    expect(wrapLines('aaa bbb ccc', 70, m)).toEqual(['aaa bbb', 'ccc']);
    expect(wrapLines('a\n\nb', 100, m)).toEqual(['a', '', 'b']);
  });
  it('splits words longer than a line', () => {
    expect(wrapLines('abcdefghij', 40, m)).toEqual(['abcd', 'efgh', 'ij']);
  });
  it('needed height grows with lines', () => {
    expect(stickyNeeded(2, 20)).toBeGreaterThan(stickyNeeded(1, 20));
  });
});

describe('M4 keymap', () => {
  it('new commands have the specified defaults and no conflicts', () => {
    const k = DEFAULT_CANVAS_KEYMAP;
    expect(k['tool.sticky']).toEqual(['Digit9']);
    expect(k['tool.image']).toEqual(['Digit8']);
    expect(k['tool.eraser']).toEqual(['Digit0']);
    expect(k['edit.group']).toEqual(['Mod+KeyG']);
    expect(k['edit.ungroup']).toEqual(['Mod+Shift+KeyG']);
    expect(k['view.toggleSnap']).toEqual(['Mod+Quote']);
    expect(k['align.left']).toEqual([]);
    expect(k['distribute.v']).toEqual([]);
    expect(findConflicts(k)).toEqual([]);
  });
});
