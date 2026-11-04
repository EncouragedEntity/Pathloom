import type { Board, CardElement, Element, LinearElement, FreedrawElement, StageView, TextElement, ThemeTokens } from './types';
import type { CanvasHost, CanvasLabels, Editor, EditorOptions, EditorStats, Tool } from './editor-types';
import { DEFAULT_LABELS } from './editor-types';
import { Scene } from './scene';
import { History, type Change } from './history';
import { clampScale, fitBounds, screenToWorld, worldToScreen, zoomAt, type Camera } from './camera';
import {
  absPoints, boundaryPoint, distToBezier, elementBounds, elementCenter, isFreedraw, isLinear, isPointy, pointsBounds,
  unionBounds, withPointBounds, type Bounds, type Point,
} from './geometry';
import { newId, newSeed } from './id';
import { keyAfter } from './index-key';
import { CARD_W, MISSING_H, cardLayout, edgeCurve, extractEdges, hitCheckbox, type CardLayout, type DepEdge } from './stage';
import { clearMeasureCache, measureText } from './measure';
import { Renderer, type Overlay, type RenderState } from './render';

type Dir = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const DIRS: Dir[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const CURSORS: Record<Dir, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };
const BINDABLE = new Set(['rect', 'ellipse', 'diamond', 'card', 'sticky', 'text', 'image']);
const TOOL_KEYS: Record<string, Tool> = { v: 'select', '1': 'select', h: 'hand', '2': 'rect', '3': 'diamond', '4': 'ellipse', '5': 'arrow', l: 'line', '6': 'pencil', '7': 'text', s: 'stage' };
const clone = <T>(x: T): T => structuredClone(x);

type Gesture =
  | { kind: 'pan'; last: Point }
  | { kind: 'move'; start: Point; startScreen: Point; orig: Map<string, Element>; moved: boolean; shift: boolean; hitId: string }
  | { kind: 'resize'; dir: Dir; B: Bounds; orig: Map<string, Element>; shift: boolean }
  | { kind: 'endpoint'; id: string; idx: number; orig: LinearElement }
  | { kind: 'marquee'; start: Point; base: Set<string> }
  | { kind: 'create'; tool: Tool; start: Point; startScreen: Point; cur: Point; shift: boolean }
  | { kind: 'linear'; tool: Tool; start: Point; startScreen: Point; startEl: Element | null; cur: Point; endEl: Element | null }
  | { kind: 'pencil'; pts: [number, number, number][] }
  | { kind: 'text-click'; at: Point; target: Element | null };

export function createEditor(container: HTMLElement, opts: EditorOptions): Editor {
  return new EditorImpl(container, opts);
}

class EditorImpl implements Editor {
  private scene = new Scene();
  private history = new History();
  private host: CanvasHost;
  private theme: ThemeTokens;
  private style: 'clean' | 'sketch';
  private labels: CanvasLabels;
  private title: string;
  private cam: Camera = { x: 0, y: 0, scale: 1 };
  private tool: Tool = 'select';
  private stages = new Map<string, StageView>();
  private stagesRev = 0;
  private layouts = new WeakMap<StageView, CardLayout>();
  private selected = new Set<string>();
  private selEdge: { from: string; to: string } | null = null;
  private lastSelKey = '';
  private tx: Map<string, Element | null> | null = null;
  private gesture: Gesture | null = null;
  private clip: Element[] = [];
  private pasteN = 0;
  private spaceDown = false;
  private hoverCursor = '';
  private lastScale = 1;
  private draft: Partial<Overlay> = {};
  private edit: { ta: HTMLTextAreaElement; id: string | null; at: Point; shapeId: string | null } | null = null;
  private editingId: string | null = null;
  private toastEl: HTMLElement | null = null;
  private toastTimer = 0;
  private edgeCache: { rev: number; srev: number; edges: DepEdge[]; cards: Map<string, CardElement> } | null = null;

  private sCanvas: HTMLCanvasElement;
  private iCanvas: HTMLCanvasElement;
  private sCtx: CanvasRenderingContext2D;
  private iCtx: CanvasRenderingContext2D;
  private renderer: Renderer;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private dirtyS = true;
  private dirtyI = true;
  private raf = 0;
  private destroyed = false;
  private autoFit = true; // refit on resize until the user navigates
  private ro: ResizeObserver;
  private stats: EditorStats = { frames: 0, lastFrameMs: 0, totalFrameMs: 0, elements: 0 };
  private fontsHandler = () => { this.invalidateLayout(); };

  constructor(private container: HTMLElement, opts: EditorOptions) {
    this.host = opts.host;
    this.theme = opts.theme;
    this.style = opts.style ?? opts.board.style ?? 'clean';
    this.labels = { ...DEFAULT_LABELS, ...opts.labels };
    this.title = opts.board.title;
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    container.style.overflow = 'hidden';
    container.style.touchAction = 'none';
    container.style.userSelect = 'none';
    const mk = () => {
      const c = document.createElement('canvas');
      c.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;display:block;';
      container.appendChild(c);
      return c;
    };
    this.sCanvas = mk(); this.iCanvas = mk();
    this.sCtx = this.sCanvas.getContext('2d')!; this.iCtx = this.iCanvas.getContext('2d')!;
    this.renderer = new Renderer(this.sCanvas);
    this.stages = new Map(opts.stages.map((s) => [s.key, s]));

    const ic = this.iCanvas;
    ic.addEventListener('pointerdown', this.onDown);
    ic.addEventListener('pointermove', this.onMove);
    ic.addEventListener('pointerup', this.onUp);
    ic.addEventListener('pointercancel', this.onUp);
    ic.addEventListener('dblclick', this.onDbl);
    ic.addEventListener('wheel', this.onWheel, { passive: false });
    ic.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    document.fonts?.addEventListener?.('loadingdone', this.fontsHandler);
    this.ro = new ResizeObserver(() => { this.resize(); if (this.autoFit) this.zoomToFit(); });
    this.ro.observe(container);
    this.resize();
    this.loadBoard(opts.board);
    this.zoomToFit();
  }

  // ---- public API --------------------------------------------------------------------------

  setBoard(board: Board) {
    this.cancelEdit();
    this.title = board.title;
    this.style = board.style ?? this.style;
    this.loadBoard(board);
    this.autoFit = true;
    this.history.clear();
    this.selected.clear(); this.selEdge = null;
    this.emitSelection();
    this.zoomToFit();
  }

  setStages(stages: StageView[]) {
    this.stages = new Map(stages.map((s) => [s.key, s]));
    this.stagesRev++;
    this.layouts = new WeakMap();
    this.relayoutCards(true);
    this.emitSelection();
    this.invalidate();
  }

  setTheme(theme: ThemeTokens) { this.theme = theme; this.invalidateLayout(); }

  setStyle(style: 'clean' | 'sketch') { this.style = style; this.invalidateLayout(); }

  setTool(tool: Tool) {
    if (tool === this.tool) return;
    this.commitEdit();
    this.tool = tool;
    this.gesture = null; this.draft = {};
    if (tool !== 'select') { this.selEdge = null; }
    this.host.onToolChange(tool);
    this.updateCursor();
    this.invalidate(false, true);
  }

  getTool() { return this.tool; }

  undo() { this.applyHistory(this.history.undo(), 'before'); }
  redo() { this.applyHistory(this.history.redo(), 'after'); }

  zoomToFit() {
    const b = unionBounds(this.scene.all().map(elementBounds));
    this.setCamera(fitBounds(b, this.width, this.height));
  }

  zoomTo(scale: number) { this.autoFit = false; this.setCamera(zoomAt(this.cam, scale, [this.width / 2, this.height / 2])); }
  getZoom() { return this.cam.scale; }

  focusElement(id: string) {
    const el = this.scene.get(id);
    if (!el) return;
    const c = elementCenter(el);
    const sc = this.cam.scale;
    this.setCamera({ scale: sc, x: this.width / 2 - c[0] * sc, y: this.height / 2 - c[1] * sc });
    this.selected = new Set([id]); this.selEdge = null;
    this.emitSelection();
    this.invalidate();
  }

  getBoard(): Board {
    return { format: 'pathloom.board/1', title: this.title, style: this.style, elements: this.scene.all().map(clone) };
  }

  panBy(dx: number, dy: number) { this.autoFit = false; this.setCamera({ ...this.cam, x: this.cam.x + dx, y: this.cam.y + dy }); }
  getStats() { return { ...this.stats, elements: this.scene.size }; }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.cancelEdit();
    this.ro.disconnect();
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    document.fonts?.removeEventListener?.('loadingdone', this.fontsHandler);
    this.sCanvas.remove(); this.iCanvas.remove(); this.toastEl?.remove();
  }

  async convertSelectionToStage() {
    const el = this.singleSelected();
    if (!el || el.locked || !['rect', 'ellipse', 'diamond'].includes(el.type)) return;
    const label = ((el as { text?: string }).text ?? '').trim() || this.labels.newStage;
    let view: StageView;
    try { view = await this.host.createStage(label); } catch (e) { this.toast(String(e)); return; }
    this.stages.set(view.key, view); this.stagesRev++;
    const cur = this.scene.get(el.id);
    if (!cur) return;
    this.act(() => {
      const card: CardElement = { id: newId(), type: 'card', ref: view.key, x: cur.x, y: cur.y, w: CARD_W, h: this.layoutOf(view).h, index: cur.index };
      this.del(cur.id);
      this.put(card);
      for (const o of [...this.scene.all()]) {
        if (!isLinear(o)) continue;
        const n = { ...o };
        if (o.start?.el === cur.id) n.start = { el: card.id };
        if (o.end?.el === cur.id) n.end = { el: card.id };
        if (n.start !== o.start || n.end !== o.end) this.put(n);
      }
      this.reroute(new Set([card.id]));
      this.selected = new Set([card.id]);
    });
    this.emitSelection();
  }

  // ---- scene plumbing ----------------------------------------------------------------------

  private loadBoard(board: Board) {
    this.scene.load(board.elements.map(clone));
    this.relayoutCards(false);
    this.remeasureTexts();
    this.invalidate();
  }

  private invalidateLayout() {
    clearMeasureCache();
    this.layouts = new WeakMap();
    this.renderer.clearCaches();
    this.relayoutCards(false);
    this.remeasureTexts();
    for (const ed of this.edit ? [this.edit] : []) this.styleTa(ed.ta, ed.shapeId ? this.scene.get(ed.shapeId) ?? null : null);
    this.invalidate();
  }

  private titleSize() { return this.style === 'sketch' ? 22 : 15; }
  private titleFont() { return `600 ${this.titleSize()}px ${this.style === 'sketch' ? this.theme.fontHand : this.theme.fontUi}`; }

  private layoutOf = (s: StageView): CardLayout => {
    let l = this.layouts.get(s);
    if (!l) {
      const font = this.titleFont();
      l = cardLayout(s, (t) => measureText(t, font), this.style === 'sketch' ? 27 : 20);
      this.layouts.set(s, l);
    }
    return l;
  };

  /** Store computed card heights back on the elements (and keep bound arrows attached). */
  private relayoutCards(emit: boolean) {
    const changed = new Set<string>();
    for (const el of this.scene.all()) {
      if (el.type !== 'card') continue;
      const st = this.stages.get((el as CardElement).ref);
      const h = st ? this.layoutOf(st).h : MISSING_H;
      if (el.h !== h || el.w !== CARD_W) { this.scene.set({ ...el, w: CARD_W, h }); changed.add(el.id); }
    }
    if (changed.size) { this.reroute(changed); if (emit) this.emitBoard(); }
  }

  private blockSize(text: string, size: number): { w: number; h: number } {
    const font = `${size}px ${this.style === 'sketch' ? this.theme.fontHand : this.theme.fontUi}`;
    const lines = text.split('\n');
    return { w: Math.max(...lines.map((l) => measureText(l, font))) + 2, h: lines.length * size * 1.25 };
  }

  private remeasureTexts() {
    for (const el of this.scene.all()) {
      if (el.type !== 'text') continue;
      const t = el as TextElement, m = this.blockSize(t.text, t.fontSize);
      if (Math.abs(m.w - t.w) > 0.5 || Math.abs(m.h - t.h) > 0.5) this.scene.set({ ...t, w: m.w, h: m.h });
    }
  }

  private nextIndex() {
    const all = this.scene.all();
    return keyAfter(all.length ? all[all.length - 1].index : null);
  }

  private base(type: Element['type'], x: number, y: number, w: number, h: number) {
    return { id: newId(), type, x, y, w, h, angle: 0, index: this.nextIndex(), seed: newSeed(), roughness: 1, strokeWidth: 1.5 };
  }

  // transactions: every put/del during an action is snapshotted; `end` pushes one history entry.
  private begin() { if (!this.tx) this.tx = new Map(); }
  private touch(id: string) {
    if (this.tx && !this.tx.has(id)) { const e = this.scene.get(id); this.tx.set(id, e ? clone(e) : null); }
  }
  private put(el: Element) { this.touch(el.id); this.scene.set(el); this.invalidate(); }
  private del(id: string) { this.touch(id); this.scene.remove(id); this.selected.delete(id); this.invalidate(); }
  private end(): boolean {
    const tx = this.tx; this.tx = null;
    if (!tx) return false;
    const changes: Change[] = [];
    for (const [id, before] of tx) {
      const cur = this.scene.get(id) ?? null;
      if (JSON.stringify(before) !== JSON.stringify(cur)) changes.push({ id, before, after: cur ? clone(cur) : null });
    }
    if (!changes.length) return false;
    this.history.push({ changes });
    this.emitBoard();
    return true;
  }
  private rollback() {
    const tx = this.tx; this.tx = null;
    if (!tx) return;
    for (const [id, before] of tx) { if (before) this.scene.set(before); else this.scene.remove(id); }
    this.invalidate();
  }
  private act(fn: () => void) { this.begin(); try { fn(); } finally { this.end(); } }

  private applyHistory(entry: { changes: Change[] } | null, side: 'before' | 'after') {
    if (!entry) return;
    this.cancelEdit();
    for (const c of entry.changes) {
      const el = c[side];
      if (el) this.scene.set(clone(el)); else this.scene.remove(c.id);
    }
    for (const id of [...this.selected]) if (!this.scene.has(id)) this.selected.delete(id);
    this.emitBoard(); this.emitSelection(); this.invalidate();
  }

  private emitBoard() { this.host.onBoardChange(this.getBoard()); }

  private singleSelected(): Element | null {
    if (this.selected.size !== 1) return null;
    return this.scene.get([...this.selected][0]) ?? null;
  }

  private emitSelection() {
    const ids = [...this.selected].filter((id) => this.scene.has(id));
    const one = ids.length === 1 ? this.scene.get(ids[0]) : null;
    const stageKey = one?.type === 'card' ? (one as CardElement).ref : null;
    const key = ids.join(',') + '|' + stageKey + '|' + (this.selEdge ? this.selEdge.from + '>' + this.selEdge.to : '');
    if (key === this.lastSelKey) return;
    this.lastSelKey = key;
    this.host.onSelectionChange({ elementIds: ids, stageKey });
    this.invalidate(false, true);
  }

  // ---- arrows / binding --------------------------------------------------------------------

  private route(sEl: Element | null, eEl: Element | null, sp: Point, ep: Point): [Point, Point] {
    const a = sEl ? boundaryPoint(sEl, eEl ? elementCenter(eEl) : ep) : sp;
    const b = eEl ? boundaryPoint(eEl, sEl ? elementCenter(sEl) : sp) : ep;
    return [a, b];
  }

  private withAbs(el: LinearElement, abs: Point[]): LinearElement {
    return withPointBounds({ ...el, x: abs[0][0], y: abs[0][1], points: abs.map((p) => [p[0] - abs[0][0], p[1] - abs[0][1]] as Point) });
  }

  private rerouteOne(el: LinearElement) {
    const sEl = el.start ? this.scene.get(el.start.el) ?? null : null;
    const eEl = el.end ? this.scene.get(el.end.el) ?? null : null;
    if (!sEl && !eEl) return;
    const pts = absPoints(el);
    const [a, b] = this.route(sEl, eEl, pts[0], pts[pts.length - 1]);
    pts[0] = a; pts[pts.length - 1] = b;
    this.put(this.withAbs(el, pts));
  }

  /** Re-route arrows bound to any of `ids`. */
  private reroute(ids: Set<string>) {
    for (const el of this.scene.all()) {
      if (isLinear(el) && ((el.start && ids.has(el.start.el)) || (el.end && ids.has(el.end.el)))) this.rerouteOne(el);
    }
  }

  private unbindFrom(ids: Set<string>) {
    for (const el of [...this.scene.all()]) {
      if (!isLinear(el)) continue;
      const hitS = el.start && ids.has(el.start.el), hitE = el.end && ids.has(el.end.el);
      if (!hitS && !hitE) continue;
      const n = { ...el };
      if (hitS) delete n.start;
      if (hitE) delete n.end;
      this.put(n);
    }
  }

  // ---- hit testing -------------------------------------------------------------------------

  private tol() { return 6 / this.cam.scale; }
  private bindableAt(p: Point, exclude?: string): Element | null {
    return this.scene.hit(p, this.tol(), (e) => BINDABLE.has(e.type) && e.id !== exclude, true);
  }

  private edges() {
    const c = this.edgeCache;
    if (c && c.rev === this.scene.rev && c.srev === this.stagesRev) return c;
    const cards = new Map<string, CardElement>();
    for (const e of this.scene.all()) if (e.type === 'card') cards.set((e as CardElement).ref, e as CardElement);
    const edges = extractEdges([...this.stages.values()], new Set(cards.keys()));
    this.edgeCache = { rev: this.scene.rev, srev: this.stagesRev, edges, cards };
    return this.edgeCache;
  }

  private edgeAt(p: Point): DepEdge | null {
    const { edges, cards } = this.edges();
    let best: DepEdge | null = null, bd = this.tol() + 2;
    for (const ed of edges) {
      const a = cards.get(ed.from), b = cards.get(ed.to);
      if (!a || !b) continue;
      const d = distToBezier(p, edgeCurve(a, b));
      if (d < bd) { bd = d; best = ed; }
    }
    return best;
  }

  private selBounds(): Bounds | null {
    const els = [...this.selected].map((id) => this.scene.get(id)).filter((e): e is Element => !!e);
    return unionBounds(els.map(elementBounds));
  }

  private handlePoints(): { dir?: Dir; idx?: number; pt: Point; round?: boolean }[] {
    const els = [...this.selected].map((id) => this.scene.get(id)).filter((e): e is Element => !!e);
    if (!els.length) return [];
    if (els.length === 1 && isLinear(els[0])) {
      const pts = absPoints(els[0]);
      return [{ idx: 0, pt: pts[0], round: true }, { idx: pts.length - 1, pt: pts[pts.length - 1], round: true }];
    }
    if (els.every((e) => e.type === 'card')) return [];
    const b = unionBounds(els.map(elementBounds))!;
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    const pos: Record<Dir, Point> = {
      nw: [b.minX, b.minY], n: [cx, b.minY], ne: [b.maxX, b.minY], e: [b.maxX, cy],
      se: [b.maxX, b.maxY], s: [cx, b.maxY], sw: [b.minX, b.maxY], w: [b.minX, cy],
    };
    return DIRS.map((d) => ({ dir: d, pt: pos[d] }));
  }

  private handleAt(screen: Point) {
    for (const h of this.handlePoints()) {
      const s = worldToScreen(this.cam, h.pt);
      if (Math.hypot(s[0] - screen[0], s[1] - screen[1]) <= 8) return h;
    }
    return null;
  }

  private checkboxAt(el: Element, p: Point): string | null {
    if (el.type !== 'card') return null;
    const st = this.stages.get((el as CardElement).ref);
    if (!st) return null;
    return hitCheckbox(this.layoutOf(st), p[0] - el.x, p[1] - el.y);
  }

  // ---- camera ------------------------------------------------------------------------------

  private setCamera(c: Camera) {
    this.cam = { ...c, scale: clampScale(c.scale) };
    if (this.cam.scale !== this.lastScale) { this.lastScale = this.cam.scale; this.host.onZoomChange(this.cam.scale); }
    this.invalidate();
  }

  private toWorld(e: { clientX: number; clientY: number }): { s: Point; w: Point } {
    const r = this.container.getBoundingClientRect();
    const s: Point = [e.clientX - r.left, e.clientY - r.top];
    return { s, w: screenToWorld(this.cam, s) };
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.autoFit = false;
    const { s } = this.toWorld(e);
    const mouse = e.deltaMode !== 0 ||
      (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 100 && (Math.abs(e.deltaY) % 100 === 0 || Math.abs(e.deltaY) % 120 === 0));
    if (e.ctrlKey || e.metaKey) {
      this.setCamera(zoomAt(this.cam, this.cam.scale * Math.exp(-e.deltaY * 0.01), s));
    } else if (mouse) {
      const dy = e.deltaMode === 0 ? e.deltaY : e.deltaY * 33;
      this.setCamera(zoomAt(this.cam, this.cam.scale * Math.exp(-dy * 0.0015), s));
    } else {
      const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX, dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
      this.setCamera({ ...this.cam, x: this.cam.x - dx, y: this.cam.y - dy });
    }
  };

  // ---- pointer -----------------------------------------------------------------------------

  private onDown = (e: PointerEvent) => {
    // Any interaction ends auto-fit, so side panels opening later don't move the view.
    this.autoFit = false;
    this.commitEdit();
    this.iCanvas.setPointerCapture(e.pointerId);
    const { s, w } = this.toWorld(e);
    if (e.button === 1 || e.button === 2 || this.spaceDown || this.tool === 'hand') {
      e.preventDefault();
      this.gesture = { kind: 'pan', last: s };
      this.updateCursor(true);
      return;
    }
    if (e.button !== 0) return;
    const shift = e.shiftKey;
    switch (this.tool) {
      case 'select': this.downSelect(s, w, shift); break;
      case 'rect': case 'ellipse': case 'diamond':
        this.gesture = { kind: 'create', tool: this.tool, start: w, startScreen: s, cur: w, shift };
        break;
      case 'arrow': case 'line': {
        const startEl = this.bindableAt(w);
        this.gesture = { kind: 'linear', tool: this.tool, start: w, startScreen: s, startEl, cur: w, endEl: null };
        break;
      }
      case 'pencil': this.gesture = { kind: 'pencil', pts: [[w[0], w[1], e.pointerType === 'pen' ? e.pressure : 0.5]] }; break;
      case 'text': {
        const t = this.scene.hit(w, this.tol(), (x) => x.type === 'text' || x.type === 'rect' || x.type === 'ellipse' || x.type === 'diamond');
        this.gesture = { kind: 'text-click', at: w, target: t };
        break;
      }
      case 'stage': void this.placeStage(w); break;
    }
    this.invalidate(false, true);
  };

  private downSelect(s: Point, w: Point, shift: boolean) {
    const h = this.handleAt(s);
    if (h) {
      if (h.idx !== undefined) {
        const el = this.singleSelected() as LinearElement;
        if (!el.locked) this.gesture = { kind: 'endpoint', id: el.id, idx: h.idx, orig: clone(el) };
      } else if (h.dir) {
        const B = this.selBounds()!;
        const orig = new Map<string, Element>();
        for (const id of this.selected) { const el = this.scene.get(id); if (el && !el.locked) orig.set(id, clone(el)); }
        if (orig.size) this.gesture = { kind: 'resize', dir: h.dir, B, orig, shift };
      }
      return;
    }
    const hit = this.scene.hit(w, this.tol());
    if (hit) {
      const cb = this.checkboxAt(hit, w);
      if (cb) {
        this.selected = new Set([hit.id]); this.selEdge = null; this.emitSelection();
        this.host.toggleTask(cb).catch((err) => this.toast(String(err)));
        return;
      }
      this.selEdge = null;
      if (shift && this.selected.has(hit.id)) { this.selected.delete(hit.id); this.emitSelection(); return; }
      if (shift) this.selected.add(hit.id);
      else if (!this.selected.has(hit.id)) this.selected = new Set([hit.id]);
      this.emitSelection();
      const orig = new Map<string, Element>();
      for (const id of this.selected) { const el = this.scene.get(id); if (el && !el.locked) orig.set(id, clone(el)); }
      this.gesture = { kind: 'move', start: w, startScreen: s, orig, moved: false, shift, hitId: hit.id };
      return;
    }
    const ed = this.edgeAt(w);
    if (ed) { this.selected.clear(); this.selEdge = { from: ed.from, to: ed.to }; this.emitSelection(); return; }
    const base = shift ? new Set(this.selected) : new Set<string>();
    if (!shift && (this.selected.size || this.selEdge)) { this.selected.clear(); this.selEdge = null; this.emitSelection(); }
    this.gesture = { kind: 'marquee', start: w, base };
  }

  private onMove = (e: PointerEvent) => {
    const { s, w } = this.toWorld(e);
    const g = this.gesture;
    if (!g) { this.hover(s, w); return; }
    switch (g.kind) {
      case 'pan':
        this.autoFit = false;
        this.setCamera({ ...this.cam, x: this.cam.x + s[0] - g.last[0], y: this.cam.y + s[1] - g.last[1] });
        g.last = s;
        break;
      case 'move': this.moveDrag(g, s, w); break;
      case 'resize': g.shift = e.shiftKey; this.resizeDrag(g, w); break;
      case 'endpoint': this.endpointDrag(g, w); break;
      case 'marquee': {
        const b: Bounds = { minX: Math.min(g.start[0], w[0]), minY: Math.min(g.start[1], w[1]), maxX: Math.max(g.start[0], w[0]), maxY: Math.max(g.start[1], w[1]) };
        this.draft = { marquee: b };
        const ids = new Set(g.base);
        for (const el of this.scene.intersecting(b)) ids.add(el.id);
        this.selected = ids;
        this.invalidate(false, true);
        break;
      }
      case 'create': {
        g.cur = w; g.shift = e.shiftKey;
        this.draft = { draftShape: { tool: g.tool, b: this.shapeBounds(g.start, w, g.shift) } };
        this.invalidate(false, true);
        break;
      }
      case 'linear': {
        g.cur = w;
        g.endEl = this.bindableAt(w, g.startEl?.id);
        const [a, b] = this.route(g.startEl, g.endEl, g.start, w);
        this.draft = { draftLine: { pts: [a, b], head: g.tool === 'arrow' }, bindTarget: g.endEl ?? (g.startEl) };
        this.invalidate(false, true);
        break;
      }
      case 'pencil': {
        const last = g.pts[g.pts.length - 1];
        if (Math.hypot(w[0] - last[0], w[1] - last[1]) * this.cam.scale >= 1.5) g.pts.push([w[0], w[1], e.pointerType === 'pen' ? e.pressure : 0.5]);
        this.draft = { draftPencil: g.pts };
        this.invalidate(false, true);
        break;
      }
    }
  };

  private onUp = (e: PointerEvent) => {
    const g = this.gesture;
    this.gesture = null;
    this.draft = {};
    if (this.iCanvas.hasPointerCapture(e.pointerId)) this.iCanvas.releasePointerCapture(e.pointerId);
    const { s, w } = this.toWorld(e);
    if (!g) return;
    switch (g.kind) {
      case 'pan': break;
      case 'move':
        if (g.moved) this.end();
        else if (!g.shift && this.selected.size > 1) { this.selected = new Set([g.hitId]); this.emitSelection(); }
        break;
      case 'resize': this.end(); break;
      case 'endpoint': this.finishEndpoint(g, w); break;
      case 'marquee': this.emitSelection(); break;
      case 'create': this.finishCreate(g, s, w); break;
      case 'linear': this.finishLinear(g, s, w); break;
      case 'pencil': this.finishPencil(g); break;
      case 'text-click': this.startEdit(g.target, g.at); break;
    }
    this.updateCursor();
    this.invalidate(false, true);
  };

  private onDbl = (e: MouseEvent) => {
    if (this.tool !== 'select') return;
    const { w } = this.toWorld(e);
    const hit = this.scene.hit(w, this.tol());
    if (hit) {
      if (hit.type === 'card') { if (!this.checkboxAt(hit, w)) this.host.openStage((hit as CardElement).ref); return; }
      if (hit.type === 'text' || hit.type === 'rect' || hit.type === 'ellipse' || hit.type === 'diamond' || hit.type === 'sticky') this.startEdit(hit, w);
      return;
    }
    if (this.edgeAt(w)) return;
    this.startEdit(null, w);
  };

  private hover(s: Point, w: Point) {
    let cur = '';
    if (this.tool === 'select') {
      const h = this.handleAt(s);
      if (h) cur = h.dir ? CURSORS[h.dir] : 'crosshair';
      else {
        const hit = this.scene.hit(w, this.tol());
        if (hit && this.checkboxAt(hit, w)) cur = 'pointer';
        else if (hit) cur = 'move';
        else if (this.edgeAt(w)) cur = 'pointer';
      }
    }
    if (cur !== this.hoverCursor) { this.hoverCursor = cur; this.updateCursor(); }
  }

  private updateCursor(grabbing = false) {
    let c = this.hoverCursor || 'default';
    if (grabbing) c = 'grabbing';
    else if (this.spaceDown || this.tool === 'hand') c = 'grab';
    else if (this.tool === 'text') c = 'text';
    else if (this.tool !== 'select') c = 'crosshair';
    this.iCanvas.style.cursor = c;
  }

  // ---- gestures ----------------------------------------------------------------------------

  private moveDrag(g: Extract<Gesture, { kind: 'move' }>, s: Point, w: Point) {
    if (!g.moved) {
      if (Math.hypot(s[0] - g.startScreen[0], s[1] - g.startScreen[1]) < 3) return;
      if (!g.orig.size) return;
      g.moved = true;
      this.begin();
      // arrows dragged without their targets lose those bindings
      for (const o of g.orig.values()) {
        if (!isLinear(o)) continue;
        const n = { ...o };
        if (o.start && !g.orig.has(o.start.el)) { delete n.start; }
        if (o.end && !g.orig.has(o.end.el)) { delete n.end; }
        g.orig.set(o.id, n);
        if (n.start !== o.start || n.end !== o.end) this.put(n);
      }
    }
    const dx = w[0] - g.start[0], dy = w[1] - g.start[1];
    const moved = new Set<string>();
    for (const o of g.orig.values()) { this.put({ ...o, x: o.x + dx, y: o.y + dy }); if (!isLinear(o)) moved.add(o.id); }
    this.reroute(moved);
  }

  private resizeDrag(g: Extract<Gesture, { kind: 'resize' }>, w: Point) {
    this.begin();
    const B = g.B;
    let { minX, minY, maxX, maxY } = B;
    if (g.dir.includes('w')) minX = Math.min(w[0], maxX - 4);
    if (g.dir.includes('e')) maxX = Math.max(w[0], minX + 4);
    if (g.dir.includes('n')) minY = Math.min(w[1], maxY - 4);
    if (g.dir.includes('s')) maxY = Math.max(w[1], minY + 4);
    const ow = Math.max(B.maxX - B.minX, 1e-6), oh = Math.max(B.maxY - B.minY, 1e-6);
    let sx = (maxX - minX) / ow, sy = (maxY - minY) / oh;
    if (g.shift && g.dir.length === 2) {
      const k = Math.abs(sx - 1) > Math.abs(sy - 1) ? sx : sy;
      sx = sy = k;
      if (g.dir.includes('w')) minX = maxX - ow * k;
      if (g.dir.includes('n')) minY = maxY - oh * k;
      maxX = minX + ow * k; maxY = minY + oh * k;
      if (g.dir.includes('w')) minX = maxX - ow * k;
      if (g.dir.includes('n')) minY = maxY - oh * k;
    } else if (g.dir === 'n' || g.dir === 's') sx = 1;
    else if (g.dir === 'e' || g.dir === 'w') sy = 1;
    const resized = new Set<string>();
    for (const o of g.orig.values()) {
      const x = minX + (o.x - B.minX) * sx, y = minY + (o.y - B.minY) * sy;
      let n: Element;
      if (o.type === 'card') n = { ...o, x, y };
      else if (isLinear(o)) n = withPointBounds({ ...o, x, y, points: o.points.map((p) => [p[0] * sx, p[1] * sy] as Point) });
      else if (isFreedraw(o)) n = withPointBounds({ ...o, x, y, points: o.points.map((p) => [p[0] * sx, p[1] * sy, p[2]] as [number, number, number]) });
      else if (o.type === 'text') {
        const fs = Math.max(6, (o as TextElement).fontSize * sy);
        const m = this.blockSize((o as TextElement).text, fs);
        n = { ...o, x, y, fontSize: fs, w: m.w, h: m.h } as TextElement;
      } else n = { ...o, x, y, w: o.w * sx, h: o.h * sy };
      this.put(n);
      if (!isLinear(o)) resized.add(o.id);
    }
    this.reroute(resized);
  }

  private endpointDrag(g: Extract<Gesture, { kind: 'endpoint' }>, w: Point) {
    this.begin();
    const target = this.bindableAt(w, g.id);
    const pts = absPoints(g.orig);
    pts[g.idx] = w;
    this.put(this.withAbs(g.orig, pts));
    this.draft = { bindTarget: target };
    this.invalidate(false, true);
  }

  private finishEndpoint(g: Extract<Gesture, { kind: 'endpoint' }>, w: Point) {
    const cur = this.scene.get(g.id) as LinearElement | undefined;
    if (!cur) return;
    const target = this.bindableAt(w, g.id);
    const n = { ...cur };
    const key = g.idx === 0 ? 'start' : 'end';
    if (target) n[key] = { el: target.id }; else delete n[key];
    this.begin();
    this.put(n);
    this.rerouteOne(this.scene.get(g.id) as LinearElement);
    this.end();
  }

  private shapeBounds(a: Point, b: Point, square: boolean): Bounds {
    let dx = b[0] - a[0], dy = b[1] - a[1];
    if (square) { const m = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * m; dy = Math.sign(dy || 1) * m; }
    return { minX: Math.min(a[0], a[0] + dx), minY: Math.min(a[1], a[1] + dy), maxX: Math.max(a[0], a[0] + dx), maxY: Math.max(a[1], a[1] + dy) };
  }

  private finishCreate(g: Extract<Gesture, { kind: 'create' }>, s: Point, w: Point) {
    const dragged = Math.hypot(s[0] - g.startScreen[0], s[1] - g.startScreen[1]) >= 4;
    let b: Bounds;
    if (dragged) b = this.shapeBounds(g.start, w, g.shift);
    else {
      const dw = g.tool === 'rect' ? 140 : 120, dh = g.tool === 'rect' ? 90 : 120;
      b = { minX: g.start[0] - dw / 2, minY: g.start[1] - dh / 2, maxX: g.start[0] + dw / 2, maxY: g.start[1] + dh / 2 };
    }
    const id = this.act2(() => {
      const el = this.base(g.tool as 'rect', b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY) as Element;
      this.put(el);
      return el.id;
    });
    this.selected = new Set([id]); this.selEdge = null;
    this.emitSelection();
    this.setTool('select');
  }

  private act2<T>(fn: () => T): T { this.begin(); try { return fn(); } finally { this.end(); } }

  private finishLinear(g: Extract<Gesture, { kind: 'linear' }>, s: Point, w: Point) {
    if (Math.hypot(s[0] - g.startScreen[0], s[1] - g.startScreen[1]) < 4) return;
    const endEl = this.bindableAt(w, g.startEl?.id);
    if (g.tool === 'arrow' && g.startEl?.type === 'card' && endEl?.type === 'card') {
      this.setTool('select');
      void this.link((g.startEl as CardElement).ref, (endEl as CardElement).ref);
      return;
    }
    const [a, b] = this.route(g.startEl, endEl, g.start, w);
    const id = this.act2(() => {
      let el = this.base(g.tool as 'arrow', a[0], a[1], 0, 0) as unknown as LinearElement;
      el = { ...el, points: [[0, 0], [b[0] - a[0], b[1] - a[1]]] };
      if (g.tool === 'arrow') el.endHead = 'arrow';
      if (g.startEl) el.start = { el: g.startEl.id };
      if (endEl) el.end = { el: endEl.id };
      this.put(withPointBounds(el));
      return el.id;
    });
    this.selected = new Set([id]); this.selEdge = null;
    this.emitSelection();
    this.setTool('select');
  }

  private finishPencil(g: Extract<Gesture, { kind: 'pencil' }>) {
    const pts = g.pts.length === 1 ? [g.pts[0], [g.pts[0][0] + 0.01, g.pts[0][1], g.pts[0][2]] as [number, number, number]] : g.pts;
    const b = pointsBounds(pts.map((p) => [p[0], p[1]] as Point));
    this.act(() => {
      const el = this.base('freedraw', b.minX, b.minY, 0, 0) as unknown as FreedrawElement;
      this.put(withPointBounds({ ...el, points: pts.map((p) => [p[0] - b.minX, p[1] - b.minY, p[2]] as [number, number, number]) }));
    });
  }

  private async placeStage(w: Point) {
    this.setTool('select');
    let view: StageView;
    try { view = await this.host.createStage(this.labels.newStage); } catch (e) { this.toast(String(e)); return; }
    this.stages.set(view.key, view); this.stagesRev++;
    let id = '';
    this.act(() => {
      const card: CardElement = { id: newId(), type: 'card', ref: view.key, x: w[0], y: w[1], w: CARD_W, h: this.layoutOf(view).h, index: this.nextIndex() };
      id = card.id;
      this.put(card);
    });
    this.selected = new Set([id]); this.selEdge = null;
    this.emitSelection();
  }

  private async link(from: string, to: string) {
    let r: string | null;
    try { r = await this.host.linkStages(from, to); } catch (e) { r = String(e); }
    if (r) this.toast(r === 'CYCLE' ? this.labels.cycleError : r);
  }

  // ---- text editing ------------------------------------------------------------------------

  private styleTa(ta: HTMLTextAreaElement, shape: Element | null) {
    const t = this.theme;
    ta.style.fontFamily = this.style === 'sketch' ? t.fontHand : t.fontUi;
    ta.style.color = t.text;
    ta.style.textAlign = shape ? 'center' : ((this.edit && (this.scene.get(this.edit.id ?? '') as TextElement | undefined)?.align) || 'left');
  }

  private startEdit(target: Element | null, at: Point) {
    this.commitEdit();
    const ta = document.createElement('textarea');
    ta.spellcheck = false;
    ta.rows = 1; ta.wrap = 'off';
    ta.style.cssText = 'position:absolute;margin:0;padding:0;border:none;outline:1px dashed ' + this.theme.accent + ';background:transparent;resize:none;overflow:hidden;line-height:1.25;white-space:pre;z-index:5;min-width:20px;';
    const isShape = !!target && target.type !== 'text';
    ta.value = target ? ((target as { text?: string }).text ?? '') : '';
    this.edit = { ta, id: target?.type === 'text' ? target.id : null, at, shapeId: isShape ? target!.id : null };
    this.editingId = target?.id ?? null;
    this.styleTa(ta, isShape ? target : null);
    ta.addEventListener('input', () => this.placeTa());
    ta.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Escape' || (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey))) { ev.preventDefault(); this.commitEdit(); }
    });
    ta.addEventListener('blur', () => this.commitEdit());
    this.container.appendChild(ta);
    this.placeTa();
    ta.focus();
    ta.select();
    this.invalidate();
  }

  private editFontSize(): number {
    const ed = this.edit!;
    const shape = ed.shapeId ? (this.scene.get(ed.shapeId) as { fontSize?: number }) : null;
    const text = ed.id ? (this.scene.get(ed.id) as TextElement) : null;
    return shape ? shape.fontSize ?? 18 : text ? text.fontSize : 20;
  }

  private placeTa() {
    const ed = this.edit;
    if (!ed) return;
    const { ta } = ed, k = this.cam.scale, size = this.editFontSize();
    ta.style.fontSize = size * k + 'px';
    const m = this.blockSize(ta.value || ' ', size);
    const w = Math.max(m.w * k + 8, 24), h = Math.max(m.h * k, size * k * 1.25);
    ta.style.width = w + 'px'; ta.style.height = h + 'px';
    const shape = ed.shapeId ? this.scene.get(ed.shapeId) : null;
    const text = ed.id ? this.scene.get(ed.id) : null;
    const origin = shape ? elementCenter(shape) : text ? [text.x, text.y] as Point : ed.at;
    const [sx, sy] = worldToScreen(this.cam, origin);
    if (shape) { ta.style.left = sx - w / 2 + 'px'; ta.style.top = sy - h / 2 + 'px'; }
    else { ta.style.left = sx + 'px'; ta.style.top = sy + 'px'; }
  }

  private cancelEdit() {
    const ed = this.edit;
    if (!ed) return;
    this.edit = null; this.editingId = null;
    ed.ta.remove();
    this.invalidate();
  }

  private commitEdit() {
    const ed = this.edit;
    if (!ed) return;
    this.edit = null; this.editingId = null;
    const value = ed.ta.value.replace(/\s+$/, '');
    ed.ta.remove();
    let selectId: string | null = null;
    this.act(() => {
      if (ed.shapeId) {
        const sh = this.scene.get(ed.shapeId);
        if (!sh) return;
        const n = { ...sh } as Element & { text?: string };
        if (value) n.text = value; else delete n.text;
        this.put(n);
      } else if (ed.id) {
        const t = this.scene.get(ed.id) as TextElement | undefined;
        if (!t) return;
        if (!value) { this.del(t.id); return; }
        const m = this.blockSize(value, t.fontSize);
        this.put({ ...t, text: value, w: m.w, h: m.h });
      } else if (value) {
        const m = this.blockSize(value, 20);
        const el = { ...this.base('text', ed.at[0], ed.at[1], m.w, m.h), text: value, fontSize: 20 } as unknown as TextElement;
        delete (el as Partial<Element>).seed;
        this.put(el);
        selectId = el.id;
      }
    });
    if (selectId) { this.selected = new Set([selectId]); this.emitSelection(); }
    if (this.tool === 'text') this.setTool('select');
    this.invalidate();
  }

  // ---- keyboard ----------------------------------------------------------------------------

  private onKeyUp = (e: KeyboardEvent) => {
    if (e.code === 'Space') { this.spaceDown = false; this.updateCursor(); }
  };

  private onKeyDown = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (e.code === 'Space' && !mod) { e.preventDefault(); if (!this.spaceDown) { this.spaceDown = true; this.updateCursor(); } return; }
    if (k === 'escape') {
      if (this.gesture) { this.rollback(); this.gesture = null; this.draft = {}; }
      this.selected.clear(); this.selEdge = null;
      this.setTool('select');
      this.emitSelection();
      this.invalidate();
      return;
    }
    if (mod) {
      if (k === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); }
      else if (k === 'y') { e.preventDefault(); this.redo(); }
      else if (k === 'a') { e.preventDefault(); this.selected = new Set(this.scene.all().map((x) => x.id)); this.selEdge = null; this.emitSelection(); }
      else if (k === 'd') { e.preventDefault(); this.duplicate(); }
      else if (k === 'c') { this.copy(); }
      else if (k === 'v') { this.paste(); }
      return;
    }
    if (e.altKey) return;
    if (k === 'delete' || k === 'backspace') { e.preventDefault(); this.deleteSelection(); return; }
    if (k.startsWith('arrow')) {
      if (!this.selected.size) return;
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const d: Point = k === 'arrowleft' ? [-step, 0] : k === 'arrowright' ? [step, 0] : k === 'arrowup' ? [0, -step] : [0, step];
      this.nudge(d);
      return;
    }
    const tool = TOOL_KEYS[k];
    if (tool && !e.shiftKey) this.setTool(tool);
  };

  private deleteSelection() {
    if (this.selEdge) {
      const { from, to } = this.selEdge;
      this.selEdge = null; this.emitSelection();
      this.host.unlinkStages(from, to).catch((err) => this.toast(String(err)));
      return;
    }
    const ids = new Set([...this.selected].filter((id) => !this.scene.get(id)?.locked));
    if (!ids.size) return;
    this.act(() => {
      this.unbindFrom(ids);
      for (const id of ids) this.del(id);
    });
    this.emitSelection();
  }

  private nudge(d: Point) {
    const moved = new Set<string>();
    this.act(() => {
      for (const id of this.selected) {
        const el = this.scene.get(id);
        if (!el || el.locked) continue;
        this.put({ ...el, x: el.x + d[0], y: el.y + d[1] });
        if (!isLinear(el)) moved.add(id);
      }
      this.reroute(moved);
    });
  }

  private copy() {
    const els = [...this.selected].map((id) => this.scene.get(id)).filter((e): e is Element => !!e && e.type !== 'card');
    if (!els.length) return;
    this.clip = els.map(clone);
    this.pasteN = 0;
  }

  private paste() {
    if (!this.clip.length) return;
    this.pasteN++;
    this.cloneElements(this.clip, 20 * this.pasteN);
  }

  private duplicate() {
    const els = [...this.selected].map((id) => this.scene.get(id)).filter((e): e is Element => !!e && e.type !== 'card');
    if (els.length) this.cloneElements(els, 20);
  }

  /** Cards are never duplicated: a stage appears once per board. */
  private cloneElements(src: Element[], offset: number) {
    const sorted = [...src].sort((a, b) => (a.index < b.index ? -1 : 1));
    const map = new Map(sorted.map((e) => [e.id, newId()]));
    const ids: string[] = [];
    this.act(() => {
      for (const e of sorted) {
        const n = clone(e);
        n.id = map.get(e.id)!; n.x += offset; n.y += offset; n.index = this.nextIndex();
        if (n.seed !== undefined) n.seed = newSeed();
        if (isLinear(n)) {
          const l = n as LinearElement;
          if (l.start) { const m = map.get(l.start.el); if (m) l.start = { el: m }; else delete l.start; }
          if (l.end) { const m = map.get(l.end.el); if (m) l.end = { el: m }; else delete l.end; }
        }
        delete n.locked;
        this.put(n);
        ids.push(n.id);
      }
    });
    this.selected = new Set(ids); this.selEdge = null;
    this.emitSelection();
  }

  // ---- toast -------------------------------------------------------------------------------

  private toast(msg: string) {
    this.toastEl?.remove();
    clearTimeout(this.toastTimer);
    const el = document.createElement('div');
    const t = this.theme;
    el.textContent = msg;
    el.setAttribute('role', 'status');
    el.style.cssText = `position:absolute;left:50%;bottom:24px;transform:translateX(-50%);padding:8px 14px;border-radius:8px;font:13px ${t.fontUi};background:${t.panel};color:${t.text};border:1px solid ${t.bad};box-shadow:0 6px 24px rgba(0,0,0,.35);z-index:10;pointer-events:none;max-width:80%`;
    this.container.appendChild(el);
    this.toastEl = el;
    this.toastTimer = window.setTimeout(() => el.remove(), 3500);
  }

  // ---- rendering ---------------------------------------------------------------------------

  private resize() {
    const r = this.container.getBoundingClientRect();
    this.width = Math.max(1, r.width); this.height = Math.max(1, r.height);
    this.dpr = window.devicePixelRatio || 1;
    for (const c of [this.sCanvas, this.iCanvas]) {
      c.width = Math.round(this.width * this.dpr); c.height = Math.round(this.height * this.dpr);
    }
    this.invalidate();
  }

  private invalidate(s = true, i = true) {
    if (s) this.dirtyS = true;
    if (i) this.dirtyI = true;
    if (!this.raf && !this.destroyed) this.raf = requestAnimationFrame(this.frame);
  }

  private state(): RenderState {
    return {
      cam: this.cam, width: this.width, height: this.height, dpr: window.devicePixelRatio || this.dpr, theme: this.theme, style: this.style,
      scene: this.scene, stages: this.stages, layoutOf: this.layoutOf, edges: this.edges().edges, selected: this.selected,
      selEdge: this.selEdge, editingId: this.editingId, labels: this.labels,
    };
  }

  private overlay(): Overlay {
    const els = [...this.selected].map((id) => this.scene.get(id)).filter((e): e is Element => !!e);
    const cards = els.filter((e) => e.type === 'card');
    const others = els.filter((e) => e.type !== 'card');
    return {
      boxes: els.length > 1 || (els.length === 1 && isPointy(els[0])) ? others.map(elementBounds) : others.length === 1 ? [elementBounds(others[0])] : [],
      group: els.length > 1 ? unionBounds(els.map(elementBounds)) : null,
      handles: this.handlePoints().map((h) => ({ pt: h.pt, round: h.round })),
      haloCards: cards,
      marquee: null, draftShape: null, draftLine: null, draftPencil: null, bindTarget: null,
      ...this.draft,
    };
  }

  private frame = () => {
    this.raf = 0;
    if (this.destroyed) return;
    const t0 = performance.now();
    const st = this.state();
    if (this.dirtyS) { this.dirtyS = false; this.renderer.drawStatic(this.sCtx, st); }
    if (this.dirtyI) { this.dirtyI = false; this.renderer.drawInteractive(this.iCtx, st, this.overlay()); }
    if (this.edit) this.placeTa();
    this.stats.frames++;
    this.stats.lastFrameMs = performance.now() - t0;
    this.stats.totalFrameMs += this.stats.lastFrameMs;
  };
}
