import type { Board, CardElement, Ghost, Element, FrameElement, ImageElement, LinearElement, FreedrawElement, ShapeElement, StageView, TextElement, ThemeTokens } from './types';
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
import { keyAfter, keyBetween } from './index-key';
import { computeFrames, execToolAllowed, frameHeaderRect, frameMembers, frameProgress, planRemoveStageCards, reorderKeys, unboundArrows } from './ops';
import { CARD, CARD_W, MISSING_H, cardLayout, edgeCurve, extractEdges, hitCheckbox, statusColors, taskDone, type CardLayout, type DepEdge } from './stage';
import { clearMeasureCache, measureText } from './measure';
import { Renderer, type Overlay, type RenderState } from './render';
import { STATIC_CACHE } from './lod';
import { addHighlights, boundsWithGhosts, ghostEdges, highlightAlpha, keepSelection, pruneHighlights, type Highlight } from './live';
import {
  STICKY_PAD, alignDeltas, distributeDeltas, expandGroups, findElements, findSnap, groupUpdates, guideCandidates, imageFit, snapGrid, snapMove, snapPoint,
  stickyNeeded, sweepHits, ungroupIds, unitsOf, wrapLines, type AlignMode, type Guide,
} from './arrange';
import { ImageCache, loadBlobImage } from './media';
import { Minimap, centerCameraOn, type MiniRect } from './minimap';
import { DEFAULT_CANVAS_KEYMAP, buildChordLookup, chordFromEvent, mergeKeymap, type CanvasCommand, type Keymap } from './keymap';

type Dir = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const DIRS: Dir[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const CURSORS: Record<Dir, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };
const BINDABLE = new Set(['rect', 'ellipse', 'diamond', 'card', 'sticky', 'text', 'image']);
const clone = <T>(x: T): T => structuredClone(x);

interface MenuItem { label: string; run: () => void; disabled?: boolean; sep?: boolean }

type Gesture =
  | { kind: 'pan'; last: Point; right: boolean; dist: number }
  | { kind: 'move'; start: Point; startScreen: Point; orig: Map<string, Element>; moved: boolean; shift: boolean; hitId: string; b?: Bounds; cand?: Bounds[] }
  | { kind: 'resize'; dir: Dir; B: Bounds; orig: Map<string, Element>; shift: boolean; imgs: boolean }
  | { kind: 'erase'; last: Point; ids: Set<string> }
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
  private exec = false;
  private execLayouts = new WeakMap<CardLayout, CardLayout>();
  private menu: { el: HTMLElement; off: () => void } | null = null;
  private rightMoved = false;
  private frameEdit: { input: HTMLInputElement; id: string } | null = null;
  private frameCache: { rev: number; srev: number; stats: Map<string, { done: number; total: number }>; frames: Element[] } | null = null;
  private hl = new Map<string, Highlight>();
  private ghosts: Ghost[] = [];
  private snap = false;
  private images: ImageCache;
  private enteredGroup: string | null = null;
  private anim: { from: Camera; to: Camera; t0: number; ms: number } | null = null;
  private pasteTimer = 0;
  private fileInput: HTMLInputElement | null = null;
  private pickAt: Point | null = null;
  private mini: Minimap | null = null;
  private miniCache: { rev: number; srev: number; theme: ThemeTokens | null; exec: boolean; rects: MiniRect[]; content: Bounds | null; key: string } | null = null;
  private edgeCache: { rev: number; srev: number; edges: DepEdge[]; cards: Map<string, CardElement> } | null = null;

  private sCanvas: HTMLCanvasElement;
  private iCanvas: HTMLCanvasElement;
  private sCtx: CanvasRenderingContext2D;
  private iCtx: CanvasRenderingContext2D;
  private renderer: Renderer;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private dirtyS: 0 | 1 | 2 | 3 = 3; // 0 clean, 1 camera moved, 2 camera idle (crisp redraw), 3 content changed
  private idleTimer = 0;
  private dirtyI = true;
  private raf = 0;
  private destroyed = false;
  private autoFit = true; // refit on resize until the user navigates
  private ro: ResizeObserver;
  private stats: EditorStats = { frames: 0, lastFrameMs: 0, totalFrameMs: 0, elements: 0 };
  private keymap: Keymap = DEFAULT_CANVAS_KEYMAP;
  private lookup = buildChordLookup(DEFAULT_CANVAS_KEYMAP);
  private fontsHandler = () => { this.invalidateLayout(); };

  constructor(private container: HTMLElement, opts: EditorOptions) {
    this.host = opts.host;
    this.theme = opts.theme;
    this.style = opts.style ?? opts.board.style ?? 'clean';
    this.labels = { ...DEFAULT_LABELS, ...opts.labels };
    this.title = opts.board.title;
    this.snap = !!opts.snap;
    this.images = new ImageCache(opts.assetUrl ?? ((path) => path), () => this.invalidate());
    if (opts.keymap) this.setKeymap(opts.keymap);
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
    ic.addEventListener('contextmenu', this.onContext);
    ic.addEventListener('dragover', this.onDragOver);
    ic.addEventListener('drop', this.onDrop);
    window.addEventListener('paste', this.onPaste);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    document.fonts?.addEventListener?.('loadingdone', this.fontsHandler);
    this.ro = new ResizeObserver(() => { this.resize(); if (this.autoFit) this.zoomToFit(); });
    this.ro.observe(container);
    this.resize();
    this.loadBoard(opts.board);
    this.zoomToFit();
    if (opts.minimap) this.setMinimap(true);
  }

  // ---- public API --------------------------------------------------------------------------

  setBoard(board: Board, opts?: { keepCamera?: boolean }) {
    this.cancelEdit();
    this.enteredGroup = null;
    this.title = board.title;
    this.style = board.style ?? this.style;
    this.loadBoard(board);
    this.history.clear();
    if (opts?.keepCamera) {
      this.selected = keepSelection(this.selected, new Set(this.scene.all().map((e) => e.id)));
      this.selEdge = null;
      this.emitSelection();
      this.invalidate();
      return;
    }
    this.autoFit = true;
    this.selected.clear(); this.selEdge = null;
    this.emitSelection();
    this.zoomToFit();
  }

  highlightStages(keys: string[], ms = 8000) {
    if (!keys.length) return;
    addHighlights(this.hl, keys, performance.now(), ms);
    this.invalidate(false, true);
  }

  setGhosts(ghosts: Ghost[]) {
    this.ghosts = ghosts.slice();
    this.invalidate(false, true);
  }

  setStages(stages: StageView[]) {
    this.stages = new Map(stages.map((s) => [s.key, s]));
    this.stagesRev++;
    this.layouts = new WeakMap();
    this.relayoutCards(true);
    this.emitSelection();
    this.invalidate();
  }

  setTheme(theme: ThemeTokens) { this.theme = theme; this.closeMenu(); this.invalidateLayout(); }

  setStyle(style: 'clean' | 'sketch') { this.style = style; this.closeMenu(); this.invalidateLayout(); }

  setExecutionMode(on: boolean) {
    if (on === this.exec) return;
    if (on) {
      this.commitEdit(); this.closeMenu();
      if (this.gesture) { this.rollback(); this.gesture = null; this.draft = {}; }
      this.setTool(this.tool === 'hand' ? 'hand' : 'select');
      this.exec = true;
      this.enteredGroup = null;
      this.selEdge = null;
      for (const id of [...this.selected]) if (this.scene.get(id)?.type !== 'card') this.selected.delete(id);
      this.emitSelection();
    } else this.exec = false;
    this.updateCursor();
    this.invalidate(); // static content changed: drops the bitmap cache
  }

  getExecutionMode() { return this.exec; }

  removeStageCards(key: string) {
    const { remove, arrows } = planRemoveStageCards(this.scene.all(), key);
    if (!remove.size) return;
    this.act(() => { for (const a of arrows) this.put(a); for (const id of remove) this.del(id); });
    this.emitSelection();
  }

  setTool(tool: Tool) {
    if (tool === this.tool || (this.exec && !execToolAllowed(tool)) || (tool === 'image' && !this.host.saveAsset)) return;
    this.commitEdit();
    this.tool = tool;
    this.gesture = null; this.draft = {};
    if (tool !== 'select') { this.selEdge = null; }
    this.host.onToolChange(tool);
    this.updateCursor();
    this.invalidate(false, true);
    if (tool === 'image') this.pickImages(null);
  }

  getTool() { return this.tool; }

  undo() { if (!this.exec) this.applyHistory(this.history.undo(), 'before'); }
  redo() { if (!this.exec) this.applyHistory(this.history.redo(), 'after'); }

  zoomToFit() {
    this.anim = null;
    // frame titles sit above the frame: leave room for them
    const b = boundsWithGhosts(this.scene.all().map((e) => { const x = elementBounds(e); return e.type === 'frame' ? { ...x, minY: x.minY - 40 } : x; }), this.ghosts, (s) => this.layoutOf(s).h);
    this.setCamera(fitBounds(b, this.width, this.height));
  }

  zoomTo(scale: number) { this.anim = null; this.autoFit = false; this.setCamera(zoomAt(this.cam, scale, [this.width / 2, this.height / 2])); }
  getZoom() { return this.cam.scale; }

  focusElement(id: string) {
    const el = this.scene.get(id);
    if (!el) return;
    const c = elementCenter(el);
    const sc = this.cam.scale;
    this.autoFit = false;
    this.animateTo({ scale: sc, x: this.width / 2 - c[0] * sc, y: this.height / 2 - c[1] * sc });
    this.selected = new Set([id]); this.selEdge = null;
    this.emitSelection();
    this.invalidate();
  }

  findElements(query: string): string[] {
    return findElements(this.scene.all(), (ref) => this.stages.get(ref), query);
  }

  setSnap(on: boolean) { this.snap = on; }
  getSnap() { return this.snap; }

  setMinimap(on: boolean) {
    if (on === !!this.mini) return;
    if (on) {
      const m = new Minimap(this.container, this.labels.minimap);
      m.onPan = (p) => { this.anim = null; this.autoFit = false; this.setCamera(centerCameraOn(this.cam, p, this.width, this.height)); };
      this.mini = m; this.miniCache = null;
      this.invalidate(false, true);
    } else { this.mini?.destroy(); this.mini = null; }
  }
  getMinimap() { return !!this.mini; }

  /** Glide the camera to `to` (centre-preserving interpolation, log-scale zoom, ease-out). */
  private animateTo(to: Camera, ms = 250) {
    this.anim = { from: { ...this.cam }, to: { ...to, scale: clampScale(to.scale) }, t0: performance.now(), ms };
    this.invalidate(false, true);
  }

  private stepAnim(now: number) {
    const a = this.anim;
    if (!a) return;
    const p = Math.min(1, (now - a.t0) / a.ms);
    if (p >= 1) { this.anim = null; this.setCamera(a.to); return; }
    const e = 1 - (1 - p) ** 3, W = this.width, H = this.height;
    const cf = screenToWorld(a.from, [W / 2, H / 2]), ct = screenToWorld(a.to, [W / 2, H / 2]);
    const sc = a.from.scale * (a.to.scale / a.from.scale) ** e;
    const cx = cf[0] + (ct[0] - cf[0]) * e, cy = cf[1] + (ct[1] - cf[1]) * e;
    this.setCamera({ scale: sc, x: W / 2 - cx * sc, y: H / 2 - cy * sc });
  }

  getBoard(): Board {
    return { format: 'pathloom.board/1', title: this.title, style: this.style, elements: this.scene.all().map(clone) };
  }

  panBy(dx: number, dy: number) { this.anim = null; this.autoFit = false; this.setCamera({ ...this.cam, x: this.cam.x + dx, y: this.cam.y + dy }); }
  getStats() { return { ...this.stats, elements: this.scene.size }; }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    window.clearTimeout(this.idleTimer);
    this.cancelEdit(); this.closeMenu();
    this.ro.disconnect();
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('paste', this.onPaste);
    window.clearTimeout(this.pasteTimer);
    this.mini?.destroy(); this.fileInput?.remove(); this.images.destroy();
    document.fonts?.removeEventListener?.('loadingdone', this.fontsHandler);
    this.sCanvas.remove(); this.iCanvas.remove(); this.toastEl?.remove();
  }

  async convertSelectionToStage() {
    const el = this.singleSelected();
    if (this.exec || !el || el.locked || !['rect', 'ellipse', 'diamond'].includes(el.type)) return;
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

  /** Execution mode lists only open tasks, packed to the top (card height is unchanged). */
  private execLayoutOf = (s: StageView): CardLayout => {
    const L = this.layoutOf(s);
    let v = this.execLayouts.get(L);
    if (!v) {
      const y0 = L.tasks[0]?.y ?? 0;
      v = { ...L, tasks: L.tasks.filter((r) => !taskDone(r.task)).map((r, i) => ({ task: r.task, y: y0 + i * (CARD.taskH + CARD.taskGap) })) };
      this.execLayouts.set(L, v);
    }
    return v;
  };
  private layoutFor = (s: StageView): CardLayout => (this.exec ? this.execLayoutOf(s) : this.layoutOf(s));

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
  /** Recompute `frame` membership of what the action touched (everything when a frame was touched). */
  private reassignFrames(tx: Map<string, Element | null>) {
    let only: Set<string> | null = new Set();
    for (const [id, before] of tx) {
      const cur = this.scene.get(id);
      if ((cur ?? before)?.type === 'frame') { only = null; break; }
      if (cur) only.add(id);
    }
    if (only && !only.size) return;
    for (const [id, f] of computeFrames(this.scene.all(), only)) {
      const n = { ...this.scene.get(id)! };
      if (f) n.frame = f; else delete n.frame;
      this.put(n);
    }
  }
  private end(): boolean {
    const tx = this.tx;
    if (!tx) return false;
    this.reassignFrames(tx);
    this.tx = null;
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
    for (const a of unboundArrows(this.scene.all(), ids)) this.put(a);
  }

  // ---- hit testing -------------------------------------------------------------------------

  private tol() { return 6 / this.cam.scale; }

  /** Topmost element under `p`. Frames only react on their border or header strip, and only after everything else. */
  private hitAt(p: Point): Element | null {
    const tol = this.tol();
    const top = this.scene.hit(p, tol, (e) => e.type !== 'frame' && (!this.exec || e.type === 'card'));
    if (top || this.exec) return top;
    const { frames } = this.frameInfo();
    if (!frames.length) return null;
    const border = this.scene.hit(p, tol, (e) => e.type === 'frame');
    if (border) return border;
    for (let i = frames.length - 1; i >= 0; i--) {
      const h = frameHeaderRect(frames[i], this.cam.scale);
      if (p[0] >= h.x && p[0] <= h.x + h.w && p[1] >= h.y && p[1] <= h.y + h.h + h.fs * 0.3) return frames[i];
    }
    return null;
  }

  private frameInfo() {
    const c = this.frameCache;
    if (c && c.rev === this.scene.rev && c.srev === this.stagesRev) return c;
    const all = this.scene.all(), frames = all.filter((e) => e.type === 'frame');
    const stats = frames.length ? frameProgress(all, (ref) => this.stages.get(ref)?.status) : new Map<string, { done: number; total: number }>();
    return (this.frameCache = { rev: this.scene.rev, srev: this.stagesRev, stats, frames });
  }

  /** Selected, unlocked elements plus the members of selected, unlocked frames (they move together). */
  private moveSet(): Map<string, Element> {
    const orig = new Map<string, Element>();
    for (const id of this.selected) { const el = this.scene.get(id); if (el && !el.locked) orig.set(id, clone(el)); }
    const frames = [...orig.values()].filter((e) => e.type === 'frame').map((e) => e.id);
    if (frames.length) {
      for (const id of frameMembers(this.scene.all(), frames)) {
        const el = this.scene.get(id);
        if (el && !el.locked && !orig.has(id)) orig.set(id, clone(el));
      }
    }
    return orig;
  }
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
    if (!els.length || this.exec || els.every((e) => e.locked)) return [];
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
    return hitCheckbox(this.layoutFor(st), p[0] - el.x, p[1] - el.y);
  }

  // ---- camera ------------------------------------------------------------------------------

  private setCamera(c: Camera) {
    this.cam = { ...c, scale: clampScale(c.scale) };
    if (this.cam.scale !== this.lastScale) { this.lastScale = this.cam.scale; this.host.onZoomChange(this.cam.scale); }
    if (this.dirtyS < 1) this.dirtyS = 1;
    window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => { if (this.dirtyS < 2) this.dirtyS = 2; this.invalidate(false, false); }, STATIC_CACHE.idleMs);
    this.invalidate(false, true);
  }

  private toWorld(e: { clientX: number; clientY: number }): { s: Point; w: Point } {
    const r = this.container.getBoundingClientRect();
    const s: Point = [e.clientX - r.left, e.clientY - r.top];
    return { s, w: screenToWorld(this.cam, s) };
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.closeMenu();
    this.autoFit = false;
    this.anim = null;
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
    this.anim = null;
    this.commitEdit();
    this.iCanvas.setPointerCapture(e.pointerId);
    const { s, w } = this.toWorld(e);
    if (e.button === 1 || e.button === 2 || this.spaceDown || this.tool === 'hand') {
      e.preventDefault();
      this.gesture = { kind: 'pan', last: s, right: e.button === 2, dist: 0 };
      if (e.button === 2) this.rightMoved = false;
      this.updateCursor(true);
      return;
    }
    if (e.button !== 0) return;
    const shift = e.shiftKey;
    switch (this.tool) {
      case 'select': this.downSelect(s, w, shift); break;
      case 'rect': case 'ellipse': case 'diamond': case 'frame': case 'sticky':
        this.gesture = { kind: 'create', tool: this.tool, start: this.sp(w), startScreen: s, cur: this.sp(w), shift };
        break;
      case 'arrow': case 'line': {
        const startEl = this.bindableAt(w);
        this.gesture = { kind: 'linear', tool: this.tool, start: startEl ? w : this.sp(w), startScreen: s, startEl, cur: w, endEl: null };
        break;
      }
      case 'pencil': this.gesture = { kind: 'pencil', pts: [[w[0], w[1], e.pointerType === 'pen' ? e.pressure : 0.5]] }; break;
      case 'text': {
        const t = this.scene.hit(w, this.tol(), (x) => x.type === 'text' || x.type === 'rect' || x.type === 'ellipse' || x.type === 'diamond' || x.type === 'sticky');
        this.gesture = { kind: 'text-click', at: w, target: t };
        break;
      }
      case 'stage': void this.placeStage(this.sp(w)); break;
      case 'eraser': { const g = { kind: 'erase' as const, last: w, ids: new Set<string>() }; this.gesture = g; this.eraseTo(g, w); break; }
      case 'image': this.pickImages(this.sp(w)); break;
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
        if (orig.size) this.gesture = { kind: 'resize', dir: h.dir, B, orig, shift, imgs: [...orig.values()].every((o) => o.type === 'image') };
      }
      return;
    }
    const hit = this.hitAt(w);
    if (hit) {
      const cb = this.checkboxAt(hit, w);
      if (cb) {
        this.selected = new Set([hit.id]); this.selEdge = null; this.emitSelection();
        this.host.toggleTask(cb).catch((err) => this.toast(String(err)));
        return;
      }
      this.selEdge = null;
      if (this.enteredGroup && hit.group !== this.enteredGroup) this.enteredGroup = null;
      const ids = this.pickIds(hit);
      if (shift && ids.every((id) => this.selected.has(id))) { for (const id of ids) this.selected.delete(id); this.emitSelection(); return; }
      if (shift) for (const id of ids) this.selected.add(id);
      else if (!this.selected.has(hit.id)) this.selected = new Set(ids);
      this.emitSelection();
      if (this.exec) return;
      const orig = this.moveSet();
      this.gesture = { kind: 'move', start: w, startScreen: s, orig, moved: false, shift, hitId: hit.id };
      return;
    }
    const ed = this.exec ? null : this.edgeAt(w);
    if (ed) { this.selected.clear(); this.selEdge = { from: ed.from, to: ed.to }; this.emitSelection(); return; }
    this.enteredGroup = null;
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
        g.dist += Math.abs(s[0] - g.last[0]) + Math.abs(s[1] - g.last[1]);
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
        for (const el of this.scene.intersecting(b)) {
          if (this.exec && el.type !== 'card') continue;
          if (el.type === 'frame') { const eb = elementBounds(el); if (eb.minX < b.minX || eb.minY < b.minY || eb.maxX > b.maxX || eb.maxY > b.maxY) continue; }
          ids.add(el.id);
        }
        this.selected = this.exec ? ids : expandGroups(this.scene.all(), ids);
        this.invalidate(false, true);
        break;
      }
      case 'erase': this.eraseTo(g, w); break;
      case 'create': {
        g.cur = this.sp(w); g.shift = e.shiftKey;
        this.draft = { draftShape: { tool: g.tool, b: this.shapeBounds(g.start, g.cur, g.shift) } };
        this.invalidate(false, true);
        break;
      }
      case 'linear': {
        g.cur = w;
        g.endEl = this.bindableAt(w, g.startEl?.id);
        const [a, b] = this.route(g.startEl, g.endEl, g.start, this.sp(w));
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
      case 'pan': if (g.right) this.rightMoved = g.dist > 4; break;
      case 'move':
        if (g.moved) this.end();
        else if (!g.shift && this.selected.size > 1) { const h = this.scene.get(g.hitId); this.selected = new Set(h ? this.pickIds(h) : [g.hitId]); this.emitSelection(); }
        break;
      case 'resize': this.end(); break;
      case 'endpoint': this.finishEndpoint(g, w); break;
      case 'marquee': this.emitSelection(); break;
      case 'erase': this.finishErase(g); break;
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
    const hit = this.hitAt(w);
    if (this.exec) { if (hit?.type === 'card' && !this.checkboxAt(hit, w)) this.host.openStage((hit as CardElement).ref); return; }
    if (hit) {
      if (hit.group && this.enteredGroup !== hit.group) {
        this.enteredGroup = hit.group; this.selected = new Set([hit.id]); this.selEdge = null; this.emitSelection(); return;
      }
      if (hit.type === 'frame') { this.startFrameRename(hit.id); return; }
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
        const hit = this.hitAt(w);
        if (hit && this.checkboxAt(hit, w)) cur = 'pointer';
        else if (hit) cur = 'move';
        else if (!this.exec && this.edgeAt(w)) cur = 'pointer';
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
      g.b = unionBounds([...g.orig.values()].map(elementBounds)) ?? undefined;
      if (g.b && !this.snap && !this.exec) g.cand = guideCandidates(this.scene, g.b, 400 / this.cam.scale, new Set(g.orig.keys()));
    }
    let dx = w[0] - g.start[0], dy = w[1] - g.start[1];
    let guides: Guide[] = [];
    if (g.b && !this.exec) {
      if (this.snap) [dx, dy] = snapMove(g.b, dx, dy);
      else if (g.cand?.length) {
        const r = findSnap({ minX: g.b.minX + dx, minY: g.b.minY + dy, maxX: g.b.maxX + dx, maxY: g.b.maxY + dy }, g.cand, 6 / this.cam.scale);
        dx += r.dx; dy += r.dy; guides = r.guides;
      }
    }
    this.draft = guides.length ? { guides } : {};
    const moved = new Set<string>();
    for (const o of g.orig.values()) { this.put({ ...o, x: o.x + dx, y: o.y + dy }); if (!isLinear(o)) moved.add(o.id); }
    this.reroute(moved);
  }

  private resizeDrag(g: Extract<Gesture, { kind: 'resize' }>, p: Point) {
    this.begin();
    const w = this.sp(p);
    const B = g.B;
    let { minX, minY, maxX, maxY } = B;
    if (g.dir.includes('w')) minX = Math.min(w[0], maxX - 4);
    if (g.dir.includes('e')) maxX = Math.max(w[0], minX + 4);
    if (g.dir.includes('n')) minY = Math.min(w[1], maxY - 4);
    if (g.dir.includes('s')) maxY = Math.max(w[1], minY + 4);
    const ow = Math.max(B.maxX - B.minX, 1e-6), oh = Math.max(B.maxY - B.minY, 1e-6);
    let sx = (maxX - minX) / ow, sy = (maxY - minY) / oh;
    // images keep their aspect on corner handles by default (Shift frees it); everything else is the other way round
    if (g.dir.length === 2 && g.shift !== g.imgs) {
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
    const frame = g.tool === 'frame', sticky = g.tool === 'sticky';
    let b: Bounds;
    if (dragged) b = this.shapeBounds(g.start, this.sp(w), g.shift && !frame);
    else {
      const dw = frame ? 360 : sticky ? 160 : g.tool === 'rect' ? 140 : 120, dh = frame ? 240 : sticky ? 140 : g.tool === 'rect' ? 90 : 120;
      const ox = this.snap ? snapGrid(g.start[0] - dw / 2) : g.start[0] - dw / 2, oy = this.snap ? snapGrid(g.start[1] - dh / 2) : g.start[1] - dh / 2;
      b = { minX: ox, minY: oy, maxX: ox + dw, maxY: oy + dh };
    }
    const id = this.act2(() => {
      let el = this.base(g.tool as 'rect', b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY) as Element;
      if (frame) el = { ...el, type: 'frame', name: `${this.labels.frameDefaultName} ${this.frameInfo().frames.length + 1}`, index: this.frameIndex() } as FrameElement;
      this.put(el);
      return el.id;
    });
    this.selected = new Set([id]); this.selEdge = null;
    this.emitSelection();
    this.setTool('select');
  }

  /** Key for a new frame: above the other frames, below every non-frame element. */
  private frameIndex(): string {
    const all = this.scene.all(), frames = this.frameInfo().frames;
    const lo = frames.length ? frames[frames.length - 1].index : null;
    const hi = all.find((e) => e.type !== 'frame' && (lo === null || e.index > lo))?.index ?? null;
    return keyBetween(lo, hi);
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
    const [a, b] = this.route(g.startEl, endEl, g.start, this.sp(w));
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
    ta.style.textAlign = shape ? (shape.type === 'sticky' ? 'left' : 'center') : ((this.edit && (this.scene.get(this.edit.id ?? '') as TextElement | undefined)?.align) || 'left');
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
    if (target?.type === 'sticky') { ta.wrap = 'soft'; ta.style.whiteSpace = 'pre-wrap'; ta.style.overflowWrap = 'anywhere'; }
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
    const sticky = ed.shapeId ? this.scene.get(ed.shapeId) : null;
    if (sticky?.type === 'sticky') {
      ta.style.width = (sticky.w - STICKY_PAD * 2) * k + 'px';
      ta.style.height = '0';
      ta.style.height = Math.max(ta.scrollHeight, size * k * 1.25) + 'px';
      const [x0, y0] = worldToScreen(this.cam, [sticky.x + STICKY_PAD, sticky.y + STICKY_PAD]);
      ta.style.left = x0 + 'px'; ta.style.top = y0 + 'px';
      return;
    }
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
    this.cancelFrameEdit();
    const ed = this.edit;
    if (!ed) return;
    this.edit = null; this.editingId = null;
    ed.ta.remove();
    this.invalidate();
  }

  private commitEdit() {
    this.commitFrameEdit();
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
        if (n.type === 'sticky' && value) n.h = Math.max(n.h, this.stickyHeight(n as ShapeElement, value));
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

  // ---- frame rename ------------------------------------------------------------------------

  private startFrameRename(id: string) {
    const f = this.scene.get(id) as FrameElement | undefined;
    if (this.exec || !f || f.type !== 'frame') return;
    this.commitEdit();
    const t = this.theme, input = document.createElement('input');
    input.type = 'text'; input.value = f.name ?? ''; input.spellcheck = false;
    input.setAttribute('aria-label', this.labels.ctxRename);
    input.style.cssText = `position:absolute;margin:0;padding:0 6px;box-sizing:border-box;border:none;outline:1.5px solid ${t.accent};border-radius:5px;background:${t.panel};color:${t.text};z-index:5;`;
    input.style.fontFamily = this.style === 'sketch' ? t.fontHand : t.fontUi;
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); this.commitFrameEdit(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); this.cancelFrameEdit(); }
    });
    input.addEventListener('blur', () => this.commitFrameEdit());
    this.frameEdit = { input, id };
    this.container.appendChild(input);
    this.placeFrameEdit();
    input.focus(); input.select();
  }

  private placeFrameEdit() {
    const fe = this.frameEdit, f = fe && this.scene.get(fe.id);
    if (!fe || !f) return;
    const k = this.cam.scale, h = frameHeaderRect(f, k), [sx, sy] = worldToScreen(this.cam, [h.x, h.y]);
    const st = fe.input.style;
    st.left = sx + 'px'; st.top = sy + 'px'; st.height = h.h * k + 'px';
    st.width = Math.max(140, Math.min(h.w * k, 320)) + 'px'; st.fontSize = h.fs * k * (this.style === 'sketch' ? 1.2 : 1) + 'px';
  }

  private cancelFrameEdit() {
    const fe = this.frameEdit;
    if (!fe) return;
    this.frameEdit = null;
    fe.input.remove();
  }

  private commitFrameEdit() {
    const fe = this.frameEdit;
    if (!fe) return;
    this.frameEdit = null;
    const v = fe.input.value.trim();
    fe.input.remove();
    const f = this.scene.get(fe.id) as FrameElement | undefined;
    if (f && v && v !== f.name) this.act(() => this.put({ ...f, name: v }));
  }

  // ---- keyboard ----------------------------------------------------------------------------

  private onKeyUp = (e: KeyboardEvent) => {
    if (e.code === 'Space') { this.spaceDown = false; this.updateCursor(); }
  };

  private onKeyDown = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.code === 'Space' && !mod) { e.preventDefault(); if (!this.spaceDown) { this.spaceDown = true; this.updateCursor(); } return; }
    const cmd = this.lookup.get(chordFromEvent(e) ?? '');
    if (cmd === 'edit.paste') {
      // No preventDefault: the browser then fires a paste event, which can carry clipboard images. Fallback if it never comes.
      window.clearTimeout(this.pasteTimer);
      this.pasteTimer = window.setTimeout(() => { this.pasteTimer = 0; this.paste(); }, 60);
      return;
    }
    if (cmd) { e.preventDefault(); this.runCommand(cmd); return; }
    // Arrow nudge is fixed (not rebindable): plain arrows move the selection, Shift = 10px.
    if (mod || e.altKey || this.exec || !e.code.startsWith('Arrow') || !this.selected.size) return;
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    this.nudge(e.code === 'ArrowLeft' ? [-step, 0] : e.code === 'ArrowRight' ? [step, 0] : e.code === 'ArrowUp' ? [0, -step] : [0, step]);
  };

  setKeymap(map: Partial<Keymap>) { this.keymap = mergeKeymap(map); this.lookup = buildChordLookup(this.keymap); }

  getKeymap(): Keymap { return structuredClone(this.keymap); }

  runCommand(cmd: CanvasCommand) {
    if (cmd.startsWith('tool.')) { this.setTool(cmd.slice(5) as Tool); return; }
    switch (cmd) {
      case 'edit.cancel':
        if (this.gesture) { this.rollback(); this.gesture = null; this.draft = {}; }
        if (this.enteredGroup) { // first Esc leaves the group, keeping it selected as a whole
          this.enteredGroup = null;
          this.selected = expandGroups(this.scene.all(), this.selected);
          this.emitSelection(); this.invalidate(false, true);
          break;
        }
        this.selected.clear(); this.selEdge = null;
        this.setTool('select');
        this.emitSelection();
        this.invalidate();
        break;
      case 'view.zoomIn': this.zoomTo(this.getZoom() * 1.25); break;
      case 'view.zoomOut': this.zoomTo(this.getZoom() / 1.25); break;
      case 'view.fit': this.zoomToFit(); break;
      case 'view.zoom100': this.zoomTo(1); break;
      case 'edit.undo': this.undo(); break;
      case 'edit.redo': this.redo(); break;
      case 'edit.delete': this.deleteSelection(); break;
      case 'edit.duplicate': this.duplicate(); break;
      case 'edit.paste': this.paste(); break;
      case 'edit.toggleLock': this.toggleLock(); break;
      case 'edit.group': this.groupSelection(); break;
      case 'edit.ungroup': this.ungroupSelection(); break;
      case 'align.left': case 'align.center': case 'align.right': case 'align.top': case 'align.middle': case 'align.bottom':
        this.arrange(cmd.slice(6) as AlignMode); break;
      case 'distribute.h': this.arrange('dh'); break;
      case 'distribute.v': this.arrange('dv'); break;
      case 'view.toggleSnap': this.setSnap(!this.snap); break;
      case 'arrange.front': this.zOrder('front'); break;
      case 'arrange.back': this.zOrder('back'); break;
      // Execution mode is read-only: the rest only runs while editing.
      case 'edit.copy': if (!this.exec) this.copy(); break;
      case 'edit.selectAll':
        if (!this.exec) { this.selected = new Set(this.scene.all().map((x) => x.id)); this.selEdge = null; this.emitSelection(); }
        break;
      case 'edit.convertToStage': if (!this.exec) void this.contextConvert(); break;
    }
  }

  private deleteSelection() {
    if (this.exec) return;
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
      for (const el of this.moveSet().values()) {
        this.put({ ...el, x: el.x + d[0], y: el.y + d[1] });
        if (!isLinear(el)) moved.add(el.id);
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
    if (this.exec || !this.clip.length) return;
    this.pasteN++;
    this.cloneElements(this.clip, 20 * this.pasteN);
  }

  private duplicate() {
    if (this.exec) return;
    const els = [...this.selected].map((id) => this.scene.get(id)).filter((e): e is Element => !!e && e.type !== 'card');
    if (els.length) this.cloneElements(els, 20);
  }

  /** Cards are never duplicated: a stage appears once per board. */
  private cloneElements(src: Element[], offset: number) {
    const sorted = [...src].sort((a, b) => (a.index < b.index ? -1 : 1));
    const map = new Map(sorted.map((e) => [e.id, newId()]));
    const gmap = new Map<string, string>(); // a copy of a group is its own group
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
        if (n.group) { if (!gmap.has(n.group)) gmap.set(n.group, newId()); n.group = gmap.get(n.group); }
        this.put(n);
        ids.push(n.id);
      }
    });
    this.selected = new Set(ids); this.selEdge = null;
    this.emitSelection();
  }

  // ---- groups, align, eraser, images -------------------------------------------------------

  /** What a click on `el` selects: the whole group, or just the element inside an entered group. */
  private pickIds(el: Element): string[] {
    if (this.exec || !el.group || this.enteredGroup === el.group) return [el.id];
    return [...expandGroups(this.scene.all(), [el.id])];
  }

  private groupSelection() {
    if (this.exec) return;
    const upd = groupUpdates(this.scene.all(), this.selected, newId());
    if (!upd.size) return;
    this.enteredGroup = null;
    this.act(() => { for (const [id, group] of upd) this.put({ ...this.scene.get(id)!, group }); });
  }

  private ungroupSelection() {
    if (this.exec) return;
    const ids = ungroupIds(this.scene.all(), this.selected);
    if (!ids.size) return;
    this.enteredGroup = null;
    this.act(() => { for (const id of ids) { const n = { ...this.scene.get(id)! }; delete n.group; this.put(n); } });
  }

  /** Align (or distribute: 'dh' / 'dv') the unlocked selection; groups move as one unit, frames take their members along. */
  private arrange(kind: AlignMode | 'dh' | 'dv') {
    if (this.exec) return;
    const units = unitsOf(this.selectedEls().filter((e) => !e.locked));
    const deltas = kind === 'dh' ? distributeDeltas(units, 'h') : kind === 'dv' ? distributeDeltas(units, 'v') : alignDeltas(units, kind);
    if (!deltas.size) return;
    const per = new Map<string, Point>();
    for (const u of units) { const d = deltas.get(u.key); if (d) for (const id of u.ids) per.set(id, d); }
    const all = this.scene.all();
    for (const [fid, d] of [...per]) {
      if (this.scene.get(fid)?.type !== 'frame') continue;
      for (const id of frameMembers(all, [fid])) { const m = this.scene.get(id); if (m && !m.locked && !per.has(id)) per.set(id, d); }
    }
    this.act(() => {
      const moved = new Set<string>();
      for (const [id, d] of per) {
        const el = this.scene.get(id)!;
        const n = { ...el, x: el.x + d[0], y: el.y + d[1] } as Element;
        if (isLinear(n)) { // an arrow that moves without its targets lets go of them
          if (n.start && !per.has(n.start.el)) delete n.start;
          if (n.end && !per.has(n.end.el)) delete n.end;
        } else moved.add(id);
        this.put(n);
      }
      this.reroute(moved);
    });
  }

  /** Mark everything along the eraser's path (dimmed preview); nothing is deleted until release. */
  private eraseTo(g: Extract<Gesture, { kind: 'erase' }>, to: Point) {
    for (const e of sweepHits(this.scene, g.last, to, this.tol())) g.ids.add(e.id);
    g.last = to;
    this.draft = { erase: [...g.ids].map((id) => elementBounds(this.scene.get(id)!)) };
    this.invalidate(false, true);
  }

  private finishErase(g: Extract<Gesture, { kind: 'erase' }>) {
    const ids = new Set([...g.ids].filter((id) => this.scene.has(id)));
    if (!ids.size || this.exec) return;
    this.act(() => { this.unbindFrom(ids); for (const id of ids) this.del(id); });
    this.emitSelection();
  }

  private stickyHeight(el: ShapeElement, text: string): number {
    const size = el.fontSize ?? 18, font = `${size}px ${this.style === 'sketch' ? this.theme.fontHand : this.theme.fontUi}`;
    return stickyNeeded(wrapLines(text, el.w - STICKY_PAD * 2, (x) => measureText(x, font)).length, size);
  }

  /** Open the OS file picker (hidden input). `at` = world point to centre the first image on (default: view centre). */
  private pickImages(at: Point | null) {
    if (this.exec || !this.host.saveAsset) return;
    if (!this.fileInput) {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = 'image/*'; input.multiple = true; input.tabIndex = -1;
      input.style.cssText = 'position:absolute;width:0;height:0;opacity:0;pointer-events:none;';
      input.addEventListener('change', () => {
        const files = [...(input.files ?? [])];
        input.value = '';
        void this.addImages(files, this.pickAt);
        this.setTool('select');
      });
      input.addEventListener('cancel', () => this.setTool('select'));
      this.container.appendChild(input);
      this.fileInput = input;
    }
    this.pickAt = at;
    this.fileInput.click();
  }

  /** Store each image through the host and add an image element (one undo step per image). Selects them at the end. */
  private async addImages(files: File[], at: Point | null) {
    const save = this.host.saveAsset?.bind(this.host);
    if (this.exec || !save) return;
    const centre = at ?? screenToWorld(this.cam, [this.width / 2, this.height / 2]);
    const added: string[] = [];
    for (const f of files.filter((x) => x.type.startsWith('image/'))) {
      try {
        const loaded = await loadBlobImage(f);
        const asset = await save(f, f.name || 'image');
        if (this.destroyed || this.exec) return;
        this.images.prime(asset, loaded.img, loaded.url);
        const { w, h } = imageFit(loaded.img.naturalWidth, loaded.img.naturalHeight);
        const off = added.length * 24;
        let x = centre[0] - w / 2 + off, y = centre[1] - h / 2 + off;
        if (this.snap) { x = snapGrid(x); y = snapGrid(y); }
        const id = this.act2(() => {
          const { seed: _s, roughness: _r, strokeWidth: _w, ...b } = this.base('image', x, y, w, h);
          const el = { ...b, asset } as ImageElement;
          this.put(el);
          return el.id;
        });
        added.push(id);
      } catch (e) { this.toast(String(e instanceof Error ? e.message : e)); }
    }
    if (added.length) { this.selected = new Set(added); this.selEdge = null; this.emitSelection(); }
  }

  private onPaste = (e: ClipboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    window.clearTimeout(this.pasteTimer); this.pasteTimer = 0;
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    e.preventDefault();
    if (files.length && this.host.saveAsset && !this.exec) void this.addImages(files, null);
    else this.paste();
  };

  private onDragOver = (e: DragEvent) => {
    if (this.exec || !this.host.saveAsset || !e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
  };

  private onDrop = (e: DragEvent) => {
    const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length || this.exec || !this.host.saveAsset) return;
    e.preventDefault();
    void this.addImages(files, this.sp(this.toWorld(e).w));
  };

  /** Grid-snapped point when snapping is on (and editing). */
  private sp(p: Point): Point { return this.snap && !this.exec ? snapPoint(p) : p; }

  // ---- context menu & element commands -----------------------------------------------------

  private selectedEls(): Element[] {
    return [...this.selected].map((id) => this.scene.get(id)).filter((e): e is Element => !!e);
  }

  private toggleLock() {
    if (this.exec) return;
    const els = this.selectedEls();
    if (!els.length) return;
    const lock = els.some((e) => !e.locked);
    this.act(() => {
      for (const e of els) { const n = { ...e }; if (lock) n.locked = true; else delete n.locked; this.put(n); }
    });
  }

  private zOrder(dir: 'front' | 'back') {
    if (this.exec) return;
    const keys = reorderKeys(this.scene.all(), this.selected, dir);
    if (!keys.size) return;
    this.act(() => { for (const [id, index] of keys) this.put({ ...this.scene.get(id)!, index }); });
  }

  /** Convert the selected shape to a stage card, then tell the host (the canvas has already done the work). */
  private async contextConvert() {
    await this.convertSelectionToStage();
    const c = this.singleSelected();
    if (c?.type === 'card') this.host.onContextAction?.('convertToStage', { elementId: c.id, stageKey: (c as CardElement).ref });
  }

  private openCardStage(c: CardElement) {
    this.host.openStage(c.ref);
    this.host.onContextAction?.('openStage', { elementId: c.id, stageKey: c.ref });
  }

  private menuItems(): MenuItem[] {
    const L = this.labels, els = this.selectedEls();
    if (!els.length) return [];
    const one = els.length === 1 ? els[0] : null;
    const open: MenuItem[] = one?.type === 'card' ? [{ label: L.ctxOpenStage, run: () => this.openCardStage(one as CardElement) }] : [];
    if (this.exec) return open;
    const z: MenuItem[] = [
      { label: L.ctxBringToFront, run: () => this.zOrder('front') },
      { label: L.ctxSendToBack, run: () => this.zOrder('back') },
    ];
    const lock: MenuItem = { label: els.every((e) => e.locked) ? L.ctxUnlock : L.ctxLock, run: () => this.toggleLock() };
    const del: MenuItem = { label: L.ctxDelete, run: () => this.deleteSelection(), disabled: els.every((e) => e.locked) };
    const sep: MenuItem = { label: '', run: () => undefined, sep: true };
    if (!one) {
      const L2 = this.labels, units = unitsOf(els.filter((e) => !e.locked));
      const mk = (label: string, run: () => void): MenuItem => ({ label, run });
      const grp: MenuItem[] = [];
      if (groupUpdates(this.scene.all(), this.selected, '').size) grp.push(mk(L2.ctxGroup, () => this.groupSelection()));
      if (els.some((e) => e.group)) grp.push(mk(L2.ctxUngroup, () => this.ungroupSelection()));
      const aln: MenuItem[] = units.length < 2 ? [] : [
        mk(L2.ctxAlignLeft, () => this.arrange('left')), mk(L2.ctxAlignCenter, () => this.arrange('center')), mk(L2.ctxAlignRight, () => this.arrange('right')),
        mk(L2.ctxAlignTop, () => this.arrange('top')), mk(L2.ctxAlignMiddle, () => this.arrange('middle')), mk(L2.ctxAlignBottom, () => this.arrange('bottom')),
        ...(units.length >= 3 ? [mk(L2.ctxDistributeH, () => this.arrange('dh')), mk(L2.ctxDistributeV, () => this.arrange('dv'))] : []),
      ];
      return [...(grp.length ? [...grp, sep] : []), ...(aln.length ? [...aln, sep] : []), ...z, sep, lock, del];
    }
    if (one.type === 'card') return [...open, sep, ...z, sep, lock, del];
    if (one.type === 'frame') return [{ label: L.ctxRename, run: () => this.startFrameRename(one.id) }, sep, ...z, sep, lock, del];
    const dup: MenuItem = { label: L.ctxDuplicate, run: () => this.duplicate() };
    if (one.type === 'rect' || one.type === 'ellipse' || one.type === 'diamond') {
      return [{ label: L.ctxConvertToStage, run: () => void this.contextConvert(), disabled: !!one.locked }, dup, sep, ...z, sep, lock, del];
    }
    return [dup, sep, ...z, sep, lock, del];
  }

  private onContext = (e: MouseEvent) => {
    e.preventDefault();
    this.closeMenu();
    if (this.rightMoved) return; // that was a right-drag pan
    const { s, w } = this.toWorld(e);
    const hit = this.hitAt(w);
    if (!hit) return;
    if (!this.selected.has(hit.id)) { this.selected = new Set(this.pickIds(hit)); this.selEdge = null; this.emitSelection(); }
    this.openMenu(s, this.menuItems());
  };

  private openMenu(at: Point, items: MenuItem[]) {
    if (!items.length) return;
    const t = this.theme, el = document.createElement('div');
    el.setAttribute('role', 'menu'); el.tabIndex = -1;
    el.style.cssText = `position:absolute;z-index:30;min-width:180px;padding:4px;box-sizing:border-box;border-radius:10px;background:${t.panel};border:1px solid ${t.border2};box-shadow:0 10px 32px rgba(0,0,0,.4);font:13px ${t.fontUi};color:${t.text};outline:none;user-select:none;visibility:hidden;left:0;top:0;`;
    const btns: HTMLButtonElement[] = [];
    const paint = (b: HTMLButtonElement, on: boolean) => {
      b.style.background = on ? t.accent : 'transparent';
      b.style.color = on ? t.onAccent : b.getAttribute('aria-disabled') ? t.muted : t.text;
    };
    for (const it of items) {
      if (it.sep) {
        const hr = document.createElement('div');
        hr.setAttribute('role', 'separator');
        hr.style.cssText = `height:1px;margin:4px 6px;background:${t.border};`;
        el.appendChild(hr);
        continue;
      }
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = it.label; b.setAttribute('role', 'menuitem'); b.tabIndex = -1;
      if (it.disabled) b.setAttribute('aria-disabled', 'true');
      b.style.cssText = 'display:block;width:100%;box-sizing:border-box;text-align:left;border:none;margin:0;padding:6px 10px;border-radius:6px;font:inherit;cursor:' + (it.disabled ? 'default' : 'pointer') + ';outline:none;';
      paint(b, false);
      b.addEventListener('mouseenter', () => { if (!it.disabled) b.focus(); });
      b.addEventListener('focus', () => paint(b, true));
      b.addEventListener('blur', () => paint(b, false));
      b.addEventListener('click', () => { if (it.disabled) return; this.closeMenu(); it.run(); });
      el.appendChild(b);
      if (!it.disabled) btns.push(b);
    }
    el.addEventListener('contextmenu', (ev) => ev.preventDefault());
    el.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      const i = btns.indexOf(document.activeElement as HTMLButtonElement), n = btns.length;
      if (ev.key === 'ArrowDown') { ev.preventDefault(); btns[(i + 1) % n]?.focus(); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); btns[(i - 1 + n) % n]?.focus(); }
      else if (ev.key === 'Home') { ev.preventDefault(); btns[0]?.focus(); }
      else if (ev.key === 'End') { ev.preventDefault(); btns[n - 1]?.focus(); }
      else if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); btns[i]?.click(); }
      else if (ev.key === 'Escape' || ev.key === 'Tab') { ev.preventDefault(); this.closeMenu(); }
    });
    const outside = (ev: Event) => { if (!el.contains(ev.target as Node)) this.closeMenu(); };
    window.addEventListener('pointerdown', outside, true);
    this.container.appendChild(el);
    const mw = el.offsetWidth, mh = el.offsetHeight;
    el.style.left = Math.max(4, Math.min(at[0], this.width - mw - 4)) + 'px';
    el.style.top = Math.max(4, Math.min(at[1], this.height - mh - 4)) + 'px';
    el.style.visibility = 'visible';
    this.menu = { el, off: () => window.removeEventListener('pointerdown', outside, true) };
    (btns[0] ?? el).focus();
  }

  private closeMenu() {
    const m = this.menu;
    if (!m) return;
    this.menu = null;
    m.off(); m.el.remove();
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
    if (s) this.dirtyS = 3;
    if (i) this.dirtyI = true;
    if (!this.raf && !this.destroyed) this.raf = requestAnimationFrame(this.frame);
  }

  private state(): RenderState {
    return {
      cam: this.cam, width: this.width, height: this.height, dpr: window.devicePixelRatio || this.dpr, theme: this.theme, style: this.style,
      scene: this.scene, stages: this.stages, layoutOf: this.layoutFor, edges: this.edges().edges, cards: this.edges().cards, selected: this.selected,
      selEdge: this.selEdge, editingId: this.editingId, labels: this.labels,
      exec: this.exec, frameStats: this.frameInfo().stats, images: this.images,
    };
  }

  /** Highlight glows and ghost cards (interactive layer only: the static bitmap cache is never touched). */
  private liveOverlay(): Pick<Overlay, 'glows' | 'ghosts' | 'ghostEdges'> {
    const now = performance.now();
    pruneHighlights(this.hl, now);
    const { cards } = this.edges();
    const glows: Overlay['glows'] = [];
    for (const [key, h] of this.hl) {
      const c = cards.get(key);
      if (c) glows.push({ b: { minX: c.x, minY: c.y, maxX: c.x + c.w, maxY: c.y + c.h }, alpha: highlightAlpha(h, now) });
    }
    const gs = this.ghosts.map((g) => ({ stage: g.stage, el: { id: 'ghost:' + g.stage.key, type: 'card', ref: g.stage.key, x: g.x, y: g.y, w: CARD_W, h: this.layoutOf(g.stage).h, index: '' } as CardElement }));
    const rects = new Map<string, { x: number; y: number; w: number; h: number }>();
    for (const [k, c] of cards) rects.set(k, c);
    for (const g of gs) rects.set(g.stage.key, g.el);
    const edges: Overlay['ghostEdges'] = [];
    if (gs.length) {
      for (const e of ghostEdges(this.ghosts, this.stages.values(), new Set(cards.keys()))) {
        const a = rects.get(e.from), b = rects.get(e.to);
        if (a && b) edges.push({ a, b, soft: e.soft });
      }
    }
    return { glows, ghosts: gs, ghostEdges: edges };
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
      locks: els.filter((e) => e.locked).map((e) => { const b = elementBounds(e); return [b.maxX, b.minY] as Point; }),
      marquee: null, draftShape: null, draftLine: null, draftPencil: null, bindTarget: null, guides: [], erase: [],
      ...this.liveOverlay(),
      ...this.draft,
    };
  }

  /** Redraws only when the scene, stages, theme, size or camera changed since the last draw (called from the rAF frame). */
  private drawMinimap() {
    const m = this.mini;
    if (!m) return;
    const t = this.theme, rev = this.scene.rev, srev = this.stagesRev;
    let c = this.miniCache;
    if (!c || c.rev !== rev || c.srev !== srev || c.theme !== t || c.exec !== this.exec) {
      const rects: MiniRect[] = [];
      const bs: Bounds[] = [];
      for (const el of this.scene.all()) {
        const b = elementBounds(el);
        bs.push(b);
        let color = t.text2, alpha = 0.55;
        if (el.type === 'card') { const st = this.stages.get((el as CardElement).ref); color = st ? statusColors(st.status, t).fg : t.muted; alpha = 0.95; }
        else if (el.type === 'frame') { color = t.border2; alpha = 0.4; }
        else if (el.type === 'sticky') { color = t.warn; alpha = 0.85; }
        else if (el.type === 'image') { color = t.accent; alpha = 0.5; }
        rects.push({ b, color, alpha });
      }
      c = this.miniCache = { rev, srev, theme: t, exec: this.exec, rects, content: unionBounds(bs), key: '' };
    }
    const k = `${this.cam.x}|${this.cam.y}|${this.cam.scale}|${this.width}|${this.height}`;
    if (c.key === k) return;
    c.key = k;
    m.draw({ rects: c.rects, content: c.content, cam: this.cam, viewW: this.width, viewH: this.height, panel: t.panel, border: t.border2, accent: t.accent });
  }

  private frame = () => {
    this.raf = 0;
    if (this.destroyed) return;
    const t0 = performance.now();
    this.stepAnim(t0);
    const st = this.state();
    if (this.dirtyS) { const m = this.dirtyS; this.dirtyS = 0; this.renderer.drawStatic(this.sCtx, st, m === 3 ? 'content' : m === 2 ? 'idle' : 'camera'); }
    if (this.dirtyI) { this.dirtyI = false; this.renderer.drawInteractive(this.iCtx, st, this.overlay()); }
    if (this.hl.size) this.invalidate(false, true); // keep animating only while a highlight is alive
    if (this.mini) this.drawMinimap();
    if (this.edit) this.placeTa();
    if (this.frameEdit) this.placeFrameEdit();
    this.stats.frames++;
    this.stats.lastFrameMs = performance.now() - t0;
    this.stats.totalFrameMs += this.stats.lastFrameMs;
  };
}
