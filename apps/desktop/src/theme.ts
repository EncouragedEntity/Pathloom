import type { ThemeTokens } from '@pathloom/canvas';

export type ThemeId = 'graphite' | 'light' | 'paper';

export interface AppTheme {
  id: ThemeId;
  mode: 'dark' | 'light';
  style: 'clean' | 'sketch';
  tokens: ThemeTokens;
}

const fonts = {
  fontUi: 'Inter, system-ui, sans-serif',
  fontHand: 'Caveat, cursive',
  fontMono: '"JetBrains Mono", ui-monospace, monospace',
};

export const THEMES: Record<ThemeId, AppTheme> = {
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

export const THEME_NAMES: Record<ThemeId, string> = { graphite: 'Graphite', light: 'Light', paper: 'Warm paper' };
export const THEME_ORDER: ThemeId[] = ['graphite', 'light', 'paper'];
export const nextTheme = (t: ThemeId): ThemeId => THEME_ORDER[(THEME_ORDER.indexOf(t) + 1) % THEME_ORDER.length];
