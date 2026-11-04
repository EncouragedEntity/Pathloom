import type { Element } from './types';

export interface Change { id: string; before: Element | null; after: Element | null }
export interface HistoryEntry { changes: Change[] }

/** One entry per completed user action; each change is a before/after element snapshot (null = absent). */
export class History {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  constructor(private limit = 200) {}

  push(entry: HistoryEntry): void {
    if (!entry.changes.length) return;
    this.undoStack.push(entry);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }
  undo(): HistoryEntry | null {
    const e = this.undoStack.pop() ?? null;
    if (e) this.redoStack.push(e);
    return e;
  }
  redo(): HistoryEntry | null {
    const e = this.redoStack.pop() ?? null;
    if (e) this.undoStack.push(e);
    return e;
  }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  clear() { this.undoStack = []; this.redoStack = []; }
}
