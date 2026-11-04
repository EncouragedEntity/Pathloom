import type { Element, LinearElement, FreedrawElement } from './types';

export type Point = [number, number];
export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

export const rotatePoint = (p: Point, c: Point, a: number): Point => {
  if (!a) return p;
  const cos = Math.cos(a), sin = Math.sin(a), dx = p[0] - c[0], dy = p[1] - c[1];
  return [c[0] + dx * cos - dy * sin, c[1] + dx * sin + dy * cos];
};

export const elementCenter = (el: Element): Point => [el.x + el.w / 2, el.y + el.h / 2];

export function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

export function distToPolyline(p: Point, pts: Point[]): number {
  if (pts.length === 1) return Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]);
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) best = Math.min(best, distToSegment(p, pts[i], pts[i + 1]));
  return best;
}

export function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export const isLinear = (el: Element): el is LinearElement => el.type === 'line' || el.type === 'arrow';
export const isFreedraw = (el: Element): el is FreedrawElement => el.type === 'freedraw';
export const isPointy = (el: Element) => isLinear(el) || isFreedraw(el);

export function absPoints(el: LinearElement | FreedrawElement): Point[] {
  return el.points.map((p) => [el.x + p[0], el.y + p[1]] as Point);
}

export function pointsBounds(pts: Point[]): Bounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/** Axis-aligned bounds in world space (rotation included). */
export function elementBounds(el: Element): Bounds {
  if (isPointy(el)) {
    const pts = absPoints(el as LinearElement);
    return pts.length ? pointsBounds(pts) : { minX: el.x, minY: el.y, maxX: el.x, maxY: el.y };
  }
  if (!el.angle) return { minX: el.x, minY: el.y, maxX: el.x + el.w, maxY: el.y + el.h };
  const c = elementCenter(el);
  return pointsBounds([
    rotatePoint([el.x, el.y], c, el.angle), rotatePoint([el.x + el.w, el.y], c, el.angle),
    rotatePoint([el.x + el.w, el.y + el.h], c, el.angle), rotatePoint([el.x, el.y + el.h], c, el.angle),
  ]);
}

export function unionBounds(list: Bounds[]): Bounds | null {
  if (!list.length) return null;
  const r = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const b of list) {
    r.minX = Math.min(r.minX, b.minX); r.minY = Math.min(r.minY, b.minY);
    r.maxX = Math.max(r.maxX, b.maxX); r.maxY = Math.max(r.maxY, b.maxY);
  }
  return r;
}

export const boundsIntersect = (a: Bounds, b: Bounds) =>
  a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;

const ALWAYS_SOLID = new Set(['card', 'sticky', 'image', 'text', 'portal']);

/**
 * Narrow-phase hit test. `tol` is in world units. Unfilled shapes only hit near the outline
 * (Excalidraw behaviour) unless `solid` is set (used for arrow binding).
 */
export function hitElement(el: Element, p: Point, tol: number, solid = false): boolean {
  if (isPointy(el)) {
    return distToPolyline(p, absPoints(el as LinearElement)) <= tol + (el.strokeWidth ?? 1.5) / 2;
  }
  const c = elementCenter(el);
  const lp = el.angle ? rotatePoint(p, c, -el.angle) : p;
  const hw = Math.max(el.w / 2, 0.5), hh = Math.max(el.h / 2, 0.5);
  const dx = lp[0] - c[0], dy = lp[1] - c[1];
  const filled = solid || !!el.fill || ALWAYS_SOLID.has(el.type);
  if (el.type === 'ellipse') {
    const r = Math.hypot(dx / hw, dy / hh), m = Math.min(hw, hh);
    return filled ? (r - 1) * m <= tol : Math.abs((r - 1) * m) <= tol;
  }
  if (el.type === 'diamond') {
    const poly: Point[] = [[0, -hh], [hw, 0], [0, hh], [-hw, 0]];
    const q: Point = [dx, dy];
    const near = distToPolyline(q, [...poly, poly[0]]) <= tol;
    return near || (filled && pointInPolygon(q, poly));
  }
  const inside = Math.abs(dx) <= hw + tol && Math.abs(dy) <= hh + tol;
  if (filled) return inside;
  return inside && !(Math.abs(dx) < hw - tol && Math.abs(dy) < hh - tol);
}

/** Point where the ray from the element's centre towards `toward` leaves the outline. */
export function boundaryPoint(el: Element, toward: Point, gap = 0): Point {
  const c = elementCenter(el);
  const lt = el.angle ? rotatePoint(toward, c, -el.angle) : toward;
  const dx = lt[0] - c[0], dy = lt[1] - c[1];
  const hw = el.w / 2, hh = el.h / 2;
  if (dx === 0 && dy === 0) return el.angle ? rotatePoint([c[0] + hw, c[1]], c, el.angle) : [c[0] + hw, c[1]];
  let t: number;
  if (el.type === 'ellipse') t = 1 / Math.hypot(dx / hw, dy / hh);
  else if (el.type === 'diamond') t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  else t = Math.min(dx === 0 ? Infinity : hw / Math.abs(dx), dy === 0 ? Infinity : hh / Math.abs(dy));
  const k = t + gap / (Math.hypot(dx, dy) || 1);
  const out: Point = [c[0] + dx * k, c[1] + dy * k];
  return el.angle ? rotatePoint(out, c, el.angle) : out;
}

export type Bezier = [Point, Point, Point, Point];

export function bezierPoint(b: Bezier, t: number): Point {
  const u = 1 - t, a = u * u * u, bb = 3 * u * u * t, cc = 3 * u * t * t, d = t * t * t;
  return [
    a * b[0][0] + bb * b[1][0] + cc * b[2][0] + d * b[3][0],
    a * b[0][1] + bb * b[1][1] + cc * b[2][1] + d * b[3][1],
  ];
}

export function flattenBezier(b: Bezier, steps = 24): Point[] {
  const out: Point[] = [];
  for (let i = 0; i <= steps; i++) out.push(bezierPoint(b, i / steps));
  return out;
}

export const distToBezier = (p: Point, b: Bezier, steps = 24) => distToPolyline(p, flattenBezier(b, steps));

/** Recompute w/h of a linear/freedraw element from its points (x,y stay the origin). */
export function withPointBounds<T extends LinearElement | FreedrawElement>(el: T): T {
  const b = pointsBounds(el.points.map((p) => [p[0], p[1]] as Point));
  return { ...el, w: b.maxX - b.minX, h: b.maxY - b.minY };
}
