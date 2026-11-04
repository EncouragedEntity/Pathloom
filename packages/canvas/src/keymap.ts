export type CanvasCommand =
  | 'tool.select' | 'tool.hand' | 'tool.rect' | 'tool.diamond' | 'tool.ellipse' | 'tool.arrow' | 'tool.line'
  | 'tool.pencil' | 'tool.text' | 'tool.frame' | 'tool.stage' | 'tool.sticky' | 'tool.image' | 'tool.eraser'
  | 'edit.undo' | 'edit.redo' | 'edit.delete' | 'edit.duplicate' | 'edit.copy' | 'edit.paste' | 'edit.selectAll'
  | 'edit.convertToStage' | 'arrange.front' | 'arrange.back' | 'edit.toggleLock'
  | 'edit.group' | 'edit.ungroup'
  | 'align.left' | 'align.center' | 'align.right' | 'align.top' | 'align.middle' | 'align.bottom' | 'distribute.h' | 'distribute.v'
  | 'view.zoomIn' | 'view.zoomOut' | 'view.fit' | 'view.zoom100' | 'view.toggleSnap' | 'edit.cancel';

/** Each string is one chord; several chords are alternatives. Format: `Mod+Alt+Shift+<KeyboardEvent.code>`. */
export type Keymap = Record<CanvasCommand, string[]>;

export const DEFAULT_CANVAS_KEYMAP: Keymap = {
  'tool.select': ['KeyV', 'Digit1'],
  'tool.hand': ['KeyH'],
  'tool.rect': ['Digit2'],
  'tool.diamond': ['Digit3'],
  'tool.ellipse': ['Digit4'],
  'tool.arrow': ['Digit5'],
  'tool.line': ['KeyL'],
  'tool.pencil': ['Digit6'],
  'tool.text': ['Digit7'],
  'tool.frame': ['KeyF'],
  'tool.stage': ['KeyS'],
  'tool.sticky': ['Digit9'],
  'tool.image': ['Digit8'],
  'tool.eraser': ['Digit0'],
  'edit.undo': ['Mod+KeyZ'],
  'edit.redo': ['Mod+Shift+KeyZ', 'Mod+KeyY'],
  'edit.delete': ['Delete', 'Backspace'],
  'edit.duplicate': ['Mod+KeyD'],
  'edit.copy': ['Mod+KeyC'],
  'edit.paste': ['Mod+KeyV'],
  'edit.selectAll': ['Mod+KeyA'],
  'edit.convertToStage': ['Mod+Shift+KeyS'],
  'arrange.front': ['Mod+BracketRight'],
  'arrange.back': ['Mod+BracketLeft'],
  'edit.toggleLock': ['Mod+Shift+KeyL'],
  'edit.group': ['Mod+KeyG'],
  'edit.ungroup': ['Mod+Shift+KeyG'],
  // Align / distribute have no default chord: listed so a settings UI can offer them.
  'align.left': [], 'align.center': [], 'align.right': [], 'align.top': [], 'align.middle': [], 'align.bottom': [],
  'distribute.h': [], 'distribute.v': [],
  'view.zoomIn': ['Mod+Equal', 'Mod+Shift+Equal', 'Mod+NumpadAdd'],
  'view.zoomOut': ['Mod+Minus', 'Mod+NumpadSubtract'],
  'view.fit': ['Shift+Digit1'],
  'view.zoom100': ['Shift+Digit0'],
  'view.toggleSnap': ['Mod+Quote'],
  'edit.cancel': ['Escape'],
};

type Platform = 'mac' | 'other';

export function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'other';
  const n = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac|iphone|ipad/i.test(n.userAgentData?.platform ?? n.platform ?? '') ? 'mac' : 'other';
}

const MODIFIER_CODES = /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/;

/** Layout-independent chord of a keydown (uses `code`, never `key`); null for bare modifiers / IME. */
export function chordFromEvent(e: KeyboardEvent, platform: Platform = detectPlatform()): string | null {
  if (!e.code || e.code === 'Unidentified' || MODIFIER_CODES.test(e.code)) return null;
  const mod = platform === 'mac' ? e.metaKey : e.ctrlKey;
  return (mod ? 'Mod+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey ? 'Shift+' : '') + e.code;
}

const KEY_LABELS: Record<string, string> = {
  BracketLeft: '[', BracketRight: ']', Equal: '=', Minus: '-', Backquote: '`', Backslash: '\\', Slash: '/',
  Period: '.', Comma: ',', Semicolon: ';', Quote: "'", ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Escape: 'Esc', Delete: 'Del', NumpadAdd: 'Num +', NumpadSubtract: 'Num -',
};

function keyLabel(code: string): string {
  return KEY_LABELS[code] ?? code.replace(/^Key(?=[A-Z]$)/, '').replace(/^Digit/, '').replace(/^Numpad(?=\d)/, 'Num ');
}

/** Human label: "Ctrl+Shift+S" or "⌘⇧S". */
export function formatChord(chord: string, platform: Platform = detectPlatform()): string {
  const parts = chord.split('+');
  const key = keyLabel(parts.pop() ?? '');
  const has = (m: string) => parts.includes(m);
  if (platform === 'mac') return (has('Mod') ? '⌘' : '') + (has('Alt') ? '⌥' : '') + (has('Shift') ? '⇧' : '') + key;
  return [has('Mod') && 'Ctrl', has('Alt') && 'Alt', has('Shift') && 'Shift', key].filter(Boolean).join('+');
}

/** Chords bound to more than one command. */
export function findConflicts(map: Keymap): Array<{ chord: string; commands: CanvasCommand[] }> {
  const by = new Map<string, CanvasCommand[]>();
  for (const [cmd, chords] of Object.entries(map) as [CanvasCommand, string[]][]) {
    for (const c of new Set(chords)) by.set(c, [...(by.get(c) ?? []), cmd]);
  }
  return [...by].filter(([, cmds]) => cmds.length > 1).map(([chord, commands]) => ({ chord, commands }));
}

/** Partial keymap over the defaults; an empty array unbinds a command. */
export function mergeKeymap(partial?: Partial<Keymap>): Keymap {
  const out = { ...DEFAULT_CANVAS_KEYMAP };
  for (const [cmd, chords] of Object.entries(partial ?? {}) as [CanvasCommand, string[] | undefined][]) {
    if (cmd in out && Array.isArray(chords)) out[cmd] = [...chords];
  }
  return out;
}

/** chord -> command. On a conflict the first command in keymap order wins. */
export function buildChordLookup(map: Keymap): Map<string, CanvasCommand> {
  const m = new Map<string, CanvasCommand>();
  for (const [cmd, chords] of Object.entries(map) as [CanvasCommand, string[]][]) {
    for (const c of chords) if (!m.has(c)) m.set(c, cmd);
  }
  return m;
}
