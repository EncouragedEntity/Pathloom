import { describe, expect, it } from 'vitest';
import type { StageView } from '../src/types';
import { CARD_W, MS, cardLayout, cardW, edgeCurve, milestoneAnchors, milestoneBounds, milestoneHit } from '../src/stage';

const m7 = (t: string) => t.length * 7;
const ms = (title = 'MVP demo') => ({ key: 'G', title, kind: 'milestone', depends: [], tasks: [] }) as unknown as StageView;
const rect = { x: 100, y: 200, w: MS.w, h: MS.h };

describe('milestone layout', () => {
  it('is a 160x120 box with a centred label', () => {
    const l = cardLayout(ms(), m7, 16);
    expect([l.w, l.h]).toEqual([160, 120]);
    expect(l.titleY).toBe(MS.titleY);
    expect(l.ms!.subY).toBe(MS.titleY + 16 + 2);
    expect(cardW(ms())).toBe(160);
    expect(cardW({ kind: 'stage' })).toBe(CARD_W);
  });
  it('wraps the title to 2 lines and grows the box when the lines do not fit', () => {
    const l = cardLayout(ms('word '.repeat(30)), m7, 21);
    expect(l.titleLines).toHaveLength(2);
    expect(l.h).toBeGreaterThan(120);
    expect(l.h).toBe(l.ms!.subY + MS.subH + 4);
  });
});

describe('milestone edges', () => {
  it('attach to the diamond tips', () => {
    const a = milestoneAnchors(rect);
    expect(a.left).toEqual([100 + 80 - 28, 200 + 36]);
    expect(a.right).toEqual([100 + 80 + 28, 200 + 36]);
  });
  it('outgoing starts at the right tip, incoming ends at the left tip', () => {
    const other = { x: 500, y: 100, w: CARD_W, h: 200 };
    const out = edgeCurve(rect, other, true, false);
    expect(out[0]).toEqual(milestoneAnchors(rect).right);
    expect(out[3]).toEqual([500, 200]);
    const inc = edgeCurve(other, rect, false, true);
    expect(inc[0]).toEqual([750, 200]);
    expect(inc[3]).toEqual(milestoneAnchors(rect).left);
  });
});

describe('milestone hit-testing', () => {
  const g = cardLayout(ms(), m7, 16).ms!;
  it('hits the diamond and the label', () => {
    expect(milestoneHit(80, 36, 160, g, 0)).toBe(true);
    expect(milestoneHit(80 + 27, 36, 160, g, 0)).toBe(true);
    expect(milestoneHit(80, 80, 160, g, 0)).toBe(true);
    expect(milestoneHit(80, g.subY + 5, 160, g, 0)).toBe(true);
  });
  it('misses the box corners and the gap beside the diamond', () => {
    expect(milestoneHit(5, 5, 160, g, 0)).toBe(false);
    expect(milestoneHit(80 + 24, 36 + 24, 160, g, 0)).toBe(false); // outside the diamond edge
    expect(milestoneHit(5, 110, 160, g, 0)).toBe(false);
  });
  it('selection bounds follow diamond + label', () => {
    const b = milestoneBounds(rect, g);
    expect(b.minY).toBe(200 + 36 - 28);
    expect(b.maxY).toBe(200 + g.subY + MS.subH);
    expect((b.minX + b.maxX) / 2).toBe(180);
  });
});
