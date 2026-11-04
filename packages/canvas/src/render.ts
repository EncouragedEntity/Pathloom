import rough from 'roughjs';
import type { RoughCanvas } from 'roughjs/bin/canvas';
import type { Drawable, Options } from 'roughjs/bin/core';
import getStroke from 'perfect-freehand';
import type { CardElement, Element, FreedrawElement, ImageElement, LinearElement, ShapeElement, StageView, TextElement, ThemeTokens } from './types';
import type { Camera } from './camera';
import { type StaticMode, cacheCovers, cacheBlit, cacheMargin, lodSketch, lodDot, lodTextPx, TEXT_MIN_PX } from './lod';
import { visibleBounds, worldToScreen } from './camera';
import { absPoints, elementCenter, type Bounds, type Point } from './geometry';
import type { Scene } from './scene';
import { CARD, CARD_W, edgeCurve, ellipsize, mixColors, statusColors, taskDone, withAlpha, wrapText, type CardLayout, type CardRect, type DepEdge } from './stage';
import { measureText } from './measure';
import type { CanvasLabels } from './editor-types';
import { execAlpha, frameHeaderRect } from './ops';
import { STICKY_PAD, wrapLines, type Guide } from './arrange';
import type { ImageCache } from './media';

export interface RenderState {
  cam: Camera;
  width: number;
  height: number;
  dpr: number;
  theme: ThemeTokens;
  style: 'clean' | 'sketch';
  scene: Scene;
  stages: Map<string, StageView>;
  layoutOf: (s: StageView) => CardLayout;
  edges: DepEdge[];
  cards: Map<string, CardElement>;
  selected: ReadonlySet<string>;
  selEdge: { from: string; to: string } | null;
  editingId: string | null;
  labels: CanvasLabels;
  /** Execution mode: dim by class, hide done tasks (via layoutOf), accent ready/active cards. */
  exec: boolean;
  /** done/total card members per frame id. */
  frameStats: ReadonlyMap<string, { done: number; total: number }>;
  images: ImageCache;
}

export interface Overlay {
  boxes: Bounds[];
  group: Bounds | null;
  handles: { pt: Point; round?: boolean }[];
  haloCards: Element[];
  marquee: Bounds | null;
  draftShape: { tool: string; b: Bounds } | null;
  draftLine: { pts: Point[]; head: boolean } | null;
  draftPencil: [number, number, number][] | null;
  bindTarget: Element | null;
  /** World points (top-right of the bounds) where a lock glyph is drawn for selected locked elements. */
  locks: Point[];
  /** Fading glow rects (world) for highlighted cards. */
  glows: { b: Bounds; alpha: number }[];
  ghosts: { stage: StageView; el: CardElement }[];
  ghostEdges: { a: CardRect; b: CardRect; soft: boolean }[];
  /** Smart-guide lines (world) shown while moving. */
  guides: Guide[];
  /** Bounds of elements the eraser has marked (dimmed preview). */
  erase: Bounds[];
}

/** A roughjs drawable flattened to Path2D parts, so redraws skip op-by-op replay. */
interface RoughPart { p: Path2D; fill: boolean; color: string; w: number; dash: number[]; evenodd: boolean }

function compileRough(ds: Drawable[]): RoughPart[] {
  const out: RoughPart[] = [];
  for (const d of ds) {
    const o = d.options;
    for (const set of d.sets) {
      if (set.type === 'fillSketch') continue; // only solid fills are generated
      const p = new Path2D();
      for (const it of set.ops) {
        if (it.op === 'move') p.moveTo(it.data[0], it.data[1]);
        else if (it.op === 'bcurveTo') p.bezierCurveTo(it.data[0], it.data[1], it.data[2], it.data[3], it.data[4], it.data[5]);
        else p.lineTo(it.data[0], it.data[1]);
      }
      const fill = set.type === 'fillPath';
      out.push({ p, fill, color: fill ? o.fill ?? '' : o.stroke === 'none' ? 'transparent' : o.stroke, w: o.strokeWidth, dash: o.strokeLineDash ?? [],
        evenodd: d.shape === 'curve' || d.shape === 'polygon' || d.shape === 'path' });
    }
  }
  return out;
}

const fontOf = (size: number, family: string, weight = 400) => `${weight} ${size}px ${family}`;
const textFamily = (t: ThemeTokens, style: 'clean' | 'sketch') => (style === 'sketch' ? t.fontHand : t.fontUi);

function dashOf(style: string | undefined, w: number): number[] {
  if (style === 'dashed') return [w * 6, w * 5];
  if (style === 'dotted') return [w, w * 3.5];
  return [];
}

export function freehandPath(pts: [number, number, number][], size: number): Path2D {
  const flat = pts.length > 0 && pts.every((p) => p[2] === pts[0][2]);
  const outline = getStroke(pts as unknown as number[][], { size, thinning: 0.5, smoothing: 0.5, streamline: 0.45, simulatePressure: flat });
  const p = new Path2D();
  if (outline.length < 2) return p;
  p.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < outline.length; i++) {
    const [x0, y0] = outline[i], [x1, y1] = outline[(i + 1) % outline.length];
    p.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  p.closePath();
  return p;
}

export class Renderer {
  private rc: RoughCanvas | null = null;
  private roughCache = new Map<string, { ver: number; d: RoughPart[] }>();
  private farTitles = new WeakMap<StageView, { font: string; lines: string[] }>();
  private cache: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; cam: Camera; mx: number; my: number; w: number; h: number; dpr: number; valid: boolean } | null = null;
  private pathCache = new Map<string, { ver: number; p: Path2D }>();
  private wrapCache = new Map<string, string[]>();

  constructor(private staticCanvas: HTMLCanvasElement) {}

  clearCaches() { this.roughCache.clear(); this.pathCache.clear(); this.wrapCache.clear(); this.farTitles = new WeakMap(); this.invalidateStatic(); }

  invalidateStatic() { if (this.cache) this.cache.valid = false; }

  // ---- static layer ------------------------------------------------------------------------

  /**
   * mode 'content': scene/theme/size changed -> draw directly, drop the bitmap cache.
   * mode 'camera': pan/zoom only -> blit the cached bitmap (re-render it when it no longer covers the view or is too scaled).
   * mode 'idle': camera settled -> re-render the cache crisp at the exact camera.
   */
  drawStatic(ctx: CanvasRenderingContext2D, s: RenderState, mode: StaticMode = 'content') {
    if (mode === 'content') { this.invalidateStatic(); this.drawDirect(ctx, s); return; }
    let c = this.cache;
    const fits = !!c && c.valid && c.w === s.width && c.h === s.height && c.dpr === s.dpr &&
      (mode === 'camera' ? cacheCovers(c.cam, s.cam, s.width, s.height, c.mx, c.my) : c.cam.scale === s.cam.scale && c.cam.x === s.cam.x && c.cam.y === s.cam.y);
    if (!fits) c = this.renderCache(s);
    if (!c) { this.drawDirect(ctx, s); return; }
    const m = cacheBlit(c.cam, s.cam, c.mx, c.my, s.dpr);
    ctx.setTransform(m.a, 0, 0, m.a, m.e, m.f);
    ctx.drawImage(c.canvas, 0, 0);
  }

  private renderCache(s: RenderState) {
    const { mx, my } = cacheMargin(s.width, s.height, s.dpr);
    const W = s.width + mx * 2, H = s.height + my * 2;
    let c = this.cache;
    if (!c) {
      const canvas = document.createElement('canvas');
      c = this.cache = { canvas, ctx: canvas.getContext('2d')!, cam: s.cam, mx, my, w: 0, h: 0, dpr: 1, valid: false };
    }
    c.valid = false;
    const pw = Math.round(W * s.dpr), ph = Math.round(H * s.dpr);
    if (c.canvas.width !== pw || c.canvas.height !== ph) { c.canvas.width = pw; c.canvas.height = ph; }
    this.drawDirect(c.ctx, { ...s, width: W, height: H, cam: { scale: s.cam.scale, x: s.cam.x + mx, y: s.cam.y + my } });
    Object.assign(c, { cam: s.cam, mx, my, w: s.width, h: s.height, dpr: s.dpr, valid: true });
    return c;
  }

  private drawDirect(ctx: CanvasRenderingContext2D, s: RenderState) {
    const { cam, dpr, theme } = s;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, Math.round(s.width * dpr), Math.round(s.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawGrid(ctx, s);
    ctx.setTransform(dpr * cam.scale, 0, 0, dpr * cam.scale, dpr * cam.x, dpr * cam.y);
    const vb = visibleBounds(cam, s.width, s.height);
    const pad = 40 / cam.scale;
    const view = { minX: vb.minX - pad, minY: vb.minY - pad, maxX: vb.maxX + pad, maxY: vb.maxY + pad };
    const list = s.scene.query(view);
    for (const el of list) if (el.type === 'frame') this.drawElement(ctx, el, s); // frames sit under everything
    this.drawEdges(ctx, s, view);
    for (const el of list) if (el.type !== 'frame') this.drawElement(ctx, el, s);
  }

  private drawGrid(ctx: CanvasRenderingContext2D, s: RenderState) {
    let step = 24;
    while (step * s.cam.scale < 14) step *= 2;
    const vb = visibleBounds(s.cam, s.width, s.height);
    const r = Math.max(0.7, Math.min(1.6, 1.1 * s.cam.scale));
    ctx.fillStyle = s.theme.grid;
    for (let x = Math.ceil(vb.minX / step) * step; x <= vb.maxX; x += step) {
      const sx = x * s.cam.scale + s.cam.x;
      for (let y = Math.ceil(vb.minY / step) * step; y <= vb.maxY; y += step) {
        ctx.fillRect(sx - r, y * s.cam.scale + s.cam.y - r, r * 2, r * 2);
      }
    }
  }

  private drawEdges(ctx: CanvasRenderingContext2D, s: RenderState, view: Bounds) {
    if (!s.edges.length) return;
    const t = s.theme;
    const cardEl = s.cards;
    for (const ed of s.edges) {
      const a = cardEl.get(ed.from), b = cardEl.get(ed.to);
      if (!a || !b) continue;
      const bz = edgeCurve(a, b);
      const xs = bz.map((p) => p[0]), ys = bz.map((p) => p[1]);
      if (Math.max(...xs) < view.minX || Math.min(...xs) > view.maxX || Math.max(...ys) < view.minY || Math.min(...ys) > view.maxY) continue;
      const sel = s.selEdge?.from === ed.from && s.selEdge.to === ed.to;
      const hi = sel || s.selected.has(a.id) || s.selected.has(b.id);
      const k = s.exec ? Math.max(execAlpha('card', s.stages.get(ed.from)?.status), execAlpha('card', s.stages.get(ed.to)?.status)) : 1;
      const color = hi ? t.accent : ed.fromDone ? mixColors(t.ok, t.edge, 0.7) : t.edge;
      ctx.save();
      ctx.globalAlpha = k;
      ctx.strokeStyle = color; ctx.fillStyle = color;
      ctx.lineWidth = sel ? 2.4 : hi ? 2 : 1.6;
      ctx.setLineDash(ed.soft ? [6, 5] : []);
      ctx.beginPath();
      ctx.moveTo(bz[0][0], bz[0][1]);
      ctx.bezierCurveTo(bz[1][0], bz[1][1], bz[2][0], bz[2][1], bz[3][0] - 6, bz[3][1]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(bz[3][0], bz[3][1]); ctx.lineTo(bz[3][0] - 9, bz[3][1] - 4.5); ctx.lineTo(bz[3][0] - 9, bz[3][1] + 4.5);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }
  }

  // ---- elements ----------------------------------------------------------------------------

  private drawElement(ctx: CanvasRenderingContext2D, el: Element, s: RenderState) {
    const dim = s.exec ? execAlpha(el.type, el.type === 'card' ? s.stages.get((el as CardElement).ref)?.status : undefined) : 1;
    if (lodDot(el, s.cam.scale)) {
      // sub-2px element: one filled rect instead of the real geometry
      const k = Math.max(1 / s.cam.scale, 0);
      ctx.fillStyle = (el.type === 'text' ? el.stroke ?? s.theme.text : el.stroke ?? s.theme.text2);
      if (dim !== 1) ctx.globalAlpha = dim;
      ctx.fillRect(el.x, el.y, Math.max(el.w, k), Math.max(el.h, k));
      if (dim !== 1) ctx.globalAlpha = 1;
      return;
    }
    ctx.save();
    if (el.opacity !== undefined || dim !== 1) ctx.globalAlpha = (el.opacity ?? 1) * dim;
    switch (el.type) {
      case 'rect': case 'ellipse': case 'diamond': case 'sticky': this.drawShape(ctx, el as ShapeElement, s); break;
      case 'text': this.drawText(ctx, el as TextElement, s); break;
      case 'line': case 'arrow': this.drawLinear(ctx, el as LinearElement, s); break;
      case 'freedraw': this.drawFree(ctx, el as FreedrawElement, s); break;
      case 'image': this.drawImage(ctx, el as ImageElement, s); break;
      case 'card': this.drawCard(ctx, el as CardElement, s); break;
      case 'frame': this.drawFrame(ctx, el, s); break;
      default: this.drawPlaceholder(ctx, el, s);
    }
    ctx.restore();
  }

  private rotateTo(ctx: CanvasRenderingContext2D, el: Element) {
    if (el.angle) {
      const c = elementCenter(el);
      ctx.translate(c[0], c[1]); ctx.rotate(el.angle); ctx.translate(-c[0], -c[1]);
    }
  }

  private roughOpts(el: Element, s: RenderState, fill: string | null): Options {
    const sw = el.strokeWidth ?? 1.5;
    const o: Options = {
      seed: el.seed ?? 1, roughness: el.roughness ?? 1, stroke: el.stroke ?? s.theme.text2, strokeWidth: sw,
      bowing: 1,
    };
    if (fill) { o.fill = fill; o.fillStyle = 'solid'; }
    const d = dashOf(el.strokeStyle, sw);
    if (d.length) o.strokeLineDash = d;
    return o;
  }

  private rough(): RoughCanvas {
    if (!this.rc) this.rc = rough.canvas(this.staticCanvas);
    return this.rc;
  }

  private cachedRough(el: Element, s: RenderState, make: (g: RoughCanvas['gen']) => Drawable[]): RoughPart[] {
    const ver = s.scene.version(el.id);
    const hit = this.roughCache.get(el.id);
    if (hit && hit.ver === ver) return hit.d;
    const d = compileRough(make(this.rough().generator));
    this.roughCache.set(el.id, { ver, d });
    return d;
  }

  private drawParts(ctx: CanvasRenderingContext2D, parts: RoughPart[]) {
    let dashed = false;
    for (const q of parts) {
      if (q.fill) { ctx.fillStyle = q.color; ctx.fill(q.p, q.evenodd ? 'evenodd' : 'nonzero'); continue; }
      ctx.strokeStyle = q.color; ctx.lineWidth = q.w;
      if (q.dash.length || dashed) { ctx.setLineDash(q.dash); dashed = q.dash.length > 0; }
      ctx.stroke(q.p);
    }
    if (dashed) ctx.setLineDash([]);
  }

  private shapeFill(el: ShapeElement, t: ThemeTokens): string | null {
    if (el.fill) return el.fill;
    if (el.type === 'sticky') return mixColors(t.warn, t.card, 0.22);
    return null;
  }

  private drawShape(ctx: CanvasRenderingContext2D, el: ShapeElement, s: RenderState) {
    const t = s.theme;
    this.rotateTo(ctx, el);
    ctx.translate(el.x, el.y);
    const fill = this.shapeFill(el, t), sticky = el.type === 'sticky';
    if (s.style === 'sketch' && lodSketch(s.cam.scale)) {
      const d = this.cachedRough(el, s, (g) => {
        const o = this.roughOpts(el, s, fill);
        if (el.type === 'ellipse') return [g.ellipse(el.w / 2, el.h / 2, el.w, el.h, o)];
        if (el.type === 'diamond') return [g.polygon([[el.w / 2, 0], [el.w, el.h / 2], [el.w / 2, el.h], [0, el.h / 2]], o)];
        return [g.rectangle(0, 0, el.w, el.h, o)];
      });
      this.drawParts(ctx, d);
    } else {
      ctx.beginPath();
      if (el.type === 'ellipse') ctx.ellipse(el.w / 2, el.h / 2, Math.abs(el.w / 2), Math.abs(el.h / 2), 0, 0, Math.PI * 2);
      else if (el.type === 'diamond') { ctx.moveTo(el.w / 2, 0); ctx.lineTo(el.w, el.h / 2); ctx.lineTo(el.w / 2, el.h); ctx.lineTo(0, el.h / 2); ctx.closePath(); }
      else ctx.roundRect(0, 0, el.w, el.h, Math.min(8, el.w / 4, el.h / 4));
      if (fill) {
        ctx.fillStyle = fill;
        if (sticky && s.cam.scale >= 0.4) { ctx.shadowColor = 'rgba(0,0,0,0.3)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 3; }
        ctx.fill();
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
      }
      ctx.strokeStyle = el.stroke ?? (sticky ? withAlpha(t.text2, 0.3) : t.text2);
      ctx.lineWidth = sticky ? 1 : el.strokeWidth ?? 1.5;
      ctx.setLineDash(dashOf(el.strokeStyle, ctx.lineWidth));
      ctx.stroke();
    }
    if (el.text && s.editingId !== el.id && sticky) {
      ctx.setLineDash([]);
      const size = el.fontSize ?? 18;
      const lines = lodTextPx(size, s.cam.scale) ? el.text.split('\n') : this.stickyLines(el.text, size, textFamily(t, s.style), el.w - STICKY_PAD * 2);
      this.drawLabel(ctx, lines.join('\n'), STICKY_PAD, STICKY_PAD, size, s, 'left', false, el.w - STICKY_PAD * 2);
    } else if (el.text && s.editingId !== el.id) {
      ctx.setLineDash([]);
      this.drawLabel(ctx, el.text, el.w / 2, el.h / 2, el.fontSize ?? 18, s, 'center', true, el.w * 0.8);
    }
  }

  /** Wrapped sticky text (cached per font/width/text). Line height is the shared 1.25. */
  private stickyLines(text: string, size: number, family: string, maxW: number): string[] {
    const font = fontOf(size, family), key = `s|${font}|${maxW}|${text}`;
    let v = this.wrapCache.get(key);
    if (!v) {
      v = wrapLines(text, maxW, (x) => measureText(x, font));
      if (this.wrapCache.size > 5000) this.wrapCache.clear();
      this.wrapCache.set(key, v);
    }
    return v;
  }

  private drawImage(ctx: CanvasRenderingContext2D, el: ImageElement, s: RenderState) {
    const t = s.theme, e = s.images.get(el.asset);
    this.rotateTo(ctx, el);
    if (e.status === 'ready' && e.img) {
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(e.img, el.x, el.y, el.w, el.h);
      return;
    }
    // placeholder while loading / after an error
    const err = e.status === 'error';
    ctx.beginPath(); ctx.roundRect(el.x, el.y, el.w, el.h, 6);
    ctx.fillStyle = withAlpha(t.card2, 0.7); ctx.fill();
    ctx.strokeStyle = err ? t.bad : t.border2; ctx.lineWidth = 1; ctx.setLineDash([5, 4]); ctx.stroke(); ctx.setLineDash([]);
    const m = Math.min(el.w, el.h);
    if (m * s.cam.scale < 14) return;
    const k = Math.min(m * 0.4, 48 / s.cam.scale), cx = el.x + el.w / 2, cy = el.y + el.h / 2 - (err ? k * 0.2 : 0);
    ctx.save();
    ctx.translate(cx - k / 2, cy - k / 2); ctx.scale(k / 24, k / 24);
    ctx.strokeStyle = err ? t.bad : t.muted; ctx.lineWidth = 1.5 / ((k / 24) * s.cam.scale); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.roundRect(2, 3, 20, 18, 3);
    ctx.moveTo(2, 17); ctx.lineTo(8, 11); ctx.lineTo(13, 16); ctx.lineTo(16, 13); ctx.lineTo(22, 19);
    ctx.moveTo(15.5, 8); ctx.arc(14.5, 8, 1.2, 0, Math.PI * 2);
    if (err) { ctx.moveTo(3, 3); ctx.lineTo(21, 21); }
    ctx.stroke();
    ctx.restore();
    if (err && m * s.cam.scale >= 60) {
      ctx.font = fontOf(12 / Math.max(s.cam.scale, 0.6), t.fontUi); ctx.fillStyle = t.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(s.labels.imageBroken, cx, cy + k / 2 + 6 / s.cam.scale);
    }
  }

  /** Text too small to read: one thin translucent bar per line, no font work. */
  private textBars(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, align: CanvasTextAlign, maxW: number, color: string, scale: number) {
    const lh = size * 1.25, bh = Math.max(size * 0.3, 1 / scale);
    ctx.globalAlpha *= 0.45; ctx.fillStyle = color;
    let ty = y;
    for (const ln of text.split('\n')) {
      const bw = Math.min(maxW, ln.length * size * 0.5);
      ctx.fillRect(align === 'center' ? x - bw / 2 : align === 'right' ? x - bw : x, ty + (lh - bh) / 2, bw, bh);
      ty += lh;
    }
  }

  private drawLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, s: RenderState, align: CanvasTextAlign, middle: boolean, maxW = Infinity) {
    if (lodTextPx(size, s.cam.scale)) {
      const n = text.split('\n').length;
      this.textBars(ctx, text, x, middle ? y - (n * size * 1.25) / 2 : y, size, align, maxW, s.theme.text, s.cam.scale);
      return;
    }
    ctx.fillStyle = s.theme.text;
    ctx.font = fontOf(size, textFamily(s.theme, s.style));
    ctx.textAlign = align;
    ctx.textBaseline = 'top';
    const lines = text.split('\n'), lh = size * 1.25;
    let ty = middle ? y - (lines.length * lh) / 2 : y;
    for (const ln of lines) { ctx.fillText(ln, x, ty); ty += lh; }
  }

  private drawText(ctx: CanvasRenderingContext2D, el: TextElement, s: RenderState) {
    if (s.editingId === el.id) return;
    this.rotateTo(ctx, el);
    const align = el.align ?? 'left';
    const x = align === 'left' ? el.x : align === 'center' ? el.x + el.w / 2 : el.x + el.w;
    if (lodTextPx(el.fontSize, s.cam.scale)) { this.textBars(ctx, el.text, x, el.y, el.fontSize, align, el.w, el.stroke ?? s.theme.text, s.cam.scale); return; }
    ctx.fillStyle = el.stroke ?? s.theme.text;
    ctx.font = fontOf(el.fontSize, textFamily(s.theme, s.style));
    ctx.textBaseline = 'top';
    ctx.textAlign = align;
    let y = el.y;
    for (const ln of el.text.split('\n')) { ctx.fillText(ln, x, y); y += el.fontSize * 1.25; }
  }

  private headLines(tip: Point, from: Point, size: number): [Point, Point] {
    const a = Math.atan2(tip[1] - from[1], tip[0] - from[0]), o = 0.45;
    return [
      [tip[0] - size * Math.cos(a - o), tip[1] - size * Math.sin(a - o)],
      [tip[0] - size * Math.cos(a + o), tip[1] - size * Math.sin(a + o)],
    ];
  }

  private drawLinear(ctx: CanvasRenderingContext2D, el: LinearElement, s: RenderState) {
    const pts = absPoints(el);
    if (pts.length < 2) return;
    const sw = el.strokeWidth ?? 1.5;
    const endHead = (el.endHead ?? (el.type === 'arrow' ? 'arrow' : 'none')) === 'arrow';
    const startHead = (el.startHead ?? 'none') === 'arrow';
    const size = 10 + sw * 2;
    const heads: Point[][] = [];
    if (endHead) { const [a, b] = this.headLines(pts[pts.length - 1], pts[pts.length - 2], size); heads.push([a, pts[pts.length - 1], b]); }
    if (startHead) { const [a, b] = this.headLines(pts[0], pts[1], size); heads.push([a, pts[0], b]); }
    if (s.style === 'sketch' && lodSketch(s.cam.scale)) {
      const d = this.cachedRough(el, s, (g) => {
        const o = this.roughOpts(el, s, null);
        const solid = { ...o, strokeLineDash: undefined };
        return [g.linearPath(pts, o), ...heads.map((h) => g.linearPath(h, solid))];
      });
      this.drawParts(ctx, d);
      return;
    }
    ctx.strokeStyle = el.stroke ?? s.theme.text2;
    ctx.lineWidth = sw; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.setLineDash(dashOf(el.strokeStyle, sw));
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const h of heads) { ctx.beginPath(); ctx.moveTo(h[0][0], h[0][1]); ctx.lineTo(h[1][0], h[1][1]); ctx.lineTo(h[2][0], h[2][1]); ctx.stroke(); }
  }

  private drawFree(ctx: CanvasRenderingContext2D, el: FreedrawElement, s: RenderState) {
    const ver = s.scene.version(el.id);
    let hit = this.pathCache.get(el.id);
    if (!hit || hit.ver !== ver) {
      hit = { ver, p: freehandPath(el.points, (el.strokeWidth ?? 1.5) * 2.6) };
      this.pathCache.set(el.id, hit);
    }
    ctx.translate(el.x, el.y);
    ctx.fillStyle = el.stroke ?? s.theme.text2;
    ctx.fill(hit.p);
  }

  private drawFrame(ctx: CanvasRenderingContext2D, el: Element, s: RenderState) {
    const t = s.theme, sketch = s.style === 'sketch' && lodSketch(s.cam.scale);
    ctx.beginPath();
    ctx.roundRect(el.x, el.y, el.w, el.h, 18);
    ctx.fillStyle = withAlpha(t.card, 0.25); ctx.fill();
    if (sketch) {
      const d = this.cachedRough(el, s, (g) => [g.rectangle(el.x, el.y, el.w, el.h, {
        seed: el.seed ?? 1, roughness: el.roughness ?? 1, stroke: t.border2, strokeWidth: 1.4, bowing: 1, strokeLineDash: [8, 6],
      })]);
      this.drawParts(ctx, d);
    } else { ctx.strokeStyle = t.border2; ctx.lineWidth = 1; ctx.setLineDash([6, 5]); ctx.stroke(); ctx.setLineDash([]); }
    this.drawFrameHeader(ctx, el, s);
  }

  /** Name + mini progress bar + "{done} of {total} stages" above the top-left corner; screen-constant size, LOD below 0.5x. */
  private drawFrameHeader(ctx: CanvasRenderingContext2D, el: Element, s: RenderState) {
    const t = s.theme, name = (el as { name?: string }).name ?? '';
    const hd = frameHeaderRect(el, s.cam.scale), sketch = s.style === 'sketch';
    const fs = hd.fs * (sketch ? 1.2 : 1), cy = hd.y + hd.h / 2, px = el.x + hd.fs * 0.5;
    const st = s.frameStats.get(el.id);
    const barW = hd.fs * 5, barH = Math.max(hd.fs * 0.28, 1 / s.cam.scale);
    const family = textFamily(t, s.style), nameFont = fontOf(100, family, 600);
    const wOf = (txt: string, weight: number, size: number) => (measureText(txt, fontOf(100, family, weight)) * size) / 100;
    const label = st ? s.labels.frameProgress.replace('{done}', String(st.done)).replace('{total}', String(st.total)) : '';
    const small = fs * 0.85, labelW = label ? wOf(label, 400, small) : 0;
    const extra = st ? barW + labelW + fs * 1.1 : 0;
    const nameMax = Math.max(el.w - extra - fs, fs * 7);
    const bar = (x: number) => {
      ctx.fillStyle = t.border; ctx.beginPath(); ctx.roundRect(x, cy - barH / 2, barW, barH, barH / 2); ctx.fill();
      if (st && st.done > 0) { ctx.fillStyle = t.ok; ctx.beginPath(); ctx.roundRect(x, cy - barH / 2, Math.max(barH, (barW * st.done) / st.total), barH, barH / 2); ctx.fill(); }
    };
    if (lodTextPx(fs, s.cam.scale)) {
      if (!name && !st) return;
      this.textBars(ctx, name, px, cy - fs * 0.625, fs, 'left', nameMax, t.text2, s.cam.scale);
      if (st) bar(px + Math.min(nameMax, name.length * fs * 0.5) + fs * 0.5);
      return;
    }
    let x = px;
    if (name) {
      const shown = ellipsize(name, (nameMax * 100) / fs, (q) => measureText(q, nameFont));
      ctx.font = fontOf(fs, family, 600); ctx.fillStyle = t.text2; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.fillText(shown, x, cy);
      x += (measureText(shown, nameFont) * fs) / 100 + fs * 0.6;
    }
    if (st) {
      bar(x);
      ctx.font = fontOf(small, family, 400); ctx.fillStyle = t.muted; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.fillText(label, x + barW + fs * 0.5, cy);
    }
  }

  private drawPlaceholder(ctx: CanvasRenderingContext2D, el: Element, s: RenderState) {
    const t = s.theme;
    ctx.beginPath(); ctx.roundRect(el.x, el.y, el.w, el.h, 6);
    ctx.strokeStyle = t.border2; ctx.setLineDash([4, 4]); ctx.lineWidth = 1; ctx.stroke();
    ctx.font = fontOf(11, t.fontMono); ctx.fillStyle = t.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(el.type, el.x + el.w / 2, el.y + el.h / 2);
  }

  // ---- stage card --------------------------------------------------------------------------

  private wrapped(text: string, font: string, maxW: number, lines: number): string[] {
    const key = `${font}|${maxW}|${lines}|${text}`;
    let v = this.wrapCache.get(key);
    if (!v) {
      v = wrapText(text, maxW, (x) => measureText(x, font), lines);
      if (this.wrapCache.size > 5000) this.wrapCache.clear();
      this.wrapCache.set(key, v);
    }
    return v;
  }

  private farTitle(stage: StageView, font: string): string[] {
    const hit = this.farTitles.get(stage);
    if (hit && hit.font === font) return hit.lines;
    const lines = this.wrapped(stage.title, font, CARD_W - CARD.padX * 2, 3);
    this.farTitles.set(stage, { font, lines });
    return lines;
  }

  /** Card at scale < 0.35: no header/task/footer text is measured or drawn; title text only if >= 4px, else bars. */
  private drawCardTiny(ctx: CanvasRenderingContext2D, stage: StageView, L: CardLayout, H: number, s: RenderState) {
    const t = s.theme, px = CARD.padX, W = CARD_W, cy = CARD.padTop + CARD.headH / 2;
    const fg = stage.status === 'done' ? t.ok : stage.status === 'active' ? t.warn : stage.status === 'ready' ? t.accent : t.muted;
    const a0 = ctx.globalAlpha;
    ctx.fillStyle = fg; ctx.globalAlpha = a0 * 0.5;
    ctx.fillRect(W - px - 74, cy - 10, 74, 20);
    ctx.fillRect(px, cy - 5, 36, 10);
    ctx.globalAlpha = a0;
    const tsize = s.style === 'sketch' ? 30 : 24, lh = tsize * 1.2;
    if (tsize * s.cam.scale >= TEXT_MIN_PX) {
      const tfont = fontOf(tsize, textFamily(t, s.style), 600);
      ctx.font = tfont; ctx.fillStyle = t.text; ctx.textBaseline = 'top'; ctx.textAlign = 'left';
      this.farTitle(stage, tfont).forEach((ln, i) => ctx.fillText(ln, px, L.titleY + i * lh + (lh - tsize) / 2 - 1));
    } else {
      ctx.fillStyle = t.text; ctx.globalAlpha = a0 * 0.45;
      const n = Math.min(3, Math.max(1, L.titleLines.length));
      for (let i = 0; i < n; i++) ctx.fillRect(px, L.titleY + i * lh + lh * 0.3, i === n - 1 && n > 1 ? (W - px * 2) * 0.6 : W - px * 2, lh * 0.4);
      ctx.globalAlpha = a0;
    }
    const [d, n] = stage.progress;
    const y = H - CARD.padBottom - CARD.progH + CARD.progH / 2 - 2;
    ctx.fillStyle = t.border; ctx.fillRect(px, y, W - px * 2, 4);
    if (n > 0 && d > 0) { ctx.fillStyle = t.ok; ctx.fillRect(px, y, Math.max(4, ((W - px * 2) * d) / n), 4); }
  }

  private drawCard(ctx: CanvasRenderingContext2D, el: CardElement, s: RenderState, ghost?: StageView) {
    const t = s.theme, stage = ghost ?? s.stages.get(el.ref);
    ctx.translate(el.x, el.y);
    const W = CARD_W, H = el.h, r = t.radiusCard;
    if (s.cam.scale >= 0.4) { ctx.shadowColor = 'rgba(0,0,0,0.28)'; ctx.shadowBlur = 14; ctx.shadowOffsetY = 4; }
    ctx.beginPath(); ctx.roundRect(0, 0, W, H, r);
    ctx.fillStyle = stage ? t.card : mixColors(t.card2, t.card, 0.6);
    ctx.fill();
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    ctx.strokeStyle = t.border; ctx.lineWidth = 1;
    if (!stage) ctx.setLineDash([6, 4]);
    ctx.stroke();
    if (s.exec && stage && (stage.status === 'ready' || stage.status === 'active')) { ctx.strokeStyle = t.accent; ctx.lineWidth = 2.5; ctx.stroke(); }
    ctx.setLineDash([]);
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    if (!stage) {
      ctx.font = fontOf(12, t.fontMono, 500); ctx.fillStyle = t.muted;
      ctx.fillText(el.ref, CARD.padX, H / 2 - 10);
      ctx.font = fontOf(12, t.fontUi); ctx.fillText(s.labels.missingStage, CARD.padX, H / 2 + 8);
      return;
    }
    const L = s.layoutOf(stage), far = s.cam.scale < 0.55;
    const px = CARD.padX, cy = CARD.padTop + CARD.headH / 2;
    if (s.cam.scale < 0.35) { this.drawCardTiny(ctx, stage, L, H, s); return; }
    // header: key, who chip, status pill
    ctx.font = fontOf(11, t.fontMono); ctx.fillStyle = t.muted;
    ctx.fillText(stage.key, px, cy);
    let x = px + measureText(stage.key, ctx.font) + 6;
    const whoText = (stage.who === 'me' ? s.labels.whoMe : stage.who === 'ai' ? s.labels.whoAi : s.labels.whoBoth).toUpperCase();
    ctx.font = fontOf(10, t.fontUi);
    const ww = measureText(whoText, ctx.font) + 12;
    ctx.beginPath(); ctx.roundRect(x, cy - 8, ww, 16, 5); ctx.fillStyle = t.card2; ctx.fill();
    ctx.fillStyle = stage.who === 'ai' ? t.accent : t.text2;
    ctx.fillText(whoText, x + 6, cy + 0.5);
    this.drawPill(ctx, stage, W - px, cy, s);
    // title
    const tsize = far ? (s.style === 'sketch' ? 30 : 24) : s.style === 'sketch' ? 22 : 15;
    const tfont = fontOf(tsize, textFamily(t, s.style), 600);
    const lines = far ? this.farTitle(stage, tfont) : L.titleLines;
    const lh = far ? tsize * 1.2 : L.titleLH;
    ctx.font = tfont; ctx.fillStyle = t.text; ctx.textBaseline = 'top';
    lines.forEach((ln, i) => ctx.fillText(ln, px, L.titleY + i * lh + (lh - tsize) / 2 - 1));
    // progress
    const progY = far ? H - CARD.padBottom - CARD.progH : L.progY;
    const [d, n] = stage.progress;
    ctx.font = fontOf(11, t.fontUi); ctx.textBaseline = 'middle';
    const ptxt = `${d}/${n}`;
    const pw = measureText(ptxt, ctx.font);
    const barW = W - px * 2 - pw - 8;
    ctx.fillStyle = t.border; ctx.beginPath(); ctx.roundRect(px, progY + CARD.progH / 2 - 2, barW, 4, 2); ctx.fill();
    if (n > 0 && d > 0) { ctx.fillStyle = t.ok; ctx.beginPath(); ctx.roundRect(px, progY + CARD.progH / 2 - 2, Math.max(4, (barW * d) / n), 4, 2); ctx.fill(); }
    ctx.fillStyle = t.muted; ctx.textAlign = 'right'; ctx.fillText(ptxt, W - px, progY + CARD.progH / 2 + 0.5); ctx.textAlign = 'left';
    if (far) return;
    // tasks
    for (const row of L.tasks) this.drawTaskRow(ctx, row.task, row.y, s);
    if (L.hiddenTasks > 0) {
      ctx.font = fontOf(11, t.fontUi); ctx.fillStyle = t.muted;
      ctx.fillText(s.labels.moreTasks.replace('{n}', String(L.hiddenTasks)), px + CARD.chk + 7, L.moreY + CARD.taskGap + CARD.taskH / 2);
    }
    // footer
    if (L.footerY !== null) {
      ctx.fillStyle = t.border; ctx.fillRect(px, L.footerY, W - px * 2, 1);
      const fy = L.footerY + 1 + CARD.footPad + CARD.footH / 2;
      let fx = px;
      ctx.font = fontOf(11, t.fontUi);
      if (stage.due) { this.icon(ctx, 'cal', fx, fy, t.muted); ctx.fillStyle = t.muted; ctx.fillText(stage.due, fx + 16, fy); fx += 16 + measureText(stage.due, ctx.font) + 12; }
      if (stage.priority === 'high') { this.icon(ctx, 'flag', fx, fy, t.warn); ctx.fillStyle = t.warn; ctx.fillText(s.labels.priorityHigh, fx + 16, fy); fx += 16 + measureText(s.labels.priorityHigh, ctx.font) + 12; }
      if (stage.branch) {
        this.icon(ctx, 'branch', fx, fy, t.muted); ctx.fillStyle = t.muted;
        ctx.fillText(ellipsize(stage.branch, Math.max(30, W - px - fx - 16), (x2) => measureText(x2, ctx.font)), fx + 16, fy);
      }
    }
  }

  private drawTaskRow(ctx: CanvasRenderingContext2D, task: CardLayout['tasks'][number]['task'], y: number, s: RenderState) {
    const t = s.theme, px = CARD.padX, cy = y + CARD.taskH / 2, done = taskDone(task);
    const cx = px + CARD.chk / 2 + 1;
    ctx.beginPath(); ctx.arc(cx, cy, CARD.chk / 2 - 0.5, 0, Math.PI * 2);
    if (done) {
      ctx.fillStyle = t.ok; ctx.fill();
      ctx.strokeStyle = t.onAccent; ctx.lineWidth = 1.6; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(cx - 3.2, cy + 0.2); ctx.lineTo(cx - 0.8, cy + 2.6); ctx.lineTo(cx + 3.4, cy - 2.4); ctx.stroke();
    } else { ctx.strokeStyle = t.border2; ctx.lineWidth = 1.5; ctx.stroke(); }
    let x = px + CARD.chk + 7;
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.font = fontOf(10, t.fontMono); ctx.fillStyle = t.muted;
    ctx.fillText(task.id, x, cy + 0.5);
    x += measureText(task.id, ctx.font) + 7;
    let right = CARD_W - px;
    if (task.sub.length) {
      const sc = `${task.sub.filter(taskDone).length}/${task.sub.length}`;
      ctx.textAlign = 'right'; ctx.fillText(sc, right, cy + 0.5); ctx.textAlign = 'left';
      right -= measureText(sc, ctx.font) + 7;
    }
    ctx.font = fontOf(12, t.fontUi); ctx.fillStyle = done ? t.muted : t.text2;
    ctx.fillText(ellipsize(task.title, right - x, (q) => measureText(q, ctx.font)), x, cy + 0.5);
  }

  private drawPill(ctx: CanvasRenderingContext2D, stage: StageView, right: number, cy: number, s: RenderState) {
    const L = s.labels;
    const text = { done: L.statusDone, active: L.statusActive, ready: L.statusReady, blocked: L.statusBlocked }[stage.status];
    const { fg, bg } = statusColors(stage.status, s.theme);
    ctx.font = fontOf(11, s.theme.fontUi);
    const w = measureText(text, ctx.font) + 14 + 13 + 4, h = 20, x = right - w;
    ctx.beginPath(); ctx.roundRect(x, cy - h / 2, w, h, h / 2); ctx.fillStyle = bg; ctx.fill();
    this.statusIcon(ctx, stage.status, x + 7 + 6.5, cy, fg);
    ctx.fillStyle = fg; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(text, x + 7 + 13 + 4, cy + 0.5);
  }

  private statusIcon(ctx: CanvasRenderingContext2D, st: string, cx: number, cy: number, color: string) {
    ctx.save();
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    if (st === 'done') {
      ctx.arc(cx, cy, 5.5, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - 2.4, cy + 0.2); ctx.lineTo(cx - 0.6, cy + 2); ctx.lineTo(cx + 2.6, cy - 1.8); ctx.stroke();
    } else if (st === 'active') {
      ctx.arc(cx, cy, 5.5, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, 3.2, -Math.PI / 2, Math.PI / 2); ctx.closePath(); ctx.fill();
    } else if (st === 'ready') {
      ctx.moveTo(cx - 2.8, cy - 4); ctx.lineTo(cx + 4, cy); ctx.lineTo(cx - 2.8, cy + 4); ctx.closePath(); ctx.fill();
    } else {
      ctx.roundRect(cx - 3.8, cy - 0.5, 7.6, 5.6, 1.2); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy - 0.8, 2.5, Math.PI, 0); ctx.stroke();
    }
    ctx.restore();
  }

  private icon(ctx: CanvasRenderingContext2D, kind: 'cal' | 'flag' | 'branch', x: number, cy: number, color: string) {
    ctx.save();
    ctx.translate(x, cy - 6);
    ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    if (kind === 'cal') { ctx.roundRect(1, 2, 10, 9, 2); ctx.moveTo(1, 5.5); ctx.lineTo(11, 5.5); ctx.moveTo(4, 0.5); ctx.lineTo(4, 3); ctx.moveTo(8, 0.5); ctx.lineTo(8, 3); }
    else if (kind === 'flag') { ctx.moveTo(2.5, 11.5); ctx.lineTo(2.5, 1); ctx.lineTo(10.5, 3.5); ctx.lineTo(2.5, 6.5); }
    else { ctx.arc(3, 2.5, 1.5, 0, 6.3); ctx.moveTo(4.5, 9.5); ctx.arc(3, 9.5, 1.5, 0, 6.3); ctx.moveTo(10.5, 4.5); ctx.arc(9, 4.5, 1.5, 0, 6.3); ctx.moveTo(3, 4); ctx.lineTo(3, 8); ctx.moveTo(9, 6); ctx.quadraticCurveTo(9, 8, 3, 8); }
    ctx.stroke();
    ctx.restore();
  }

  // ---- interactive layer -------------------------------------------------------------------

  private drawGhosts(ctx: CanvasRenderingContext2D, s: RenderState, o: Overlay) {
    const { cam, dpr, theme: t } = s;
    const world = () => ctx.setTransform(dpr * cam.scale, 0, 0, dpr * cam.scale, dpr * cam.x, dpr * cam.y);
    ctx.save();
    world();
    ctx.strokeStyle = t.accent; ctx.fillStyle = t.accent; ctx.lineWidth = 1.6; ctx.globalAlpha = 0.85;
    for (const e of o.ghostEdges) {
      const bz = edgeCurve(e.a, e.b);
      ctx.setLineDash([6, 5]);
      ctx.beginPath(); ctx.moveTo(bz[0][0], bz[0][1]);
      ctx.bezierCurveTo(bz[1][0], bz[1][1], bz[2][0], bz[2][1], bz[3][0] - 6, bz[3][1]); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(bz[3][0], bz[3][1]); ctx.lineTo(bz[3][0] - 9, bz[3][1] - 4.5); ctx.lineTo(bz[3][0] - 9, bz[3][1] + 4.5); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
    for (const g of o.ghosts) {
      ctx.save();
      world();
      ctx.globalAlpha = 0.6;
      this.drawCard(ctx, g.el, s, g.stage);
      ctx.restore();
      ctx.save();
      world();
      ctx.translate(g.el.x, g.el.y);
      ctx.strokeStyle = t.accent; ctx.lineWidth = 2; ctx.setLineDash([8, 5]);
      ctx.beginPath(); ctx.roundRect(0, 0, CARD_W, g.el.h, t.radiusCard); ctx.stroke(); ctx.setLineDash([]);
      ctx.font = fontOf(10, t.fontUi, 600);
      const label = s.labels.ghostBadge, bw = measureText(label, ctx.font) + 14;
      ctx.beginPath(); ctx.roundRect(CARD.padX, -9, bw, 18, 9); ctx.fillStyle = t.accent; ctx.fill();
      if (cam.scale >= 0.3) { ctx.fillStyle = t.onAccent; ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.fillText(label, CARD.padX + 7, 0.5); }
      ctx.restore();
    }
  }

  drawInteractive(ctx: CanvasRenderingContext2D, s: RenderState, o: Overlay) {
    const { cam, dpr, theme: t } = s;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, s.width, s.height);
    const S = (p: Point) => worldToScreen(cam, p);
    const rectS = (b: Bounds, pad = 0): [number, number, number, number] => {
      const a = S([b.minX, b.minY]), c = S([b.maxX, b.maxY]);
      return [a[0] - pad, a[1] - pad, c[0] - a[0] + pad * 2, c[1] - a[1] + pad * 2];
    };
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    if (o.ghosts.length) this.drawGhosts(ctx, s, o);
    for (const g of o.glows) {
      const [x, y, w, h] = rectS(g.b);
      const r = t.radiusCard * cam.scale;
      ctx.beginPath(); ctx.roundRect(x, y, w, h, r);
      ctx.fillStyle = withAlpha(t.accent, 0.12 * g.alpha); ctx.fill();
      ctx.save();
      ctx.shadowColor = t.accent; ctx.shadowBlur = 26 * g.alpha;
      ctx.strokeStyle = withAlpha(t.accent, 0.9 * g.alpha); ctx.lineWidth = 3;
      ctx.stroke();
      ctx.restore();
    }
    for (const el of o.haloCards) {
      const [x, y, w, h] = rectS({ minX: el.x, minY: el.y, maxX: el.x + el.w, maxY: el.y + el.h });
      const r = t.radiusCard * cam.scale;
      ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.strokeStyle = withAlpha(t.accent, 0.25); ctx.lineWidth = 6; ctx.stroke();
      ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.strokeStyle = t.accent; ctx.lineWidth = 1.5; ctx.stroke();
    }
    ctx.strokeStyle = t.accent; ctx.lineWidth = 1;
    for (const b of o.boxes) { const [x, y, w, h] = rectS(b, 3); ctx.strokeRect(x, y, w, h); }
    if (o.group) { const [x, y, w, h] = rectS(o.group, 5); ctx.setLineDash([5, 4]); ctx.strokeRect(x, y, w, h); ctx.setLineDash([]); }
    for (const h of o.handles) {
      const [x, y] = S(h.pt);
      ctx.beginPath();
      if (h.round) ctx.arc(x, y, 5, 0, Math.PI * 2); else ctx.rect(x - 4, y - 4, 8, 8);
      ctx.fillStyle = t.card; ctx.fill(); ctx.strokeStyle = t.accent; ctx.lineWidth = 1.5; ctx.stroke();
    }
    for (const pt of o.locks) {
      const [x, y] = S(pt), cx = x + 10, cy = y - 10;
      ctx.beginPath(); ctx.arc(cx, cy, 9, 0, Math.PI * 2); ctx.fillStyle = t.card; ctx.fill(); ctx.strokeStyle = t.accent; ctx.lineWidth = 1.2; ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy - 1.5, 2.8, Math.PI, 0); ctx.stroke();
      ctx.beginPath(); ctx.roundRect(cx - 4, cy - 1.5, 8, 6, 1.2); ctx.fillStyle = t.accent; ctx.fill();
    }
    if (o.bindTarget) {
      const e = o.bindTarget;
      const [x, y, w, h] = rectS({ minX: e.x, minY: e.y, maxX: e.x + e.w, maxY: e.y + e.h }, 5);
      ctx.strokeStyle = t.accent; ctx.lineWidth = 2; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.roundRect(x, y, w, h, 8); ctx.stroke(); ctx.setLineDash([]);
    }
    for (const b of o.erase) {
      const [x, y, w, h] = rectS(b, 2);
      ctx.fillStyle = withAlpha(t.bg, 0.65); ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = t.bad; ctx.lineWidth = 1.2; ctx.setLineDash([4, 3]); ctx.strokeRect(x, y, w, h); ctx.setLineDash([]);
    }
    if (o.guides.length) {
      ctx.strokeStyle = t.bad; ctx.lineWidth = 1; ctx.beginPath();
      for (const g of o.guides) {
        if (g.axis === 'x') { const a = S([g.pos, g.from]), b = S([g.pos, g.to]); ctx.moveTo(Math.round(a[0]) + 0.5, a[1] - 6); ctx.lineTo(Math.round(b[0]) + 0.5, b[1] + 6); }
        else { const a = S([g.from, g.pos]), b = S([g.to, g.pos]); ctx.moveTo(a[0] - 6, Math.round(a[1]) + 0.5); ctx.lineTo(b[0] + 6, Math.round(b[1]) + 0.5); }
      }
      ctx.stroke();
    }
    if (o.marquee) {
      const [x, y, w, h] = rectS(o.marquee);
      ctx.fillStyle = withAlpha(t.accent, 0.1); ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = t.accent; ctx.lineWidth = 1; ctx.strokeRect(x, y, w, h);
    }
    if (o.draftShape) {
      const [x, y, w, h] = rectS(o.draftShape.b);
      ctx.strokeStyle = t.accent; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
      ctx.beginPath();
      if (o.draftShape.tool === 'ellipse') ctx.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
      else if (o.draftShape.tool === 'diamond') { ctx.moveTo(x + w / 2, y); ctx.lineTo(x + w, y + h / 2); ctx.lineTo(x + w / 2, y + h); ctx.lineTo(x, y + h / 2); ctx.closePath(); }
      else if (o.draftShape.tool === 'stage') ctx.roundRect(x, y, w, h, t.radiusCard * cam.scale);
      else ctx.rect(x, y, w, h);
      ctx.stroke(); ctx.setLineDash([]);
    }
    if (o.draftLine && o.draftLine.pts.length >= 2) {
      const pts = o.draftLine.pts.map(S);
      ctx.strokeStyle = t.accent; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]); ctx.stroke();
      if (o.draftLine.head) {
        const [a, b] = this.headLines(pts[pts.length - 1], pts[pts.length - 2], 12);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      }
    }
    if (o.draftPencil && o.draftPencil.length) {
      ctx.save();
      ctx.setTransform(dpr * cam.scale, 0, 0, dpr * cam.scale, dpr * cam.x, dpr * cam.y);
      ctx.fillStyle = t.text2;
      ctx.fill(freehandPath(o.draftPencil, 4));
      ctx.restore();
    }
  }
}

