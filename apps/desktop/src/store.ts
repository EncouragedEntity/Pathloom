import { create } from 'zustand';
import type { Board, Editor, StageView, Tool } from '@pathloom/canvas';
import { api, errorText, type ProjectSnapshot } from './api';
import type { ThemeId } from './theme';

type SaveState = { kind: 'saved' } | { kind: 'saving' } | { kind: 'error'; message: string };

interface AppStore {
  project: ProjectSnapshot | null;
  boards: string[];
  stages: StageView[];
  openBoards: string[];
  activeBoard: string | null;
  board: Board | null;
  selectedStage: string | null;
  tool: Tool;
  zoom: number;
  save: SaveState;
  theme: ThemeId;
  error: string | null;
  view: 'board' | 'list';
  exec: boolean;
  settingsTab: 'general' | 'keys' | null;

  enterProject(snap: ProjectSnapshot): Promise<void>;
  closeProject(): Promise<void>;
  openBoard(name: string): Promise<void>;
  closeBoard(name: string): Promise<void>;
  createBoard(name: string): Promise<void>;
  setStages(stages: StageView[]): void;
  boardChanged(board: Board): void;
  flushSave(): Promise<void>;
  set(partial: Partial<AppStore>): void;
}

// The live canvas editor; owned by CanvasView, used by sidebar/inspector for focus and tools.
export const editorRef: { current: Editor | null } = { current: null };

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pending: { name: string; board: Board } | null = null;
const SAVE_DELAY_MS = 400;

async function writePending(setSave: (s: SaveState) => void): Promise<void> {
  if (!pending) return;
  const job = pending;
  pending = null;
  try {
    await api.boardSave(job.name, job.board);
    if (!pending) setSave({ kind: 'saved' });
  } catch (e) {
    setSave({ kind: 'error', message: errorText(e) });
  }
}

export const useApp = create<AppStore>((set, get) => ({
  project: null,
  boards: [],
  stages: [],
  openBoards: [],
  activeBoard: null,
  board: null,
  selectedStage: null,
  tool: 'select',
  zoom: 1,
  save: { kind: 'saved' },
  theme: 'graphite',
  error: null,
  view: 'board',
  exec: false,
  settingsTab: null,

  async enterProject(snap) {
    await get().flushSave();
    set({ project: snap, boards: snap.boards, stages: snap.stages, openBoards: [], activeBoard: null, board: null, selectedStage: null, view: 'board', exec: false });
    const first = snap.boards.includes('roadmap') ? 'roadmap' : snap.boards[0];
    if (first) await get().openBoard(first);
  },

  async closeProject() {
    await get().flushSave();
    set({ project: null, boards: [], stages: [], openBoards: [], activeBoard: null, board: null, selectedStage: null });
  },

  async openBoard(name) {
    await get().flushSave();
    try {
      const board = await api.boardLoad(name);
      const open = get().openBoards.includes(name) ? get().openBoards : [...get().openBoards, name];
      set({ board, activeBoard: name, openBoards: open, selectedStage: null, error: null });
    } catch (e) {
      set({ error: errorText(e) });
    }
  },

  async closeBoard(name) {
    const open = get().openBoards.filter((b) => b !== name);
    set({ openBoards: open });
    if (get().activeBoard === name) {
      const next = open[open.length - 1];
      if (next) await get().openBoard(next);
      else {
        await get().flushSave();
        set({ activeBoard: null, board: null });
      }
    }
  },

  async createBoard(name) {
    try {
      await api.boardCreate(name, name);
      set({ boards: await api.boardsList() });
      await get().openBoard(name);
    } catch (e) {
      set({ error: errorText(e) });
    }
  },

  setStages(stages) {
    set({ stages });
    editorRef.current?.setStages(stages);
  },

  boardChanged(board) {
    const name = get().activeBoard;
    if (!name) return;
    pending = { name, board };
    set({ board, save: { kind: 'saving' } });
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void writePending((s) => set({ save: s })), SAVE_DELAY_MS);
  },

  async flushSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    await writePending((s) => set({ save: s }));
  },

  set: (partial) => set(partial),
}));

// Best effort: flush pending board writes when the window closes.
window.addEventListener('beforeunload', () => {
  void useApp.getState().flushSave();
});
