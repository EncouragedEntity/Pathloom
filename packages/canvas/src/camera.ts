import type { Bounds, Point } from './geometry';

export interface Camera { x: number; y: number; scale: number }
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;

export const clampScale = (s: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, s));
/** screen = world * scale + (x, y) */
export const screenToWorld = (c: Camera, p: Point): Point => [(p[0] - c.x) / c.scale, (p[1] - c.y) / c.scale];
export const worldToScreen = (c: Camera, p: Point): Point => [p[0] * c.scale + c.x, p[1] * c.scale + c.y];

/** New camera with `scale` where the world point under `screen` stays put. */
export function zoomAt(c: Camera, scale: number, screen: Point): Camera {
  const s = clampScale(scale);
  const w = screenToWorld(c, screen);
  return { scale: s, x: screen[0] - w[0] * s, y: screen[1] - w[1] * s };
}

export function visibleBounds(c: Camera, viewW: number, viewH: number): Bounds {
  const a = screenToWorld(c, [0, 0]), b = screenToWorld(c, [viewW, viewH]);
  return { minX: a[0], minY: a[1], maxX: b[0], maxY: b[1] };
}

export function fitBounds(b: Bounds | null, viewW: number, viewH: number, padding = 60, maxScale = 1): Camera {
  if (!b) return { x: viewW / 2, y: viewH / 2, scale: 1 };
  const w = Math.max(b.maxX - b.minX, 1), h = Math.max(b.maxY - b.minY, 1);
  const scale = clampScale(Math.min((viewW - padding * 2) / w, (viewH - padding * 2) / h, maxScale));
  return { scale, x: viewW / 2 - ((b.minX + b.maxX) / 2) * scale, y: viewH / 2 - ((b.minY + b.maxY) / 2) * scale };
}
