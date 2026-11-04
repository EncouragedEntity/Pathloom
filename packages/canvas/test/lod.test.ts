import { describe, expect, it } from 'vitest';
import { cacheBlit, cacheCovers, cacheMargin, lodDot, lodSketch, lodTextPx, STATIC_CACHE } from '../src/lod';
import type { Element } from '../src/types';

const cc = { x: 100, y: 50, scale: 1 };
const el = (w: number, h: number, type = 'rect') => ({ id: 'a', type, x: 0, y: 0, w, h, index: 'a' }) as unknown as Element;

describe('static cache geometry', () => {
  it('covers small pans inside the margin, not beyond it', () => {
    expect(cacheCovers(cc, cc, 800, 600, 200, 150)).toBe(true);
    expect(cacheCovers(cc, { ...cc, x: cc.x + 190 }, 800, 600, 200, 150)).toBe(true);
    expect(cacheCovers(cc, { ...cc, x: cc.x + 220 }, 800, 600, 200, 150)).toBe(false);
    expect(cacheCovers(cc, { ...cc, y: cc.y - 160 }, 800, 600, 200, 150)).toBe(false);
  });
  it('rejects zoom drift beyond 1.5x / 0.67x', () => {
    const at = (scale: number) => ({ scale, x: 400 - 400 * scale, y: 300 - 300 * scale }); // zoom about centre
    expect(cacheCovers({ x: 0, y: 0, scale: 1 }, at(1.4), 800, 600, 200, 150)).toBe(true);
    expect(cacheCovers({ x: 0, y: 0, scale: 1 }, at(1.6), 800, 600, 200, 150)).toBe(false);
    expect(cacheCovers({ x: 0, y: 0, scale: 1 }, at(0.6), 800, 600, 200, 150)).toBe(false);
  });
  it('blit is identity at the cache camera (minus margin) and pixel-snapped on pure pan', () => {
    expect(cacheBlit(cc, cc, 200, 150, 1)).toEqual({ a: 1, e: -200, f: -150 });
    const m = cacheBlit({ x: 0.3, y: 0, scale: 1 }, { x: 10.6, y: 0, scale: 1 }, 0, 0, 2);
    expect(Number.isInteger(m.e)).toBe(true);
    const z = cacheBlit({ x: 0, y: 0, scale: 1 }, { x: 0, y: 0, scale: 2 }, 0, 0, 1);
    expect(z.a).toBe(2);
  });
  it('shrinks the margin for huge canvases', () => {
    expect(cacheMargin(800, 600, 1).mx).toBe(800 * STATIC_CACHE.margin);
    expect(cacheMargin(7680, 4320, 2).mx).toBeLessThan(7680 * STATIC_CACHE.margin);
  });
});

describe('level of detail', () => {
  it('sketch only at readable zoom', () => { expect(lodSketch(0.2)).toBe(false); expect(lodSketch(0.35)).toBe(true); });
  it('dots for sub-2px shapes only', () => {
    expect(lodDot(el(10, 10), 0.13)).toBe(true);
    expect(lodDot(el(100, 10), 0.13)).toBe(false);
    expect(lodDot(el(1, 1, 'arrow'), 0.1)).toBe(false);
  });
  it('tiny text', () => { expect(lodTextPx(18, 0.13)).toBe(true); expect(lodTextPx(18, 0.3)).toBe(false); });
});
