// Keyboard shortcuts: canvas commands (from @pathloom/canvas) + app commands, user overrides in localStorage.
// Chords use KeyboardEvent.code, so they work on any keyboard layout (e.g. Ukrainian).
import { useEffect } from 'react';
import {
  DEFAULT_CANVAS_KEYMAP, chordFromEvent, findConflicts, formatChord,
  type CanvasCommand, type Keymap,
} from '@pathloom/canvas';
import { create } from 'zustand';

export type AppCommand = 'app.focus' | 'app.toggleView' | 'app.openFolder' | 'app.settings' | 'app.palette';
export type Command = CanvasCommand | AppCommand;
export type FullKeymap = Record<Command, string[]>;

export const DEFAULT_APP_KEYMAP: Record<AppCommand, string[]> = {
  'app.focus': ['KeyE'],
  'app.toggleView': ['Mod+KeyL'],
  'app.openFolder': ['Mod+KeyO'],
  'app.settings': ['Mod+Comma'],
  'app.palette': ['Mod+KeyK'],
};

export const DEFAULT_KEYMAP: FullKeymap = { ...DEFAULT_CANVAS_KEYMAP, ...DEFAULT_APP_KEYMAP };

/** Display order and grouping in the settings dialog. */
export const COMMAND_GROUPS: { id: string; commands: Command[] }[] = [
  { id: 'tools', commands: ['tool.select', 'tool.hand', 'tool.rect', 'tool.diamond', 'tool.ellipse', 'tool.arrow', 'tool.line', 'tool.pencil', 'tool.text', 'tool.sticky', 'tool.image', 'tool.eraser', 'tool.frame', 'tool.stage'] },
  { id: 'edit', commands: ['edit.undo', 'edit.redo', 'edit.delete', 'edit.duplicate', 'edit.copy', 'edit.paste', 'edit.selectAll', 'edit.convertToStage', 'arrange.front', 'arrange.back', 'edit.toggleLock', 'edit.group', 'edit.ungroup', 'edit.cancel'] },
  { id: 'arrange', commands: ['align.left', 'align.center', 'align.right', 'align.top', 'align.middle', 'align.bottom', 'distribute.h', 'distribute.v'] },
  { id: 'view', commands: ['view.zoomIn', 'view.zoomOut', 'view.fit', 'view.zoom100', 'view.toggleSnap', 'app.focus', 'app.toggleView'] },
  { id: 'app', commands: ['app.palette', 'app.openFolder', 'app.settings'] },
];

const STORAGE_KEY = 'pathloom.keymap';

function loadOverrides(): Partial<FullKeymap> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Partial<FullKeymap>) : {};
  } catch {
    return {};
  }
}

function saveOverrides(o: Partial<FullKeymap>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(o));
  } catch {
    // Preference only; ignore storage failures.
  }
}

interface KeyStore {
  overrides: Partial<FullKeymap>;
  bind(cmd: Command, chords: string[]): void;
  reset(cmd?: Command): void;
}

export const useKeys = create<KeyStore>((set, get) => ({
  overrides: loadOverrides(),
  bind(cmd, chords) {
    const overrides = { ...get().overrides, [cmd]: chords };
    saveOverrides(overrides);
    set({ overrides });
  },
  reset(cmd) {
    const overrides = { ...get().overrides };
    if (cmd) delete overrides[cmd];
    else for (const k of Object.keys(overrides)) delete overrides[k as Command];
    saveOverrides(overrides);
    set({ overrides });
  },
}));

export function effectiveKeymap(overrides: Partial<FullKeymap>): FullKeymap {
  return { ...DEFAULT_KEYMAP, ...overrides };
}

export function canvasPart(map: FullKeymap): Partial<Keymap> {
  const out: Partial<Keymap> = {};
  for (const k of Object.keys(DEFAULT_CANVAS_KEYMAP) as CanvasCommand[]) out[k] = map[k];
  return out;
}

export function conflictsOf(map: FullKeymap): Map<Command, Command[]> {
  const res = new Map<Command, Command[]>();
  for (const { commands } of findConflicts(map as unknown as Keymap)) {
    const cmds = commands as Command[];
    for (const c of cmds) res.set(c, cmds.filter((x) => x !== c));
  }
  return res;
}

export function label(cmd: Command, map: FullKeymap): string {
  const first = map[cmd]?.[0];
  return first ? formatChord(first) : '';
}

export { chordFromEvent, formatChord };

function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

/** Global handler for app-level commands. The canvas handles its own commands. */
export function useAppShortcuts(handlers: Partial<Record<AppCommand, () => void>>): void {
  const overrides = useKeys((s) => s.overrides);
  useEffect(() => {
    const map = effectiveKeymap(overrides);
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || document.querySelector('[data-recording-shortcut]')) return;
      const chord = chordFromEvent(e);
      if (!chord) return;
      for (const cmd of Object.keys(DEFAULT_APP_KEYMAP) as AppCommand[]) {
        if (map[cmd].includes(chord) && handlers[cmd]) {
          e.preventDefault();
          handlers[cmd]?.();
          return;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overrides, handlers]);
}
