import { describe, expect, it } from 'vitest';
import type { Ghost, StageView } from '../src/types';
import { addHighlights, boundsWithGhosts, ghostEdges, highlightAlpha, keepSelection, pruneHighlights, type Highlight } from '../src/live';

const st = (key: string, deps: string[] = []) => ({ key, depends: deps.map((id) => ({ id, soft: false })) }) as unknown as StageView;
const gh = (key: string, deps: string[], x = 0, y = 0): Ghost => ({ stage: st(key, deps), x, y });

describe('ghost edges', () => {
  const real = [st('A'), st('B', ['A'])];
  const onBoard = new Set(['A', 'B']);
  it('card -> ghost', () => expect(ghostEdges([gh('G', ['A'])], real, onBoard)).toEqual([{ from: 'A', to: 'G', soft: false }]));
  it('ghost -> ghost', () => {
    const e = ghostEdges([gh('G1', ['A']), gh('G2', ['G1'])], real, onBoard);
    expect(e).toContainEqual({ from: 'G1', to: 'G2', soft: false });
    expect(e).toHaveLength(2);
  });
  it('ghost -> card (real stage depends on a ghost key)', () => {
    const e = ghostEdges([gh('G', [])], [st('A'), st('B', ['G'])], onBoard);
    expect(e).toEqual([{ from: 'G', to: 'B', soft: false }]);
  });
  it('drops deps that have no card and self loops', () => expect(ghostEdges([gh('G', ['ZZ', 'G'])], real, onBoard)).toEqual([]));
});

describe('highlights', () => {
  it('restarts repeated keys and keeps others', () => {
    const m = new Map<string, Highlight>();
    addHighlights(m, ['A', 'B'], 0, 1000);
    addHighlights(m, ['A'], 600, 1000);
    expect(m.get('A')).toEqual({ start: 600, ms: 1000 });
    expect(m.get('B')).toEqual({ start: 0, ms: 1000 });
  });
  it('fades 1 -> 0 with ease-out', () => {
    const h = { start: 0, ms: 1000 };
    expect(highlightAlpha(h, 0)).toBe(1);
    expect(highlightAlpha(h, 500)).toBeCloseTo(0.25);
    expect(highlightAlpha(h, 1000)).toBe(0);
    expect(highlightAlpha(h, 5000)).toBe(0);
  });
  it('prune reports whether animation must continue', () => {
    const m = new Map<string, Highlight>();
    addHighlights(m, ['A'], 0, 1000); addHighlights(m, ['B'], 500, 1000);
    expect(pruneHighlights(m, 1000)).toBe(true);
    expect([...m.keys()]).toEqual(['B']);
    expect(pruneHighlights(m, 1500)).toBe(false);
    expect(m.size).toBe(0);
  });
});

describe('zoomToFit bounds', () => {
  const base = [{ minX: 0, minY: 0, maxX: 100, maxY: 100 }];
  it('includes ghosts', () => expect(boundsWithGhosts(base, [gh('G', [], 400, 300)], () => 200)).toEqual({ minX: 0, minY: 0, maxX: 650, maxY: 500 }));
  it('ghosts alone fit when board is empty', () => expect(boundsWithGhosts([], [gh('G', [], 10, 20)], () => 50)).toEqual({ minX: 10, minY: 20, maxX: 260, maxY: 70 }));
  it('null when nothing', () => expect(boundsWithGhosts([], [], () => 1)).toBeNull());
});

describe('setBoard keepCamera selection', () => {
  it('keeps only ids that still exist', () => expect([...keepSelection(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd']))]).toEqual(['b', 'c']));
});
