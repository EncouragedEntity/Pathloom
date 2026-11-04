import type { Camera } from './camera';
import { unionBounds, type Bounds, type Point } from './geometry';

/** Minimap math (pure, unit-tested) and the small DOM canvas overlay. */

export const MINIMAP_W = 180;
export const MINIMAP_H = 110;
const PAD = 8;

export interface MiniTransform { scale: number; ox: number; oy: number }

/** World -> minimap px: fits `world` into w x h with padding, centred. mini = world * scale + (ox, oy). */
export function miniTransform(world: Bounds, w = MINIMAP_W, h = MINIMAP_H, pad = PAD): MiniTransform {
  const ww = Math.max(world.maxX - world.minX, 1), wh = Math.max(world.maxY - world.minY, 1);
  const scale = Math.min((w - pad * 2) / ww, (h - pad * 2) / wh);
  return { scale, ox: w / 2 - ((world.minX + world.maxX) / 2) * scale, oy: h / 2 - ((world.minY + world.maxY) / 2) * scale };
}

export const worldToMini = (t: MiniTransform, p: Point): Point => [p[0] * t.scale + t.ox, p[1] * t.scale + t.oy];
export const miniToWorld = (t: MiniTransform, p: Point): Point => [(p[0] - t.ox) / t.scale, (p[1] - t.oy) / t.scale];

/** The viewport rectangle (world bounds of the editor view) in minimap px. */
export function viewportRect(cam: Camera, viewW: number, viewH: number, t: MiniTransform): { x: number; y: number; w: number; h: number } {
  const a = worldToMini(t, [-cam.x / cam.scale, -cam.y / cam.scale]);
  return { x: a[0], y: a[1], w: (viewW / cam.scale) * t.scale, h: (viewH / cam.scale) * t.scale };
}

/** Camera that keeps `scale` and puts world point `c` at the centre of the view. */
export const centerCameraOn = (cam: Camera, c: Point, viewW: number, viewH: number): Camera =>
  ({ scale: cam.scale, x: viewW / 2 - c[0] * cam.scale, y: viewH / 2 - c[1] * cam.scale });

/** World area the minimap shows: all content plus the current viewport (so you can always see where you are). */
export function miniWorld(content: Bounds | null, cam: Camera, viewW: number, viewH: number): Bounds {
  const view: Bounds = { minX: -cam.x / cam.scale, minY: -cam.y / cam.scale, maxX: (viewW - cam.x) / cam.scale, maxY: (viewH - cam.y) / cam.scale };
  return unionBounds(content ? [content, view] : [view])!;
}

export interface MiniRect { b: Bounds; color: string; alpha: number }
export interface MiniFrame { rects: readonly MiniRect[]; content: Bounds | null; cam: Camera; viewW: number; viewH: number; panel: string; border: string; accent: string }

export class Minimap {
  readonly el: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private t: MiniTransform = { scale: 1, ox: 0, oy: 0 };
  private drag = false;
  /** Called with the world point the user clicked / dragged to. */
  onPan: (world: Point) => void = () => undefined;

  constructor(container: HTMLElement, label: string) {
    const dpr = window.devicePixelRatio || 1;
    const c = document.createElement('canvas');
    c.width = Math.round(MINIMAP_W * dpr); c.height = Math.round(MINIMAP_H * dpr);
    c.setAttribute('role', 'img'); c.setAttribute('aria-label', label); c.title = label;
    c.style.cssText = `position:absolute;right:12px;bottom:12px;width:${MINIMAP_W}px;height:${MINIMAP_H}px;z-index:8;border-radius:8px;cursor:pointer;touch-action:none;box-shadow:0 4px 16px rgba(0,0,0,.3);`;
    c.addEventListener('pointerdown', this.down);
    c.addEventListener('pointermove', this.move);
    c.addEventListener('pointerup', this.up);
    c.addEventListener('pointercancel', this.up);
    c.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
    container.appendChild(c);
    this.el = c;
    this.ctx = c.getContext('2d')!;
  }

  private at(e: PointerEvent): Point {
    const r = this.el.getBoundingClientRect();
    return miniToWorld(this.t, [e.clientX - r.left, e.clientY - r.top]);
  }
  private down = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    this.drag = true; this.el.setPointerCapture(e.pointerId);
    this.onPan(this.at(e));
  };
  private move = (e: PointerEvent) => { if (this.drag) this.onPan(this.at(e)); };
  private up = (e: PointerEvent) => { this.drag = false; if (this.el.hasPointerCapture(e.pointerId)) this.el.releasePointerCapture(e.pointerId); };

  draw(f: MiniFrame) {
    // While dragging keep the mapping fixed, otherwise the content would slide under the pointer.
    if (!this.drag) this.t = miniTransform(miniWorld(f.content, f.cam, f.viewW, f.viewH));
    const { ctx: g, t } = this, dpr = window.devicePixelRatio || 1;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, MINIMAP_W, MINIMAP_H);
    g.fillStyle = f.panel; g.globalAlpha = 0.92;
    g.beginPath(); g.roundRect(0, 0, MINIMAP_W, MINIMAP_H, 8); g.fill();
    g.globalAlpha = 1;
    for (const r of f.rects) {
      g.fillStyle = r.color; g.globalAlpha = r.alpha;
      g.fillRect(r.b.minX * t.scale + t.ox, r.b.minY * t.scale + t.oy, Math.max((r.b.maxX - r.b.minX) * t.scale, 1.5), Math.max((r.b.maxY - r.b.minY) * t.scale, 1.5));
    }
    g.globalAlpha = 1;
    const v = viewportRect(f.cam, f.viewW, f.viewH, t);
    g.fillStyle = f.accent; g.globalAlpha = 0.14; g.fillRect(v.x, v.y, v.w, v.h);
    g.globalAlpha = 1; g.strokeStyle = f.accent; g.lineWidth = 1.5; g.strokeRect(v.x, v.y, v.w, v.h);
    g.strokeStyle = f.border; g.lineWidth = 1; g.beginPath(); g.roundRect(0.5, 0.5, MINIMAP_W - 1, MINIMAP_H - 1, 8); g.stroke();
  }

  destroy() { this.el.remove(); }
}
