import { createEditor } from '../src/index';
import type { Board, CanvasHost, Editor, Element, StageStatus, StageView, Task, ThemeTokens, Tool } from '../src/index';
import { keyAfter } from '../src/index-key';

// ---- themes (tokens from the task brief) ---------------------------------------------------
const fonts = { fontUi: "'Inter', system-ui, sans-serif", fontHand: "'Caveat', cursive", fontMono: "'JetBrains Mono', ui-monospace, monospace", radiusCard: 14 };
const midnight: ThemeTokens = {
  bg: '#0f0d16', panel: '#181524', card: '#1b1827', card2: '#221e31', border: '#2a2540', border2: '#3a3358',
  text: '#ece9f7', text2: '#b8b2d1', muted: '#7d769a', accent: '#9b87f5', onAccent: '#0f0d16',
  ok: '#4cc38a', warn: '#e8b04a', bad: '#ef5b6a', edge: '#4a4370', grid: '#231f35', ...fonts,
};
const paper: ThemeTokens = {
  bg: '#f3eee3', panel: '#faf7f0', card: '#fdfbf6', card2: '#f4efe4', border: '#ddd3bf', border2: '#c9bda4',
  text: '#2c2720', text2: '#574f42', muted: '#8a7f6b', accent: '#b4552d', onAccent: '#ffffff',
  ok: '#4f7f3a', warn: '#b7791f', bad: '#b3261e', edge: '#a89b82', grid: '#e0d6c2', ...fonts,
};

// ---- mock stage store (status per spec section 5) ------------------------------------------
interface RawStage { key: string; title: string; who: 'me' | 'ai' | 'both'; due: string | null; priority: 'low' | 'med' | 'high'; branch: string | null; depends: { id: string; soft: boolean }[]; tasks: Task[] }
const t = (id: string, title: string, done = false): Task => ({ id, title, done, sub: [] });
const raw: RawStage[] = [
  { key: 'S0', title: 'Owner: repo and environment', who: 'me', due: 'Nov 6', priority: 'high', branch: null, depends: [], tasks: [t('S0-01', 'Create the GitHub repo', true), t('S0-02', 'Install Rust and Node', true), t('S0-03', 'Ubuntu in WSL for Linux tests', true)] },
  { key: 'M0', title: 'Core and file format', who: 'ai', due: 'Nov 14', priority: 'high', branch: 'feat/core', depends: [{ id: 'S0', soft: false }], tasks: [t('M0-01', 'Stage file format (.md + frontmatter)', true), t('M0-02', 'Board file format (JSON)', true), t('M0-03', 'Dependency graph and cycles', true), t('M0-04', 'compute_statuses and stage_views')] },
  { key: 'M1', title: 'Canvas: shapes and arrows', who: 'ai', due: 'Nov 28', priority: 'high', branch: 'feat/canvas', depends: [{ id: 'M0', soft: false }], tasks: [t('M1-01', 'Pan / zoom and grid'), t('M1-02', 'Rectangle, ellipse, diamond'), t('M1-03', 'Pencil (perfect-freehand)'), t('M1-04', 'Arrows with binding'), t('M1-05', 'Undo / redo')] },
  { key: 'M2', title: 'pathloom CLI', who: 'ai', due: 'Nov 21', priority: 'med', branch: null, depends: [{ id: 'M0', soft: false }], tasks: [t('M2-01', 'pathloom init'), t('M2-02', 'stage add / task done'), t('M2-03', 'pathloom next'), t('M2-04', 'pathloom validate')] },
  { key: 'M3', title: "Stage cards and links", who: 'ai', due: 'Dec 5', priority: 'high', branch: null, depends: [{ id: 'M1', soft: false }], tasks: [t('M3-01', 'Stage card'), t('M3-02', 'Task IDs inside the card'), t('M3-03', 'Arrow between cards = dependency')] },
  { key: 'M4', title: 'MCP server and skill', who: 'ai', due: 'Dec 10', priority: 'high', branch: null, depends: [{ id: 'M2', soft: false }, { id: 'M3', soft: true }], tasks: [t('M4-01', 'rmcp stdio server'), t('M4-02', 'Batch apply spec'), t('M4-03', 'Skill for Claude Code'), t('M4-04', 'Live reload in the app')] },
  { key: 'M5', title: 'Installers and CI', who: 'both', due: 'Dec 19', priority: 'med', branch: null, depends: [{ id: 'M4', soft: false }], tasks: [t('M5-01', 'Make the repo public'), t('M5-02', 'GitHub Actions: Win / macOS / Linux'), t('M5-03', 'Test on a friend\'s Linux box')] },
  { key: 'M6', title: 'Public release 0.1', who: 'me', due: 'Dec 26', priority: 'med', branch: null, depends: [{ id: 'M5', soft: false }], tasks: [t('M6-01', 'README and screenshots'), t('M6-02', 'FUNDING.yml'), t('M6-03', 'Announcement post')] },
];

const rawInit: RawStage[] = structuredClone(raw);
const taskDone = (x: Task): boolean => (x.sub.length ? x.sub.every(taskDone) : x.done);
function views(): StageView[] {
  const status = new Map<string, StageStatus>();
  const compute = (k: string): StageStatus => {
    const cached = status.get(k); if (cached) return cached;
    const s = raw.find((r) => r.key === k)!;
    const done = s.tasks.filter(taskDone).length;
    let st: StageStatus;
    if (s.tasks.length && done === s.tasks.length) st = 'done';
    else if (s.depends.some((d) => !d.soft && compute(d.id) !== 'done')) st = 'blocked';
    else st = done > 0 ? 'active' : 'ready';
    status.set(k, st);
    return st;
  };
  return raw.map((s) => ({
    key: s.key, title: s.title, kind: 'stage', who: s.who, due: s.due, priority: s.priority, branch: s.branch, pr: null, tags: [],
    depends: s.depends, description: '', tasks: s.tasks, comments: [], status: compute(s.key),
    progress: [s.tasks.filter(taskDone).length, s.tasks.length],
  }));
}

function reaches(from: string, to: string): boolean {
  if (from === to) return true;
  return raw.filter((r) => r.depends.some((d) => d.id === from)).some((r) => reaches(r.key, to));
}

// ---- sample board --------------------------------------------------------------------------
let last: string | null = null;
const next = () => (last = keyAfter(last));
const base = { angle: 0, roughness: 1, strokeWidth: 1.5 };
let seed = 7;
const card = (ref: string, x: number, y: number): Element => ({ id: 'c' + ref, type: 'card', ref, x, y, w: 250, h: 200, index: next() });
const sampleElements: Element[] = [
  { id: 'fr1', type: 'frame', name: 'Phase 1 · Foundation', x: 30, y: 80, w: 620, h: 420, index: next() } as Element,
  card('S0', 60, 120), card('M0', 360, 120), card('M1', 700, 40), card('M2', 700, 420), card('M3', 1010, 40), card('M4', 1010, 420), card('M5', 1350, 220), card('M6', 1660, 220),
  { id: 'r1', type: 'rect', x: 60, y: 640, w: 160, h: 80, text: 'Idea: plugins', index: next(), seed: seed++, ...base } as Element,
  { id: 'e1', type: 'ellipse', x: 330, y: 620, w: 150, h: 110, text: 'Agents', index: next(), seed: seed++, ...base } as Element,
  { id: 'd1', type: 'diamond', x: 600, y: 630, w: 130, h: 100, text: 'Ship?', index: next(), seed: seed++, ...base } as Element,
  { id: 'a1', type: 'arrow', x: 220, y: 680, w: 110, h: 0, points: [[0, 0], [110, 0]], start: { el: 'r1' }, end: { el: 'e1' }, endHead: 'arrow', index: next(), seed: seed++, ...base } as Element,
  { id: 'a2', type: 'arrow', x: 480, y: 676, w: 120, h: 0, points: [[0, 0], [120, 0]], start: { el: 'e1' }, end: { el: 'd1' }, endHead: 'arrow', index: next(), seed: seed++, ...base } as Element,
  { id: 'tx1', type: 'text', x: 60, y: 560, w: 260, h: 30, text: 'Sketches live next to the plan', fontSize: 22, index: next() } as Element,
];
const initialBoard = (): Board => ({ format: 'pathloom.board/1', title: 'Harness board', style: 'clean', elements: sampleElements.map((e) => structuredClone(e)) });

// ---- UI ------------------------------------------------------------------------------------
const cv = document.getElementById('cv')!;
const bar = document.getElementById('bar')!;
const info = document.getElementById('info')!;
const fpsEl = document.getElementById('fps')!;
let theme = midnight;
let style: 'clean' | 'sketch' = 'clean';
let saves = 0, lastBoard: Board | null = null;
let selText = '-', zoom = 1, tool: Tool = 'select', note = '';
const refreshInfo = () => { info.textContent = `tool ${tool} | zoom ${Math.round(zoom * 100)}% | sel ${selText} | saves ${saves} | ${note}`; };

const host: CanvasHost = {
  onBoardChange(b) { lastBoard = b; saves++; refreshInfo(); },
  onSelectionChange(s) { selText = s.elementIds.length + (s.stageKey ? ` (stage ${s.stageKey})` : ''); refreshInfo(); },
  onToolChange(x) { tool = x; for (const b of bar.querySelectorAll<HTMLButtonElement>('button[data-tool]')) b.classList.toggle('on', b.dataset.tool === x); refreshInfo(); },
  onZoomChange(z) { zoom = z; refreshInfo(); },
  async createStage(title) {
    let n = raw.length; while (raw.some((r) => r.key === 'N' + n)) n++;
    raw.push({ key: 'N' + n, title, who: 'ai', due: null, priority: 'med', branch: null, depends: [], tasks: [t(`N${n}-01`, 'First task')] });
    const v = views(); setTimeout(() => editor.setStages(v), 0);
    return v.find((s) => s.key === 'N' + n)!;
  },
  async toggleTask(id) {
    for (const s of raw) for (const x of s.tasks) if (x.id === id) x.done = !x.done;
    editor.setStages(views());
  },
  async linkStages(from, to) {
    if (reaches(to, from)) return `Cycle: ${to} -> ... -> ${from}`;
    const s = raw.find((r) => r.key === to)!;
    if (!s.depends.some((d) => d.id === from)) s.depends.push({ id: from, soft: false });
    editor.setStages(views());
    return null;
  },
  async unlinkStages(from, to) {
    const s = raw.find((r) => r.key === to)!;
    s.depends = s.depends.filter((d) => d.id !== from);
    editor.setStages(views());
  },
  openStage(key) { note = `openStage(${key})`; refreshInfo(); },
  // Fake asset store: blobs live as object URLs under made-up asset paths.
  async saveAsset(file, name) {
    const ext = (/\.(\w+)$/.exec(name)?.[1] ?? file.type.split('/')[1] ?? 'png').toLowerCase();
    const path = `assets/${Math.random().toString(16).slice(2, 8)}.${ext}`;
    assets.set(path, URL.createObjectURL(file));
    note = `saveAsset ${path} (${file.size} B)`; refreshInfo();
    return path;
  },
};
const assets = new Map<string, string>();

const editor: Editor = createEditor(cv, { board: initialBoard(), stages: views(), host, theme, style, assetUrl: (p) => assets.get(p) ?? p });
(window as unknown as { __editor: Editor }).__editor = editor;

function applyTheme(t2: ThemeTokens) {
  theme = t2;
  const r = document.documentElement.style;
  r.setProperty('--bg', t2.bg); r.setProperty('--panel', t2.panel); r.setProperty('--border', t2.border); r.setProperty('--text', t2.text);
  r.setProperty('--muted', t2.muted); r.setProperty('--accent', t2.accent); r.setProperty('--onAccent', t2.onAccent);
  editor.setTheme(t2);
}

const tools: [Tool, string, string][] = [
  ['select', 'Select', 'V'], ['hand', 'Hand', 'H'], ['rect', 'Rect', '2'], ['diamond', 'Diamond', '3'], ['ellipse', 'Ellipse', '4'],
  ['arrow', 'Arrow', '5'], ['line', 'Line', 'L'], ['pencil', 'Pencil', '6'], ['text', 'Text', '7'], ['stage', 'Stage', 'S'], ['frame', 'Frame', 'F'],
  ['sticky', 'Sticky', '9'], ['image', 'Image', '8'], ['eraser', 'Eraser', '0'],
];
const actions: [string, string, () => void][] = [
  ['undo', 'Undo', () => editor.undo()], ['redo', 'Redo', () => editor.redo()], ['fit', 'Fit', () => editor.zoomToFit()],
  ['style', 'Style: clean', () => { style = style === 'clean' ? 'sketch' : 'clean'; editor.setStyle(style); setLabel('style', `Style: ${style}`); }],
  ['theme', 'Theme: Midnight', () => { applyTheme(theme === midnight ? paper : midnight); setLabel('theme', theme === midnight ? 'Theme: Midnight' : 'Theme: Paper'); }],
  ['convert', 'To stage', () => { void editor.convertSelectionToStage(); }],
  ['stress', 'Shapes 2000', () => stress()], ['cards', 'Cards 200', () => loadPreset('cards')], ['both', 'Both', () => loadPreset('both')], ['bench', 'Bench', () => { void runBench('both', style); }],
  ['phases', 'Phases', () => loadPreset('phases')],
  ['snap', 'Snap: off', () => { editor.setSnap(!editor.getSnap()); setLabel('snap', `Snap: ${editor.getSnap() ? 'on' : 'off'}`); }],
  ['mini', 'Minimap: off', () => { editor.setMinimap(!editor.getMinimap()); setLabel('mini', `Minimap: ${editor.getMinimap() ? 'on' : 'off'}`); }],
  ['group', 'Group', () => editor.runCommand('edit.group')], ['ungroup', 'Ungroup', () => editor.runCommand('edit.ungroup')],
  ['alignL', 'Align L', () => editor.runCommand('align.left')], ['alignT', 'Align T', () => editor.runCommand('align.top')], ['distH', 'Distribute H', () => editor.runCommand('distribute.h')],
  ['find', 'Find…', () => { const q = prompt('Find'); if (!q) return; const ids = editor.findElements(q); note = `find "${q}": ${ids.length}`; refreshInfo(); if (ids[0]) editor.focusElement(ids[0]); }],
  ['exec', 'Execution: off', () => { editor.setExecutionMode(!editor.getExecutionMode()); setLabel('exec', `Execution: ${editor.getExecutionMode() ? 'on' : 'off'}`); }],
  ['pan', 'Pan test', () => panTest()],
  ['hl', 'Highlight', () => { const ks = raw.map((r) => r.key).sort(() => Math.random() - 0.5).slice(0, 2); editor.highlightStages(ks); note = 'highlight ' + ks.join(','); refreshInfo(); }],
  ['ghosts', 'Ghosts', () => ghostDemo()],
  ['reload', 'Reload keepCamera', () => { editor.setBoard(editor.getBoard(), { keepCamera: true }); note = 'reloaded keepCamera'; refreshInfo(); }],
];
bar.innerHTML = tools.map(([k, l, s]) => `<button data-tool="${k}" title="${l}">${l}<kbd>${s}</kbd></button>`).join('') + '<span class="sep"></span>' +
  actions.map(([k, l]) => `<button data-act="${k}">${l}</button>`).join('');
bar.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (!b) return;
  if (b.dataset.tool) editor.setTool(b.dataset.tool as Tool);
  else actions.find((a) => a[0] === b.dataset.act)?.[2]();
});
function setLabel(k: string, text: string) { const b = bar.querySelector(`button[data-act="${k}"]`); if (b) b.textContent = text; }
host.onToolChange('select');

let ghostOn = false;
/** Toggle two proposed stages: G1 depends on two real cards, G2 on G1. */
function ghostDemo() {
  ghostOn = !ghostOn;
  if (!ghostOn) { editor.setGhosts([]); return; }
  const cards = editor.getBoard().elements.filter((e) => e.type === 'card') as unknown as { ref: string; x: number; y: number }[];
  const deps = cards.slice(0, 2).map((c) => c.ref);
  const right = Math.max(...cards.map((c) => c.x)) + 330, y0 = cards[0]?.y ?? 0;
  const mk = (key: string, title: string, d: string[]): StageView => ({ key, title, kind: 'stage', who: 'ai', due: null, priority: 'med', branch: null, pr: null, tags: [], depends: d.map((id) => ({ id, soft: false })), description: '', tasks: [t(key + '-1', 'Proposed task'), t(key + '-2', 'Another one')], comments: [], status: 'ready', progress: [0, 2] });
  editor.setGhosts([{ stage: mk('G1', 'Proposed: add telemetry', deps), x: right, y: y0 }, { stage: mk('G2', 'Proposed: ship beta', ['G1']), x: right + 330, y: y0 }]);
}

// ---- stress presets ------------------------------------------------------------------------
function rng(seed0: number) {
  let a = seed0 >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const FILLS = ['#9b87f5', '#4cc38a', '#e8b04a'];
const WORDS = ['Idea', 'Agents', 'Ship it', 'Plan', 'Review', 'Notes', 'Spike', 'Risk', 'Demo', 'Backlog'];

/** 2000 mixed shapes / stickies / arrows / lines / freedraw / text, deterministic. */
function shapePreset(): Element[] {
  const r = rng(42), out: Element[] = [];
  const X = () => r() * 6000 - 500, Y = () => r() * 4000 - 500;
  for (let i = 0; i < 2000; i++) {
    const id = 'st' + i, k = r(), x = X(), y = Y();
    const common = { id, x, y, index: next(), seed: i + 1, roughness: 1, strokeWidth: 1.5, angle: i % 17 === 0 ? r() * 0.6 : 0 };
    if (k < 0.45) {
      const type = (['rect', 'ellipse', 'diamond'] as const)[i % 3];
      out.push({ ...common, type, w: 30 + r() * 120, h: 30 + r() * 90, fill: r() < 0.25 ? FILLS[i % 3] + '55' : null, text: r() < 0.2 ? WORDS[i % WORDS.length] : undefined } as unknown as Element);
    } else if (k < 0.5) {
      out.push({ ...common, type: 'sticky', w: 110, h: 90, text: WORDS[i % WORDS.length] } as unknown as Element);
    } else if (k < 0.72) {
      const n = 2 + Math.floor(r() * 3), pts: [number, number][] = [[0, 0]];
      for (let j = 1; j < n; j++) pts.push([pts[j - 1][0] + (r() - 0.3) * 160, pts[j - 1][1] + (r() - 0.5) * 120]);
      const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
      out.push({ ...common, type: i % 3 ? 'arrow' : 'line', w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), points: pts, endHead: i % 3 ? 'arrow' : 'none', strokeStyle: i % 7 === 0 ? 'dashed' : 'solid' } as unknown as Element);
    } else if (k < 0.9) {
      const n = 20 + Math.floor(r() * 40), pts: [number, number, number][] = [[0, 0, 0.5]];
      let a = r() * 6.28;
      for (let j = 1; j < n; j++) { a += (r() - 0.5) * 0.9; pts.push([pts[j - 1][0] + Math.cos(a) * 4, pts[j - 1][1] + Math.sin(a) * 4, 0.5]); }
      const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
      out.push({ ...common, type: 'freedraw', w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), points: pts } as unknown as Element);
    } else {
      out.push({ ...common, type: 'text', w: 120, h: 28, text: WORDS[i % WORDS.length] + ' ' + (i % 50), fontSize: 14 + (i % 5) * 4 } as unknown as Element);
    }
  }
  return out;
}

const TASKS = ['Write the parser', 'Review the API surface', 'Benchmark the hot path', 'Update docs and examples', 'Handle the empty state', 'Migrate the old files', 'Add keyboard shortcuts', 'Fix flaky CI job'];
/** Replaces the mock stage store with 200 stages (3-8 tasks each), deps to left/upper neighbours; returns the card elements. */
function cardPreset(): Element[] {
  const r = rng(7), cols = 20, N = 200, out: Element[] = [];
  raw.length = 0;
  for (let i = 0; i < N; i++) {
    const key = 'C' + i, nt = 3 + Math.floor(r() * 6);
    const depends: { id: string; soft: boolean }[] = [];
    if (i % cols) depends.push({ id: 'C' + (i - 1), soft: false });
    if (i >= cols && r() < 0.6) depends.push({ id: 'C' + (i - cols), soft: r() < 0.3 });
    raw.push({ key, title: `Stage ${i}: ${TASKS[i % TASKS.length]} and ${TASKS[(i * 3) % TASKS.length].toLowerCase()}`, who: (['me', 'ai', 'both'] as const)[i % 3],
      due: i % 4 === 0 ? 'Dec ' + (1 + (i % 28)) : null, priority: i % 5 === 0 ? 'high' : 'med', branch: i % 6 === 0 ? 'feat/stage-' + i : null, depends,
      tasks: Array.from({ length: nt }, (_, j) => t(`${key}-${j + 1}`, TASKS[(i + j) % TASKS.length], r() < 0.35)) });
  }
  for (let i = 0; i < N; i++) out.push({ id: 'cc' + i, type: 'card', ref: 'C' + i, x: (i % cols) * 320, y: Math.floor(i / cols) * 460, w: 250, h: 200, index: next() } as Element);
  return out;
}

/** Three phase frames holding cards in different statuses (done / active+ready+blocked / blocked), plus loose shapes. */
function phasesPreset(): Element[] {
  raw.length = 0; raw.push(...structuredClone(rawInit));
  const groups: [string, string[]][] = [['Phase 1 · Foundation', ['S0', 'M0']], ['Phase 2 · Build', ['M1', 'M2', 'M3']], ['Phase 3 · Ship', ['M4', 'M5', 'M6']]];
  const out: Element[] = [];
  groups.forEach(([name, keys], i) => {
    const fid = 'pf' + i, fx = i * 390;
    out.push({ id: fid, type: 'frame', name, x: fx, y: 0, w: 330, h: 920, index: next(), seed: i + 3, roughness: 1 } as Element);
    keys.forEach((k, j) => out.push({ ...(card(k, fx + 40, 40 + j * 290) as object), id: 'pc' + k, frame: fid, index: next() } as Element));
  });
  out.push({ id: 'ps1', type: 'sticky', x: 1230, y: 60, w: 130, h: 100, text: 'Loose idea', index: next(), seed: 5, ...base } as Element);
  out.push({ id: 'pr1', type: 'rect', x: 1230, y: 220, w: 150, h: 80, text: 'Shape', index: next(), seed: 6, ...base } as Element);
  return out;
}

function loadPreset(kind: 'shapes' | 'cards' | 'both' | 'phases') {
  if (kind === 'phases') {
    const els = phasesPreset();
    editor.setStages(views());
    editor.setBoard({ format: 'pathloom.board/1', title: 'Phases', style, elements: els });
    note = 'preset phases'; refreshInfo();
    return;
  }
  const els: Element[] = [];
  if (kind !== 'shapes') { els.push(...cardPreset()); editor.setStages(views()); }
  if (kind !== 'cards') els.push(...shapePreset());
  editor.setBoard({ format: 'pathloom.board/1', title: 'Stress ' + kind, style, elements: els });
  note = `preset ${kind}: ${els.length} elements`;
  refreshInfo();
}
const stress = () => loadPreset('shapes');

// ---- headless benchmark: ?bench=shapes|cards|both&style=clean|sketch&theme=midnight|paper -------
// Also callable repeatedly in one page: await window.__runBench('both', 'sketch'). Result in window.__bench.
interface BenchResult { kind: string; style: string; zoom: number; frames: number; median: number; p95: number; max: number; renderMedian: number; renderP95: number; renderMax: number; renderFrames: number }
const pct = (a: number[], p: number) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
async function runBench(kind: 'shapes' | 'cards' | 'both', st: 'clean' | 'sketch'): Promise<BenchResult> {
  style = st; editor.setStyle(st); setLabel('style', `Style: ${st}`);
  loadPreset(kind);
  await document.fonts?.ready;
  editor.zoomToFit();
  await new Promise((res) => setTimeout(res, 600));
  const z0 = editor.getZoom(), frames: number[] = [], render: number[] = [];
  let prev = performance.now(), prevS = editor.getStats();
  const t0 = prev;
  await new Promise<void>((done) => {
    const tick = (now: number) => {
      const s = editor.getStats(), dF = s.frames - prevS.frames;
      frames.push(now - prev);
      if (dF > 0) render.push((s.totalFrameMs - prevS.totalFrameMs) / dF);
      prev = now; prevS = s;
      const e = now - t0;
      if (e >= 3000) return done();
      // 0-1s pan, 1-2s zoom in (x3 about the centre), 2-3s zoom back out
      if (e < 1000) { const d = Math.floor(e / 250) % 2 ? -1 : 1; editor.panBy(9 * d, 4 * d); }
      else { const ph = e < 2000 ? (e - 1000) / 1000 : 1 - (e - 2000) / 1000; editor.zoomTo(z0 * Math.pow(3, ph)); }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  frames.shift();
  const res: BenchResult = { kind, style: st, zoom: z0, frames: frames.length, median: pct(frames, 0.5), p95: pct(frames, 0.95), max: Math.max(...frames),
    renderMedian: pct(render, 0.5), renderP95: pct(render, 0.95), renderMax: Math.max(...render, 0), renderFrames: render.length };
  (window as unknown as { __bench: BenchResult }).__bench = res;
  note = `bench ${kind}/${st}: render med ${res.renderMedian.toFixed(2)} p95 ${res.renderP95.toFixed(2)} ms`;
  refreshInfo();
  return res;
}
(window as unknown as { __runBench: typeof runBench }).__runBench = runBench;
{
  const q = new URLSearchParams(location.search), bk = q.get('bench'), pk = q.get('preset');
  if (q.get('theme') === 'paper') { applyTheme(paper); setLabel('theme', 'Theme: Paper'); }
  if (bk === 'shapes' || bk === 'cards' || bk === 'both') void runBench(bk, q.get('style') === 'sketch' ? 'sketch' : 'clean');
  else if (pk === 'shapes' || pk === 'cards' || pk === 'both' || pk === 'phases') {
    style = q.get('style') === 'sketch' ? 'sketch' : 'clean'; editor.setStyle(style); setLabel('style', `Style: ${style}`);
    loadPreset(pk);
  }
}

// FPS: editor frames drawn per second while the scene is changing
let lastFrames = 0, lastT = performance.now();
setInterval(() => {
  const s = editor.getStats(), now = performance.now();
  const fps = ((s.frames - lastFrames) * 1000) / (now - lastT);
  lastFrames = s.frames; lastT = now;
  fpsEl.textContent = `elements ${s.elements}\nrender ${fps.toFixed(0)} fps\nframe ${s.lastFrameMs.toFixed(1)} ms${panResult}`;
}, 500);

let panResult = '';
// Pans every 16 ms (independent of rAF cadence) and reports the average cost of a drawn frame.
function panTest() {
  const s0 = editor.getStats(), start = performance.now();
  let dir = 1, n = 0;
  const id = setInterval(() => {
    if (performance.now() - start > 4000) {
      clearInterval(id);
      const s1 = editor.getStats(), fr = s1.frames - s0.frames, ms = (s1.totalFrameMs - s0.totalFrameMs) / Math.max(fr, 1);
      panResult = `
pan test: ${fr} frames, avg ${ms.toFixed(1)} ms -> ~${(1000 / ms).toFixed(0)} fps capable`;
      return;
    }
    if (++n % 60 === 0) dir = -dir;
    editor.panBy(8 * dir, 3 * dir);
  }, 16);
}
refreshInfo();
void lastBoard;
(window as unknown as { __raw: unknown }).__raw = raw;
