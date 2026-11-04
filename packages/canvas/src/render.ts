import rough from 'roughjs';
import type { RoughCanvas } from 'roughjs/bin/canvas';
import type { Drawable, Options } from 'roughjs/bin/core';
import getStroke from 'perfect-freehand';
import type { CardElement, Element, FreedrawElement, LinearElement, ShapeElement, StageView, TextElement, ThemeTokens } from './types';
import type { Camera } from './camera';
import { visibleBounds, worldToScreen } from './camera';
import { absPoints, elementCenter, type Bounds, type Point } from './geometry';
import type { Scene } from './scene';
import { CARD, CARD_W, edgeCurve, ellipsize, mixColors, statusColors, taskDone, withAlpha, wrapText, type CardLayout, type DepEdge } from './stage';
import { measureText } from './measure';
import type { CanvasLabels } from './editor-types';

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
  selected: ReadonlySet<string>;
  selEdge: { from: string; to: string } | null;
  editingId: string | null;
  labels: CanvasLabels;
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
  private roughCache = new Map<string, { ver: number; d: Drawable[] }>();
  private pathCache = new Map<string, { ver: number; p: Path2D }>();
  private wrapCache = new Map<string, string[]>();

  constructor(private staticCanvas: HTMLCanvasElement) {}

  clearCaches() { this.roughCache.clear(); this.pathCache.clear(); this.wrapCache.clear(); }

  // ---- static layer ------------------------------------------------------------------------

  drawStatic(ctx: CanvasRenderingContext2D, s: RenderState) {
    const { cam, dpr, theme } = s;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, s.width * dpr, s.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawGrid(ctx, s);
    ctx.setTransform(dpr * cam.scale, 0, 0, dpr * cam.scale, dpr * cam.x, dpr * cam.y);
    const vb = visibleBounds(cam, s.width, s.height);
    const pad = 40 / cam.scale;
    const view = { minX: vb.minX - pad, minY: vb.minY - pad, maxX: vb.maxX + pad, maxY: vb.maxY + pad };
    this.drawEdges(ctx, s, view);
    for (const el of s.scene.query(view)) this.drawElement(ctx, el, s);
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
    const cardEl = new Map<string, Element>();
    for (const e of s.scene.all()) if (e.type === 'card') cardEl.set((e as CardElement).ref, e);
    for (const ed of s.edges) {
      const a = cardEl.get(ed.from), b = cardEl.get(ed.to);
      if (!a || !b) continue;
      const bz = edgeCurve(a, b);
      const xs = bz.map((p) => p[0]), ys = bz.map((p) => p[1]);
      if (Math.max(...xs) < view.minX || Math.min(...xs) > view.maxX || Math.max(...ys) < view.minY || Math.min(...ys) > view.maxY) continue;
      const sel = s.selEdge?.from === ed.from && s.selEdge.to === ed.to;
      const hi = sel || s.selected.has(a.id) || s.selected.has(b.id);
      const color = hi ? t.accent : ed.fromDone ? mixColors(t.ok, t.edge, 0.7) : t.edge;
      ctx.save();
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
    ctx.save();
    if (el.opacity !== undefined) ctx.globalAlpha = el.opacity;
    switch (el.type) {
      case 'rect': case 'ellipse': case 'diamond': case 'sticky': this.drawShape(ctx, el as ShapeElement, s); break;
      case 'text': this.drawText(ctx, el as TextElement, s); break;
      case 'line': case 'arrow': this.drawLinear(ctx, el as LinearElement, s); break;
      case 'freedraw': this.drawFree(ctx, el as FreedrawElement, s); break;
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

  private cachedRough(el: Element, s: RenderState, make: (g: RoughCanvas['gen']) => Drawable[]): Drawable[] {
    const ver = s.scene.version(el.id);
    const hit = this.roughCache.get(el.id);
    if (hit && hit.ver === ver) return hit.d;
    const d = make(this.rough().generator);
    this.roughCache.set(el.id, { ver, d });
    return d;
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
    const fill = this.shapeFill(el, t);
    if (s.style === 'sketch') {
      const d = this.cachedRough(el, s, (g) => {
        const o = this.roughOpts(el, s, fill);
        if (el.type === 'ellipse') return [g.ellipse(el.w / 2, el.h / 2, el.w, el.h, o)];
        if (el.type === 'diamond') return [g.polygon([[el.w / 2, 0], [el.w, el.h / 2], [el.w / 2, el.h], [0, el.h / 2]], o)];
        return [g.rectangle(0, 0, el.w, el.h, o)];
      });
      for (const dr of d) this.rough().draw(dr);
    } else {
      ctx.beginPath();
      if (el.type === 'ellipse') ctx.ellipse(el.w / 2, el.h / 2, Math.abs(el.w / 2), Math.abs(el.h / 2), 0, 0, Math.PI * 2);
      else if (el.type === 'diamond') { ctx.moveTo(el.w / 2, 0); ctx.lineTo(el.w, el.h / 2); ctx.lineTo(el.w / 2, el.h); ctx.lineTo(0, el.h / 2); ctx.closePath(); }
      else ctx.roundRect(0, 0, el.w, el.h, Math.min(8, el.w / 4, el.h / 4));
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      ctx.strokeStyle = el.stroke ?? t.text2;
      ctx.lineWidth = el.strokeWidth ?? 1.5;
      ctx.setLineDash(dashOf(el.strokeStyle, ctx.lineWidth));
      ctx.stroke();
    }
    if (el.text && s.editingId !== el.id) {
      ctx.setLineDash([]);
      this.drawLabel(ctx, el.text, el.w / 2, el.h / 2, el.fontSize ?? 18, s, 'center', true);
    }
  }

  private drawLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, s: RenderState, align: CanvasTextAlign, middle: boolean) {
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
    ctx.fillStyle = el.stroke ?? s.theme.text;
    ctx.font = fontOf(el.fontSize, textFamily(s.theme, s.style));
    ctx.textBaseline = 'top';
    const align = el.align ?? 'left';
    ctx.textAlign = align;
    const x = align === 'left' ? el.x : align === 'center' ? el.x + el.w / 2 : el.x + el.w;
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
    if (s.style === 'sketch') {
      const d = this.cachedRough(el, s, (g) => {
        const o = this.roughOpts(el, s, null);
        const solid = { ...o, strokeLineDash: undefined };
        return [g.linearPath(pts, o), ...heads.map((h) => g.linearPath(h, solid))];
      });
      for (const dr of d) this.rough().draw(dr);
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
    const t = s.theme;
    ctx.beginPath();
    ctx.roundRect(el.x, el.y, el.w, el.h, 18);
    ctx.fillStyle = withAlpha(t.card, 0.25); ctx.fill();
    ctx.strokeStyle = t.border2; ctx.lineWidth = 1; ctx.setLineDash([6, 5]); ctx.stroke();
    ctx.setLineDash([]);
    const name = (el as { name?: string }).name;
    if (name) {
      ctx.font = fontOf(12, t.fontUi, 500); ctx.fillStyle = t.text2;
      ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
      ctx.fillText(name, el.x + 6, el.y - 10);
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

  private drawCard(ctx: CanvasRenderingContext2D, el: CardElement, s: RenderState) {
    const t = s.theme, stage = s.stages.get(el.ref);
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
    const lines = far ? this.wrapped(stage.title, tfont, W - px * 2, 3) : L.titleLines;
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
    if (o.bindTarget) {
      const e = o.bindTarget;
      const [x, y, w, h] = rectS({ minX: e.x, minY: e.y, maxX: e.x + e.w, maxY: e.y + e.h }, 5);
      ctx.strokeStyle = t.accent; ctx.lineWidth = 2; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.roundRect(x, y, w, h, 8); ctx.stroke(); ctx.setLineDash([]);
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

