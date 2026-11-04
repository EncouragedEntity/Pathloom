import type { Camera } from './camera';
import type { Element } from './types';

/** Pure helpers for the static-layer bitmap cache and level-of-detail rules (unit-tested). */

export type StaticMode = 'content' | 'camera' | 'idle';

export const STATIC_CACHE = {
  /** ms of camera silence before the cache is re-rendered crisp */
  idleMs: 120,
  /** cache is re-rendered when its scale ratio vs the live camera leaves [1/maxRatio, maxRatio] */
  maxRatio: 1.5,
  /** margin around the viewport, as a fraction of its size, per side */
  margin: 0.25,
  /** cap on cache canvas pixels (w*h*dpr^2) before the margin shrinks */
  maxPixels: 40e6,
};

/** Below this camera scale sketch elements are drawn as clean geometry (rough jitter is sub-pixel). */
export const SKETCH_MIN_SCALE = 0.35;
/** Elements whose longest screen side is below this many px become a single filled rect. */
export const DOT_PX = 2;
/** Text with a rendered font size below this many px is replaced by a bar. */
export const TEXT_MIN_PX = 4;

export const lodSketch = (scale: number) => scale >= SKETCH_MIN_SCALE;
export const lodTextPx = (fontSize: number, scale: number) => fontSize * scale < TEXT_MIN_PX;

const DOT_TYPES = new Set(['rect', 'ellipse', 'diamond', 'sticky', 'text', 'image']);
export const lodDot = (el: Element, scale: number) => DOT_TYPES.has(el.type) && Math.max(el.w, el.h) * scale < DOT_PX;

export function cacheMargin(w: number, h: number, dpr: number): { mx: number; my: number } {
  let f = STATIC_CACHE.margin;
  while (f > 0 && (w * (1 + 2 * f) * dpr) * (h * (1 + 2 * f) * dpr) > STATIC_CACHE.maxPixels) f = f > 0.05 ? f / 2 : 0;
  return { mx: w * f, my: h * f };
}

/** True when a cache rendered at `cc` (viewport w x h plus margin mx,my) can paint the whole viewport at `cam`. */
export function cacheCovers(cc: Camera, cam: Camera, w: number, h: number, mx: number, my: number): boolean {
  const r = cam.scale / cc.scale;
  if (r > STATIC_CACHE.maxRatio || r < 1 / STATIC_CACHE.maxRatio) return false;
  const eps = 0.5;
  const x0 = (0 - cam.x) / r + cc.x + mx, x1 = (w - cam.x) / r + cc.x + mx;
  const y0 = (0 - cam.y) / r + cc.y + my, y1 = (h - cam.y) / r + cc.y + my;
  return x0 >= -eps && y0 >= -eps && x1 <= w + 2 * mx + eps && y1 <= h + 2 * my + eps;
}

/** Transform (a = uniform scale, e/f = device px translation) to draw the cache bitmap at its origin onto the screen. */
export function cacheBlit(cc: Camera, cam: Camera, mx: number, my: number, dpr: number): { a: number; e: number; f: number } {
  const r = cam.scale / cc.scale;
  let e = (cam.x - r * (mx + cc.x)) * dpr, f = (cam.y - r * (my + cc.y)) * dpr;
  if (r === 1) { e = Math.round(e); f = Math.round(f); } // pure pan: keep texels aligned, no blur
  return { a: r, e, f };
}
