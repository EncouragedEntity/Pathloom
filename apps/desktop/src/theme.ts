import type { ThemeTokens } from '@pathloom/canvas';

export type BuiltinThemeId = 'graphite' | 'light' | 'paper';
/** Built-in id or `custom:<slug>` for themes loaded from files. */
export type ThemeId = string;

export interface AppTheme {
  id: ThemeId;
  name?: string;
  mode: 'dark' | 'light';
  style: 'clean' | 'sketch';
  tokens: ThemeTokens;
}

const fonts = {
  fontUi: 'Inter, system-ui, sans-serif',
  fontHand: 'Caveat, cursive',
  fontMono: '"JetBrains Mono", ui-monospace, monospace',
};

export const THEMES: Record<BuiltinThemeId, AppTheme> = {
  graphite: {
    id: 'graphite', mode: 'dark', style: 'clean',
    tokens: {
      bg: '#1c1e22', panel: '#23262b', card: '#272a30', card2: '#2e3138',
      border: '#343840', border2: '#444952', text: '#e7e9ec', text2: '#b9bec6', muted: '#868c96',
      accent: '#e8a33d', onAccent: '#1c1e22', ok: '#5bb98b', warn: '#e8b04a', bad: '#e5534b',
      edge: '#4b5059', grid: '#2a2d33', radiusCard: 12, ...fonts,
    },
  },
  light: {
    id: 'light', mode: 'light', style: 'clean',
    tokens: {
      bg: '#f7f7f8', panel: '#ffffff', card: '#ffffff', card2: '#f1f1f3',
      border: '#e4e4e7', border2: '#d4d4d8', text: '#18181b', text2: '#3f3f46', muted: '#71717a',
      accent: '#c27c0e', onAccent: '#ffffff', ok: '#16a34a', warn: '#b45309', bad: '#dc2626',
      edge: '#b8b8c0', grid: '#e2e2e6', radiusCard: 12, ...fonts,
    },
  },
  paper: {
    id: 'paper', mode: 'light', style: 'sketch',
    tokens: {
      bg: '#f3eee3', panel: '#faf7f0', card: '#fdfbf6', card2: '#f4efe4',
      border: '#ddd3bf', border2: '#c9bda4', text: '#2c2720', text2: '#574f42', muted: '#8a7f6b',
      accent: '#b4552d', onAccent: '#ffffff', ok: '#4f7f3a', warn: '#b7791f', bad: '#b3261e',
      edge: '#a89b82', grid: '#e0d6c2', radiusCard: 12, ...fonts,
    },
  },
};

// Same tokens drive the canvas and the CSS shell.
export function applyCssVars(t: ThemeTokens): void {
  const s = document.documentElement.style;
  const map: Record<string, string> = {
    '--bg': t.bg, '--panel': t.panel, '--card': t.card, '--card2': t.card2,
    '--bd': t.border, '--bd2': t.border2, '--tx': t.text, '--tx2': t.text2, '--mu': t.muted,
    '--ac': t.accent, '--actx': t.onAccent, '--ok': t.ok, '--warn': t.warn, '--bad': t.bad,
    '--font-ui': t.fontUi, '--font-mono': t.fontMono, '--font-hand': t.fontHand,
  };
  for (const [k, v] of Object.entries(map)) s.setProperty(k, v);
}

const BUILTIN_NAMES: Record<BuiltinThemeId, string> = { graphite: 'Graphite', light: 'Light', paper: 'Warm paper' };
const BUILTIN_ORDER: BuiltinThemeId[] = ['graphite', 'light', 'paper'];

/** All themes: built-ins first, then custom ones. */
export function allThemes(custom: AppTheme[]): AppTheme[] {
  return [...BUILTIN_ORDER.map((id) => ({ ...THEMES[id], name: BUILTIN_NAMES[id] })), ...custom];
}
export function findTheme(id: ThemeId, custom: AppTheme[]): AppTheme {
  return allThemes(custom).find((t) => t.id === id) ?? THEMES.graphite;
}
export function nextTheme(id: ThemeId, custom: AppTheme[]): ThemeId {
  const list = allThemes(custom);
  const i = list.findIndex((t) => t.id === id);
  return list[(i + 1) % list.length].id;
}

// ---- custom themes (.pathloom/themes/*.json or <app config>/themes/*.json, spec §6) ----

const COLOR = /^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\))$/;
const COLOR_KEYS = ['bg', 'panel', 'card', 'card2', 'border', 'border2', 'text', 'text2', 'muted', 'accent', 'onAccent', 'ok', 'warn', 'bad', 'edge', 'grid'] as const;

/** Turns a theme file into an AppTheme; unknown or invalid colors fall back to Graphite/Light. Null if unusable. */
export function parseCustomTheme(raw: unknown): AppTheme | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { name?: unknown; mode?: unknown; style?: unknown; colors?: Record<string, unknown>; radius?: { card?: unknown }; font?: Record<string, unknown> };
  if (typeof r.name !== 'string' || !r.name.trim()) return null;
  const mode = r.mode === 'light' ? 'light' : 'dark';
  const base = THEMES[mode === 'light' ? 'light' : 'graphite'].tokens;
  const tokens: ThemeTokens = { ...base };
  for (const k of COLOR_KEYS) {
    const v = r.colors?.[k];
    if (typeof v === 'string' && COLOR.test(v.trim())) tokens[k] = v.trim();
  }
  if (typeof r.radius?.card === 'number' && r.radius.card >= 0 && r.radius.card <= 32) tokens.radiusCard = r.radius.card;
  const font = (k: string) => (typeof r.font?.[k] === 'string' ? String(r.font[k]) : undefined);
  tokens.fontUi = font('ui') ? `${font('ui')}, ${base.fontUi}` : base.fontUi;
  tokens.fontHand = font('hand') ? `${font('hand')}, ${base.fontHand}` : base.fontHand;
  tokens.fontMono = font('mono') ? `${font('mono')}, ${base.fontMono}` : base.fontMono;
  const id = 'custom:' + r.name.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-');
  return { id, name: r.name.trim(), mode, style: r.style === 'sketch' ? 'sketch' : 'clean', tokens };
}
