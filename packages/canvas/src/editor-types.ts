import type { Board, StageView, ThemeTokens } from './types';

export type Tool = 'select' | 'hand' | 'rect' | 'ellipse' | 'diamond' | 'arrow' | 'line' | 'pencil' | 'text' | 'stage';

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
}

export const DEFAULT_LABELS: CanvasLabels = {
  newStage: 'New stage',
  cycleError: 'This dependency would create a cycle',
  missingStage: 'Stage not found',
  statusDone: 'Done', statusActive: 'In progress', statusReady: 'Ready', statusBlocked: 'Blocked',
  whoMe: 'Me', whoAi: 'AI', whoBoth: 'Me + AI',
  priorityHigh: 'High',
  moreTasks: '+{n} more',
};

export interface EditorOptions {
  board: Board;
  stages: StageView[];
  host: CanvasHost;
  theme: ThemeTokens;
  style?: 'clean' | 'sketch';
  labels?: Partial<CanvasLabels>;
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
}
