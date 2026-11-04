import type { CanvasCommand, Keymap } from './keymap';
import type { Board, StageView, ThemeTokens } from './types';

export type Tool = 'select' | 'hand' | 'rect' | 'ellipse' | 'diamond' | 'arrow' | 'line' | 'pencil' | 'text' | 'stage' | 'frame';

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
  onContextAction?(action: 'convertToStage' | 'openStage', payload: { elementId?: string; stageKey?: string }): void;
}

/** Strings drawn by the canvas itself. The host passes localized ones; defaults are English. */
export interface CanvasLabels {
  newStage: string;
  cycleError: string;
  missingStage: string;
  statusDone: string; statusActive: string; statusReady: string; statusBlocked: string;
  whoMe: string; whoAi: string; whoBoth: string;
  priorityHigh: string;
  /** `{n}` is replaced by the number of hidden tasks. */
  moreTasks: string;
  frameDefaultName: string;
  /** `{done}` and `{total}` are replaced by the card counts. */
  frameProgress: string;
  ctxConvertToStage: string; ctxDuplicate: string; ctxDelete: string;
  ctxBringToFront: string; ctxSendToBack: string; ctxLock: string; ctxUnlock: string;
  ctxOpenStage: string; ctxRename: string;
}

export const DEFAULT_LABELS: CanvasLabels = {
  newStage: 'New stage',
  cycleError: 'This dependency would create a cycle',
  missingStage: 'Stage not found',
  statusDone: 'Done', statusActive: 'In progress', statusReady: 'Ready', statusBlocked: 'Blocked',
  whoMe: 'Me', whoAi: 'AI', whoBoth: 'Me + AI',
  priorityHigh: 'High',
  moreTasks: '+{n} more',
  frameDefaultName: 'Phase',
  frameProgress: '{done} of {total} stages',
  ctxConvertToStage: 'Convert to stage', ctxDuplicate: 'Duplicate', ctxDelete: 'Delete',
  ctxBringToFront: 'Bring to front', ctxSendToBack: 'Send to back', ctxLock: 'Lock', ctxUnlock: 'Unlock',
  ctxOpenStage: 'Open stage', ctxRename: 'Rename',
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
}

export interface EditorStats { frames: number; lastFrameMs: number; totalFrameMs: number; elements: number }

export interface Editor {
  setBoard(board: Board): void;
  setStages(stages: StageView[]): void;
  setTheme(theme: ThemeTokens): void;
  setStyle(style: 'clean' | 'sketch'): void;
  setTool(tool: Tool): void;
  getTool(): Tool;
  undo(): void;
  redo(): void;
  zoomToFit(): void;
  zoomTo(scale: number): void;
  getZoom(): number;
  focusElement(id: string): void;
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
  /** Replace bindings (merged over the defaults). */
  setKeymap(map: Partial<Keymap>): void;
  getKeymap(): Keymap;
  /** Run a command as if its shortcut was pressed; same Execution-mode restrictions. */
  runCommand(cmd: CanvasCommand): void;
}
