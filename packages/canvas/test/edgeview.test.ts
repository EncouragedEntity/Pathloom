import { describe, expect, it } from 'vitest';
import { bundleEdges, chainOf, edgeKey, edgeView, pushApart, redundantEdges } from '../src/edgeview';
import type { DepEdge } from '../src/stage';

const e = (from: string, to: string, soft = false): DepEdge => ({ from, to, soft, fromDone: false });

describe('redundantEdges', () => {
  it('hides A→C when A→B→C exists', () => {
    const edges = [e('A', 'B'), e('B', 'C'), e('A', 'C'), e('C', 'D')];
    expect([...redundantEdges(edges)]).toEqual(['A>C']);
  });
  it('keeps a hard arrow that is implied only through a soft one', () => {
    const edges = [e('A', 'B', true), e('B', 'C'), e('A', 'C')];
    expect(redundantEdges(edges).size).toBe(0);
    expect([...redundantEdges([e('A', 'B'), e('B', 'C'), e('A', 'C', true)])]).toEqual(['A>C']);
  });
});

describe('chainOf', () => {
  it('collects upstream and downstream, not siblings', () => {
    const edges = [e('A', 'B'), e('B', 'C'), e('X', 'C'), e('B', 'Y'), e('Q', 'Z')];
    const c = chainOf('B', edges);
    expect([...c.nodes].sort()).toEqual(['A', 'B', 'C', 'Y']);
    expect([...c.edges].sort()).toEqual(['A>B', 'B>C', 'B>Y']);
  });
});

describe('bundles and view', () => {
  const frame: Record<string, string> = { A: 'f1', B: 'f1', C: 'f2', D: 'f2', E: 'f3' };
  const edges = [e('A', 'C'), e('B', 'D'), e('A', 'E'), e('C', 'D')];
  it('groups 2+ arrows between the same two frames', () => {
    const b = bundleEdges(edges, (k) => frame[k]);
    expect(b).toHaveLength(1);
    expect(b[0].edges.map(edgeKey)).toEqual(['A>C', 'B>D']);
  });
  it('draws a focused chain arrow by arrow', () => {
    const v = edgeView(edges, { hideRedundant: true, bundle: true }, (k) => frame[k], null);
    expect(v.visible.map(edgeKey)).toEqual(['A>E', 'C>D']);
    const f = edgeView(edges, { hideRedundant: true, bundle: true }, (k) => frame[k], 'A');
    expect(f.visible.map(edgeKey)).toEqual(['A>C', 'A>E', 'C>D']);
    expect(f.focus?.nodes.has('D')).toBe(true);
    const off = edgeView(edges, { hideRedundant: false, bundle: false }, (k) => frame[k], null);
    expect(off.visible).toHaveLength(4);
  });
});

describe('pushApart', () => {
  it('moves cards below a grown card, cascading, and leaves other columns', () => {
    const moved = pushApart([
      { id: 'g', x: 0, y: 0, w: 250, h: 300 },
      { id: 'b', x: 0, y: 200, w: 250, h: 100 },
      { id: 'c', x: 0, y: 310, w: 250, h: 100 },
      { id: 'o', x: 400, y: 200, w: 250, h: 100 },
    ], ['g']);
    expect(moved.get('b')).toBe(320);
    expect(moved.get('c')).toBe(440);
    expect(moved.has('o')).toBe(false);
  });
});
