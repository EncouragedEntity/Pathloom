// Board file format (spec §4.3). Source of truth for element shapes; pathloom-core treats elements as opaque JSON.

export type ElementType =
  | 'rect' | 'ellipse' | 'diamond' | 'line' | 'arrow' | 'freedraw'
  | 'text' | 'image' | 'sticky' | 'frame' | 'card' | 'portal';

export type StrokeStyle = 'solid' | 'dashed' | 'dotted';

export interface BaseElement {
  id: string;
  type: ElementType;
  x: number;
  y: number;
  w: number;
  h: number;
  angle?: number;          // radians
  index: string;           // fractional z-order key
  locked?: boolean;
  frame?: string;          // parent frame id
  group?: string;
  stroke?: string;
  fill?: string | null;
  strokeWidth?: number;
  strokeStyle?: StrokeStyle;
  roughness?: number;      // 0 = clean, 1 = sketch (used when board style is sketch)
  seed?: number;           // deterministic rough rendering
  opacity?: number;        // 0..1
}

export interface ShapeElement extends BaseElement {
  type: 'rect' | 'ellipse' | 'diamond' | 'sticky';
  text?: string;           // centered label
  fontSize?: number;
}

export interface TextElement extends BaseElement {
  type: 'text';
  text: string;
  fontSize: number;
  align?: 'left' | 'center' | 'right';
}

export interface Binding { el: string }

export interface LinearElement extends BaseElement {
  type: 'line' | 'arrow';
  points: [number, number][];   // relative to x,y
  start?: Binding;
  end?: Binding;
  startHead?: 'none' | 'arrow';
  endHead?: 'none' | 'arrow';
}

export interface FreedrawElement extends BaseElement {
  type: 'freedraw';
  points: [number, number, number][];   // x, y relative to element; pressure 0..1
}

export interface ImageElement extends BaseElement {
  type: 'image';
  asset: string;           // path relative to plan/assets
}

export interface FrameElement extends BaseElement {
  type: 'frame';
  name: string;
}

export interface CardElement extends BaseElement {
  type: 'card';
  ref: string;             // stage key; h is recomputed by the renderer
  /** Moved by hand on an auto-layout board: auto-layout keeps it where it is. */
  pinned?: boolean;
}

export interface PortalElement extends BaseElement {
  type: 'portal';
  board: string;
}

export type Element =
  | ShapeElement | TextElement | LinearElement | FreedrawElement
  | ImageElement | FrameElement | CardElement | PortalElement;

export interface Board {
  format: 'pathloom.board/1';
  title: string;
  style: 'clean' | 'sketch';
  /** Re-arranged automatically after agent changes (pinned cards stay). */
  autoLayout?: boolean;
  elements: Element[];
}

// Mirrors pathloom-core StageView (camelCase JSON).
export type StageStatus = 'done' | 'active' | 'ready' | 'blocked';

export interface Task {
  id: string;
  title: string;
  done: boolean;
  sub: Task[];
}

export interface Dep { id: string; soft: boolean }

export interface StageView {
  key: string;
  title: string;
  kind: 'stage' | 'milestone' | 'gate';
  /** Hand-off files: project-relative paths or http(s) links. */
  artifacts?: string[];
  /** `kind: gate`: command that must pass. */
  check?: string | null;
  /** `me`, `ai`, `both`, `ai:<name>` or `human:<name>`. */
  who: string;
  due: string | null;
  priority: 'low' | 'med' | 'high';
  branch: string | null;
  pr: string | null;
  tags: string[];
  depends: Dep[];
  description: string;
  tasks: Task[];
  comments: { at: string; author: string; text: string }[];
  status: StageStatus;
  progress: [number, number];
  /** Live task claims (agent working on a task); a claim on a task covers its subtasks. */
  claims?: { taskId: string; agent: string; expiresAt: string; heartbeatAt?: string; silent?: boolean; note?: string }[];
  /** Per task id: a note and attached files (project-relative paths or links). */
  taskInfo?: Record<string, { note?: string; files?: string[] }>;
  /** Proof per done task id: the check that was run (exit code 0). */
  evidence?: Record<string, Evidence>;
  /** External sessions (other apps) that worked on this stage, oldest first. */
  sessions?: { client: string; id: string; url?: string | null; title?: string | null }[];
}

/** Check attached to a done task (`set_task` evidence). */
export interface Evidence {
  command: string;
  exit_code: number;
  duration_ms?: number;
  summary?: string;
  log?: string;
  at: string;
  by: string;
}

export interface ThemeTokens {
  bg: string; panel: string; card: string; card2: string;
  border: string; border2: string;
  text: string; text2: string; muted: string;
  accent: string; onAccent: string;
  ok: string; warn: string; bad: string;
  edge: string; grid: string;
  fontUi: string; fontHand: string; fontMono: string;
  radiusCard: number;
}

/** A proposed stage card drawn at a world position; not a board element (not saved, selectable or undoable). */
export interface Ghost { stage: StageView; x: number; y: number }
