import { describe, expect, it } from 'vitest';
import type { Element } from '../src/types';
import { boundaryPoint, distToBezier, distToSegment, elementBounds, hitElement, type Bezier } from '../src/geometry';

const base = { index: 'a', angle: 0 };
const rect = (o: Partial<Element> = {}): Element => ({ id: 'r', type: 'rect', x: 0, y: 0, w: 100, h: 50, ...base, ...o } as Element);

describe('hitElement', () => {
  it('unfilled rect hits only near outline', () => {
    const r = rect();
    expect(hitElement(r, [0, 25], 4)).toBe(true);
    expect(hitElement(r, [50, 25], 4)).toBe(false);
    expect(hitElement(r, [50, 25], 4, true)).toBe(true);
    expect(hitElement(r, [150, 25], 4)).toBe(false);
  });
  it('filled rect hits inside', () => {
    expect(hitElement(rect({ fill: '#fff' }), [50, 25], 4)).toBe(true);
  });
  it('ellipse', () => {
    const e = rect({ type: 'ellipse', w: 100, h: 100 });
    expect(hitElement(e, [50, 0], 3)).toBe(true);
    expect(hitElement(e, [50, 50], 3)).toBe(false);
    expect(hitElement(e, [2, 2], 3)).toBe(false); // bbox corner is outside the ellipse
    expect(hitElement({ ...e, fill: 'x' } as Element, [50, 50], 3)).toBe(true);
  });
  it('diamond', () => {
    const d = rect({ type: 'diamond', w: 100, h: 100 });
    expect(hitElement(d, [50, 0], 3)).toBe(true);
    expect(hitElement(d, [75, 25], 3)).toBe(true); // on the edge
    expect(hitElement(d, [5, 5], 3, true)).toBe(false);
    expect(hitElement(d, [50, 50], 3, true)).toBe(true);
  });
  it('respects rotation', () => {
    const r = rect({ w: 100, h: 10, angle: Math.PI / 2, fill: '#000' });
    // centre (50,5); rotated 90deg -> vertical bar from y=-45..55 at x ~ 50
    expect(hitElement(r, [50, 50], 1)).toBe(true);
    expect(hitElement(r, [95, 5], 1)).toBe(false);
  });
  it('lines and freedraw use stroke distance', () => {
    const a = { id: 'a', type: 'arrow', x: 0, y: 0, w: 100, h: 0, ...base, points: [[0, 0], [100, 0]] } as Element;
    expect(hitElement(a, [50, 3], 4)).toBe(true);
    expect(hitElement(a, [50, 20], 4)).toBe(false);
    const f = { id: 'f', type: 'freedraw', x: 10, y: 10, w: 10, h: 10, ...base, points: [[0, 0, 0.5], [10, 10, 0.5]] } as Element;
    expect(hitElement(f, [15, 15], 2)).toBe(true);
  });
  it('cards are solid', () => {
    expect(hitElement({ id: 'c', type: 'card', ref: 'M0', x: 0, y: 0, w: 250, h: 100, ...base } as Element, [100, 50], 3)).toBe(true);
  });
});

describe('boundaryPoint', () => {
  it('rect: horizontal and diagonal', () => {
    const r = rect({ w: 100, h: 50 });
    expect(boundaryPoint(r, [500, 25])).toEqual([100, 25]);
    const p = boundaryPoint(r, [150, 75]); // from centre (50,25) direction (100,50): hits right side
    expect(p[0]).toBeCloseTo(100); expect(p[1]).toBeCloseTo(50);
    const q = boundaryPoint(r, [50, -100]);
    expect(q[0]).toBeCloseTo(50); expect(q[1]).toBeCloseTo(0);
  });
  it('ellipse and diamond', () => {
    const e = rect({ type: 'ellipse', w: 100, h: 100 });
    expect(boundaryPoint(e, [200, 50])[0]).toBeCloseTo(100);
    const diag = boundaryPoint(e, [150, 150]);
    expect(Math.hypot(diag[0] - 50, diag[1] - 50)).toBeCloseTo(50);
    const d = rect({ type: 'diamond', w: 100, h: 100 });
    const p = boundaryPoint(d, [150, 150]); // diagonal hits the edge midpoint (75,75)
    expect(p[0]).toBeCloseTo(75); expect(p[1]).toBeCloseTo(75);
  });
  it('rotated rect', () => {
    const r = rect({ w: 100, h: 20, angle: Math.PI / 2 });
    const p = boundaryPoint(r, [50, 500]); // centre (50,10); rotated bar is vertical, 100 tall
    expect(p[0]).toBeCloseTo(50); expect(p[1]).toBeCloseTo(60);
  });
});

describe('bezier distance', () => {
  const b: Bezier = [[0, 0], [50, 0], [50, 100], [100, 100]];
  it('point on curve ~ 0, midpoint is (50,50)', () => {
    expect(distToBezier([50, 50], b)).toBeLessThan(0.5);
    expect(distToBezier([0, 0], b)).toBeLessThan(0.01);
  });
  it('far point', () => {
    expect(distToBezier([50, 200], b)).toBeGreaterThan(90);
  });
  it('segment distance clamps at ends', () => {
    expect(distToSegment([-3, 4], [0, 0], [10, 0])).toBe(5);
  });
});

describe('elementBounds', () => {
  it('includes rotation', () => {
    const b = elementBounds(rect({ w: 100, h: 10, angle: Math.PI / 2 }));
    expect(b.maxY - b.minY).toBeCloseTo(100);
    expect(b.maxX - b.minX).toBeCloseTo(10);
  });
});
