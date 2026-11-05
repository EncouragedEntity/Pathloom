import type { AgentProfile } from './agents';
import type { CanvasCommand, Keymap } from './keymap';
import type { Board, Ghost, StageView, ThemeTokens } from './types';

export type Tool = 'select' | 'hand' | 'rect' | 'ellipse' | 'diamond' | 'arrow' | 'line' | 'pencil' | 'text' | 'stage' | 'frame' | 'sticky' | 'image' | 'eraser';

export interface CanvasHost {
  /** After every completed action (not during drags). The host debounces saving. */
  onBoardChange(board: Board): void;
  onSelectionChange(sel: { elementIds: string[]; stageKey: string | null }): void;
  onToolChange(tool: Tool): void;
  onZoomChange(scale: number): void;
  createStage(title: string): Promise<StageView>;
  toggleTask(taskId: string): Promise<void>;
  /** null = ok, string = error message for the toast (e.g. a cycle). */
  linkStages(from: string, to: string): Promise<string | null>;
  unlinkStages(from: string, to: string): Promise<void>;
  openStage(key: string): void;
  /**
   * Called after a context-menu / shortcut action the canvas has already carried out itself
   * (informational: `convertToStage` after `createStage`, `openStage` after `openStage`).
   */
  /**
   * Store an image the user added (picker, paste or drop); resolves to the asset path to keep in the board
   * (e.g. `assets/ab12cd.png`). Without it the image tool, paste and drop are disabled.
   */
  saveAsset?(file: Blob, name: string): Promise<string>;
  onContextAction?(action: 'convertToStage' | 'openStage', payload: { elementId?: string; stageKey?: string }): void;
}

/** Strings drawn by the canvas itself. The host passes localized ones; defaults are English. */
export interface CanvasLabels {
  newStage: string;
  cycleError: string;
  missingStage: string;
  statusDone: string; statusActive: string; statusReady: string; statusBlocked: string;
  whoMe: string; whoAi: string; whoBoth: string;
  /** `{agent}` is replaced by the agent display name. */
  claimedBy: string;
  /** Short status next to a pulsing claim dot. */
  working: string;
  priorityHigh: string;
  /** `{n}` is replaced by the number of hidden tasks. */
  moreTasks: string;
  frameDefaultName: string;
  /** `{done}` and `{total}` are replaced by the card counts. */
  frameProgress: string;
  ctxConvertToStage: string; ctxDuplicate: string; ctxDelete: string;
  ctxBringToFront: string; ctxSendToBack: string; ctxLock: string; ctxUnlock: string;
  ctxOpenStage: string; ctxRename: string;
  ctxGroup: string; ctxUngroup: string;
  ctxAlignLeft: string; ctxAlignCenter: string; ctxAlignRight: string; ctxAlignTop: string; ctxAlignMiddle: string; ctxAlignBottom: string;
  ctxDistributeH: string; ctxDistributeV: string;
  /** Shown in an image placeholder when the asset cannot be loaded. */
  imageBroken: string;
  /** Accessible name of the minimap. */
  minimap: string;
  /** Badge on ghost (proposed) cards. */
  ghostBadge: string;
  /** Milestone gate line; `{done}` and `{total}` are replaced by hard dependencies done / total. */
  milestoneInputs: string;
}

export const DEFAULT_LABELS: CanvasLabels = {
  newStage: 'New stage',
  cycleError: 'This dependency would create a cycle',
  missingStage: 'Stage not found',
  statusDone: 'Done', statusActive: 'In progress', statusReady: 'Ready', statusBlocked: 'Blocked',
  whoMe: 'Me', whoAi: 'AI', whoBoth: 'Me + AI',
  claimedBy: '{agent} is on it', working: 'working',
  priorityHigh: 'High',
  moreTasks: '+{n} more',
  frameDefaultName: 'Phase',
  frameProgress: '{done} of {total} stages',
  ctxConvertToStage: 'Convert to stage', ctxDuplicate: 'Duplicate', ctxDelete: 'Delete',
  ctxBringToFront: 'Bring to front', ctxSendToBack: 'Send to back', ctxLock: 'Lock', ctxUnlock: 'Unlock',
  ctxOpenStage: 'Open stage', ctxRename: 'Rename',
  ctxGroup: 'Group', ctxUngroup: 'Ungroup',
  ctxAlignLeft: 'Align left', ctxAlignCenter: 'Align center', ctxAlignRight: 'Align right',
  ctxAlignTop: 'Align top', ctxAlignMiddle: 'Align middle', ctxAlignBottom: 'Align bottom',
  ctxDistributeH: 'Distribute horizontally', ctxDistributeV: 'Distribute vertically',
  imageBroken: 'Image unavailable',
  minimap: 'Minimap',
  ghostBadge: 'Proposed',
  milestoneInputs: '{done} of {total} inputs',
};

export interface EditorOptions {
  board: Board;
  stages: StageView[];
  host: CanvasHost;
  theme: ThemeTokens;
  style?: 'clean' | 'sketch';
  labels?: Partial<CanvasLabels>;
  /** Overrides over DEFAULT_CANVAS_KEYMAP. */
  keymap?: Partial<Keymap>;
  /** URL an <img> can load for an image element's `asset` path (default: the path itself). */
  assetUrl?: (path: string) => string;
  /** Initial agent profiles (see Editor.setAgentProfiles). */
  agents?: AgentProfile[];
  /** Initial grid-snap state (default off). */
  snap?: boolean;
  /** Initial minimap state (default off). */
  minimap?: boolean;
}

export interface EditorStats { frames: number; lastFrameMs: number; totalFrameMs: number; elements: number }

export interface Editor {
  /**
   * Replace the board. With `keepCamera` the camera, tool and selection (ids that still exist) are kept and
   * autofit is not re-armed; history is still cleared (undo cannot resurrect pre-reload state). For live reload.
   */
  setBoard(board: Board, opts?: { keepCamera?: boolean }): void;
  setStages(stages: StageView[]): void;
  setTheme(theme: ThemeTokens): void;
  /** Per-agent name/colour/avatar overrides for who chips and claim chips. Avatar: 1-2 chars (emoji) or `assets/...` (loaded via assetUrl). */
  setAgentProfiles(profiles: AgentProfile[]): void;
  setStyle(style: 'clean' | 'sketch'): void;
  setTool(tool: Tool): void;
  getTool(): Tool;
  undo(): void;
  redo(): void;
  zoomToFit(): void;
  zoomTo(scale: number): void;
  getZoom(): number;
  /** Select an element and glide the camera to it (~250 ms, same zoom). */
  focusElement(id: string): void;
  /** Ids (z-order) of elements whose text, label, frame name or stage key/title/task titles contain `query` (case-insensitive). */
  findElements(query: string): string[];
  /** Snap creation / move / resize to a 20-unit grid. Off: smart guides against nearby elements instead. */
  setSnap(on: boolean): void;
  getSnap(): boolean;
  /** Small overview in the bottom-right corner showing all elements and the viewport; click or drag to pan. */
  setMinimap(on: boolean): void;
  getMinimap(): boolean;
  getBoard(): Board;
  destroy(): void;
  /** Extra (not in the M1 contract): turn the single selected rect/ellipse/diamond into a stage card. */
  convertSelectionToStage(): Promise<void>;
  /** Extra: pan by screen pixels (used by the stress harness). */
  panBy(dx: number, dy: number): void;
  /** Extra: render statistics (frames drawn since creation, last frame duration). */
  getStats(): EditorStats;
  /** Execution mode: read-only view that dims finished/blocked work. Not written to the board. */
  setExecutionMode(on: boolean): void;
  getExecutionMode(): boolean;
  /** Remove every card of the stage (the stage was deleted); one undo step. */
  removeStageCards(key: string): void;
  /** Accent glow on the cards of these stages that fades out over `ms` (default 8000). Repeated keys restart. */
  highlightStages(keys: string[], ms?: number): void;
  /** Proposed stage cards (dashed, translucent) with their dependency edges; [] clears. Not board elements. */
  setGhosts(ghosts: Ghost[]): void;
  /** Replace bindings (merged over the defaults). */
  setKeymap(map: Partial<Keymap>): void;
  getKeymap(): Keymap;
  /** Run a command as if its shortcut was pressed; same Execution-mode restrictions. */
  runCommand(cmd: CanvasCommand): void;
}
