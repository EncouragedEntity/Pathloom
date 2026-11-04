import type { CardElement, StageStatus, StageView, Task, ThemeTokens } from './types';
import type { Bezier, Point } from './geometry';

export const CARD_W = 250;
export const MISSING_H = 64;

/** Milestone gate metrics (world px): box, diamond half-diagonal and its centre line, label rows. */
export const MS = { w: 160, h: 120, half: 28, cy: 36, titleY: 72, subH: 14 } as const;
export const isMilestone = (s: { kind?: string } | undefined | null) => s?.kind === 'milestone';
export const cardW = (s: { kind?: string } | undefined | null) => (isMilestone(s) ? MS.w : CARD_W);

/** Card metrics (world px), taken from prototypes/concepts.html concept A. */
export const CARD = {
  padX: 12, padTop: 12, padBottom: 10,
  headH: 20, headGap: 8,
  titleGap: 8,
  progH: 14, progGap: 8,
  taskH: 22, taskGap: 2,
  footTop: 8, footPad: 8, footH: 14,
  maxTasks: 12,
  chk: 16,
} as const;

export type MeasureFn = (text: string) => number;

export interface CardLayout {
  w: number;
  h: number;
  /** Milestone gate only: label width (hit/selection box) and the y of the "N of M" line. */
  ms?: { labelW: number; subY: number };
  titleLines: string[];
  titleLH: number;
  titleY: number;
  progY: number;
  tasks: { y: number; task: Task }[];
  hiddenTasks: number;
  moreY: number;
  footerY: number | null;
}

/** Greedy word wrap, at most `maxLines`; the last line is ellipsised when text is cut. */
export function wrapText(text: string, maxW: number, measure: MeasureFn, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = cur ? cur + ' ' + w : w;
    if (measure(next) <= maxW || !cur) { cur = next; continue; }
    lines.push(cur);
    cur = w;
    if (lines.length === maxLines - 1) { cur = words.slice(i).join(' '); break; }
  }
  if (cur) lines.push(cur);
  const out = lines.slice(0, maxLines);
  const last = out.length - 1;
  if (last >= 0 && measure(out[last]) > maxW) out[last] = ellipsize(out[last], maxW, measure);
  return out.length ? out : [''];
}

export function ellipsize(text: string, maxW: number, measure: MeasureFn): string {
  if (measure(text) <= maxW) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(text.slice(0, mid) + '…') <= maxW) lo = mid; else hi = mid - 1;
  }
  return text.slice(0, lo) + '…';
}

export const hasFooter = (s: StageView) => !!s.due || s.priority === 'high' || !!s.branch;

/** Card layout. Height depends on the number of tasks (capped), wrapped title lines and footer presence. */
export function cardLayout(stage: StageView, measureTitle: MeasureFn, titleLH = 20, maxTitleLines = 2): CardLayout {
  if (isMilestone(stage)) return milestoneLayout(stage, measureTitle, titleLH);
  const innerW = CARD_W - CARD.padX * 2;
  const titleLines = wrapText(stage.title, innerW, measureTitle, maxTitleLines);
  let y = CARD.padTop + CARD.headH + CARD.headGap;
  const titleY = y;
  y += titleLines.length * titleLH + CARD.titleGap;
  const progY = y;
  y += CARD.progH;
  const shown = stage.tasks.slice(0, CARD.maxTasks);
  const hiddenTasks = stage.tasks.length - shown.length;
  const tasks: CardLayout['tasks'] = [];
  if (shown.length) {
    y += CARD.progGap;
    for (const task of shown) { tasks.push({ y, task }); y += CARD.taskH + CARD.taskGap; }
    y -= CARD.taskGap;
  }
  const moreY = y;
  if (hiddenTasks > 0) y += CARD.taskGap + CARD.taskH;
  let footerY: number | null = null;
  if (hasFooter(stage)) { y += CARD.footTop; footerY = y; y += 1 + CARD.footPad + CARD.footH; }
  return { w: CARD_W, h: y + CARD.padBottom, titleLines, titleLH, titleY, progY, tasks, hiddenTasks, moreY, footerY };
}

/** Milestone gate: diamond on top, up to 2 title lines and the "N of M inputs" line below; height grows if the lines need it. */
export function milestoneLayout(stage: StageView, measure: MeasureFn, lh: number): CardLayout {
  const titleLines = wrapText(stage.title, MS.w - 16, measure, 2);
  const subY = MS.titleY + titleLines.length * lh + 2;
  const labelW = Math.min(MS.w - 16, Math.max(110, ...titleLines.map(measure)));
  return { w: MS.w, h: Math.max(MS.h, subY + MS.subH + 4), titleLines, titleLH: lh, titleY: MS.titleY, progY: 0, tasks: [], hiddenTasks: 0, moreY: 0, footerY: null, ms: { labelW, subY } };
}

/** Diamond tips of a milestone card: incoming edges end at `left`, outgoing start at `right`. */
export function milestoneAnchors(r: CardRect): { left: Point; right: Point } {
  return { left: [r.x + r.w / 2 - MS.half, r.y + MS.cy], right: [r.x + r.w / 2 + MS.half, r.y + MS.cy] };
}

/** Diamond + label bounds (world) of a milestone card; the selection halo follows it. */
export function milestoneBounds(r: CardRect, g: NonNullable<CardLayout['ms']>) {
  const hw = Math.max(MS.half, g.labelW / 2), cx = r.x + r.w / 2;
  return { minX: cx - hw, minY: r.y + MS.cy - MS.half, maxX: cx + hw, maxY: r.y + g.subY + MS.subH };
}

/** Card-local point on the diamond or its label (tolerance `tol`). */
export function milestoneHit(lx: number, ly: number, w: number, g: NonNullable<CardLayout['ms']>, tol: number): boolean {
  const dx = Math.abs(lx - w / 2);
  if (dx + Math.abs(ly - MS.cy) <= MS.half + tol) return true;
  return dx <= g.labelW / 2 + tol && ly >= MS.titleY - tol && ly <= g.subY + MS.subH + tol;
}

/** Task whose checkbox contains the card-local point, if any. */
export function hitCheckbox(layout: CardLayout, lx: number, ly: number): string | null {
  if (lx < CARD.padX - 4 || lx > CARD.padX + CARD.chk + 4) return null;
  for (const row of layout.tasks) {
    if (ly >= row.y - 1 && ly <= row.y + CARD.taskH + 1) return row.task.id;
  }
  return null;
}

export const taskDone = (t: Task): boolean => (t.sub.length ? t.sub.every(taskDone) : t.done);

// ---- dependency edges -------------------------------------------------------------------------

export interface DepEdge { from: string; to: string; soft: boolean; fromDone: boolean }
export interface CardRect { x: number; y: number; w: number; h: number }

/** Edges between stages whose cards are both on the board. `from` = dependency, `to` = dependent stage. */
export function extractEdges(stages: StageView[], onBoard: ReadonlySet<string>): DepEdge[] {
  const byKey = new Map(stages.map((s) => [s.key, s]));
  const edges: DepEdge[] = [];
  for (const s of stages) {
    if (!onBoard.has(s.key)) continue;
    for (const d of s.depends) {
      if (!onBoard.has(d.id) || d.id === s.key) continue;
      edges.push({ from: d.id, to: s.key, soft: d.soft, fromDone: byKey.get(d.id)?.status === 'done' });
    }
  }
  return edges;
}

/** Right-middle of `a` to left-middle of `b` (diamond tips for milestones); bezier control offset like the prototype. */
export function edgeCurve(a: CardRect, b: CardRect, aMs = false, bMs = false): Bezier {
  const p0: Point = aMs ? milestoneAnchors(a).right : [a.x + a.w, a.y + a.h / 2];
  const p3: Point = bMs ? milestoneAnchors(b).left : [b.x, b.y + b.h / 2];
  const dx = Math.max(40, Math.abs(p3[0] - p0[0]) * 0.5);
  return [p0, [p0[0] + dx, p0[1]], [p3[0] - dx, p3[1]], p3];
}

// ---- colours ----------------------------------------------------------------------------------

export function parseHex(c: string): [number, number, number] {
  let h = c.trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((x) => x + x).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function withAlpha(c: string, a: number): string {
  const [r, g, b] = parseHex(c);
  return `rgba(${r},${g},${b},${a})`;
}

/** Mix `a` into `b` by `t` (0..1) -> hex. */
export function mixColors(a: string, b: string, t: number): string {
  const x = parseHex(a), y = parseHex(b);
  const m = x.map((v, i) => Math.round(v * t + y[i] * (1 - t)));
  return '#' + m.map((v) => v.toString(16).padStart(2, '0')).join('');
}

export function statusColors(status: StageStatus, t: ThemeTokens): { fg: string; bg: string } {
  switch (status) {
    case 'done': return { fg: t.ok, bg: withAlpha(t.ok, 0.16) };
    case 'active': return { fg: t.warn, bg: withAlpha(t.warn, 0.16) };
    case 'ready': return { fg: t.accent, bg: withAlpha(t.accent, 0.16) };
    default: return { fg: t.muted, bg: t.card2 };
  }
}

export const isCard = (e: { type: string }): e is CardElement => e.type === 'card';
