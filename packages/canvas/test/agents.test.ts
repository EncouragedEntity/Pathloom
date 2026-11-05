import { describe, expect, it } from 'vitest';
import { AVATAR_GAP, AVATAR_SIZE, agentColor, avatarWidth, claimChipBudget, claimChipText, TITLE_MIN_W, claimIndex, displayName, pillLabel, resolveAgent, rowClaim, sameProfiles, whoLabel } from '../src/agents';
import { DEFAULT_LABELS } from '../src/editor-types';
import { cardLayout, parseHex } from '../src/stage';
import type { StageView, Task, ThemeTokens } from '../src/types';

const dark = { bg: '#0f0d16' } as ThemeTokens;
const light = { bg: '#f3eee3' } as ThemeTokens;
const lum = (c: string) => { const [r, g, b] = parseHex(c).map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

describe('agentColor', () => {
  const names = ['claude', 'codex', 'cursor', 'olia', 'gemini', 'claude-code', 'aider', 'copilot'];
  it('is stable', () => expect(agentColor('claude', dark)).toBe(agentColor('claude', dark)));
  it('main agents get distinct colours', () => {
    expect(new Set(['claude', 'codex', 'cursor', 'gemini', 'olia'].map((n) => agentColor(n, dark))).size).toBe(5);
  });
  it('differs between dark and light themes', () => expect(agentColor('claude', dark)).not.toBe(agentColor('claude', light)));
  it('uses at most 8 hues and keeps text legible on its tint', () => {
    const many = Array.from({ length: 200 }, (_, i) => 'agent' + i);
    expect(new Set(many.map((n) => agentColor(n, dark))).size).toBe(8);
    for (const [th, card] of [[dark, '#1b1827'], [light, '#fdfbf6']] as const) {
      for (const n of names) {
        const c = agentColor(n, th), [r, g, b] = parseHex(c), [cr, cg, cb] = parseHex(card);
        const tint = '#' + [r * 0.16 + cr * 0.84, g * 0.16 + cg * 0.84, b * 0.16 + cb * 0.84].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
        expect(contrast(c, tint)).toBeGreaterThan(3.5);
      }
    }
  });
});

describe('whoLabel', () => {
  const L = DEFAULT_LABELS;
  it('generic', () => { expect(whoLabel('me', L)).toBe(L.whoMe); expect(whoLabel('ai', L)).toBe(L.whoAi); expect(whoLabel('both', L)).toBe(L.whoBoth); });
  it('named', () => {
    expect(whoLabel('ai:claude-code', L)).toBe('Claude Code');
    expect(whoLabel('human:olia', L)).toBe('Olia');
    expect(whoLabel('ai:gemini_cli.v2', L)).toBe('Gemini Cli V2');
  });
  it('empty name falls back to AI', () => expect(whoLabel('ai:', L)).toBe(L.whoAi));
  it('displayName', () => expect(displayName('codex')).toBe('Codex'));
});

const task = (id: string, sub: Task[] = []): Task => ({ id, title: id, done: false, sub });
const claim = (taskId: string, agent = 'claude') => ({ taskId, agent, expiresAt: '2099-01-01T00:00:00Z' });

describe('claims', () => {
  const tasks = [task('A-1', [task('A-1.1'), task('A-1.2', [task('A-1.2.1')])]), task('A-2'), task('A-3', [task('A-3.1')])];
  it('none -> empty, undefined claims ok', () => {
    expect(claimIndex({ tasks, claims: [] }).size).toBe(0);
    expect(claimIndex({ tasks }).size).toBe(0);
  });
  it('parent claim covers all subtasks', () => {
    const idx = claimIndex({ tasks, claims: [claim('A-1')] });
    expect([...idx.keys()].sort()).toEqual(['A-1', 'A-1.1', 'A-1.2', 'A-1.2.1']);
    expect(rowClaim(idx, tasks[1])).toBeUndefined();
  });
  it('subtask claim shows on its top-level row only', () => {
    const idx = claimIndex({ tasks, claims: [claim('A-3.1', 'codex')] });
    expect(idx.has('A-3')).toBe(false);
    expect(rowClaim(idx, tasks[2])?.agent).toBe('codex');
    expect(rowClaim(idx, tasks[0])).toBeUndefined();
  });
  it('own claim wins over inherited', () => {
    const idx = claimIndex({ tasks, claims: [claim('A-1'), claim('A-1.1', 'codex')] });
    expect(idx.get('A-1.1')?.agent).toBe('codex');
    expect(idx.get('A-1.2')?.agent).toBe('claude');
  });
  it('a live claim shows the stage as working until it is done', () => {
    const L = DEFAULT_LABELS;
    expect(pillLabel({ status: 'ready', claims: [] }, L)).toBe(L.statusReady);
    expect(pillLabel({ status: 'ready', claims: [claim('A-1')] }, L)).toBe(L.working);
    expect(pillLabel({ status: 'active', claims: [claim('A-1')] }, L)).toBe(L.working);
    expect(pillLabel({ status: 'done', claims: [claim('A-1')] }, L)).toBe(L.statusDone);
  });
  it('claim chip never covers the task id or the title', () => {
    // long id (BROWSER-01): the chip gets only what is left after the id and a readable title
    expect(claimChipBudget(246, 104, 1)).toBe(246 - 104 - TITLE_MIN_W - 6);
    expect(claimChipBudget(246, 10, 1)).toBe(140);
    // no room: dot only
    expect(claimChipBudget(246, 150, 1)).toBe(0);
    // several claimed rows on one card (an agent took all 6 tasks): dots, no repeated chip
    expect(claimChipBudget(246, 30, 6)).toBe(0);
  });
  it('claim chip shows the heartbeat note after the name', () => {
    expect(claimChipText('Claude')).toBe('Claude');
    expect(claimChipText('Claude', '  ')).toBe('Claude');
    expect(claimChipText('Claude', 'running tests')).toBe('Claude · running tests');
  });
  it('claims do not change card height', () => {
    const base = { key: 'A', title: 'A fairly long stage title that wraps', kind: 'stage', who: 'ai:claude', due: null, priority: 'med', tasks } as unknown as StageView;
    const m = (s: string) => s.length * 7;
    expect(cardLayout({ ...base, claims: [claim('A-1'), claim('A-2')] }, m).h).toBe(cardLayout(base, m).h);
  });
});

describe('agent profiles', () => {
  const cardW = (avatar: string | undefined) => avatarWidth(avatar, () => 10);
  it('resolveAgent falls back to derived name/colour', () => {
    expect(resolveAgent('claude-code', undefined, dark)).toEqual({ name: 'Claude Code', color: agentColor('claude-code', dark), avatar: undefined });
    expect(resolveAgent('x', [{ id: 'other', name: 'O' }], dark).name).toBe('X');
  });
  it('profile name/colour win; blank name and invalid colour fall back', () => {
    const r = resolveAgent('claude', [{ id: 'claude', name: ' Opus ', color: '#D97' }], dark);
    expect(r.name).toBe('Opus'); expect(r.color).toBe('#D97');
    const bad = resolveAgent('claude', [{ id: 'claude', name: '  ', color: 'red' }], dark);
    expect(bad.name).toBe('Claude'); expect(bad.color).toBe(agentColor('claude', dark));
    for (const c of ['#12345', '#ggg', '123456', '#1234567']) expect(resolveAgent('a', [{ id: 'a', color: c }], dark).color).toBe(agentColor('a', dark));
  });
  it('validates avatar: emoji (1-2 chars) or assets/ path', () => {
    const av = (a: string) => resolveAgent('a', [{ id: 'a', avatar: a }], dark).avatar;
    expect(av('✦')).toBe('✦'); expect(av('\u{1F916}')).toBe('\u{1F916}'); expect(av('ab')).toBe('ab');
    expect(av('assets/a.png')).toBe('assets/a.png');
    expect(av('abc')).toBeUndefined(); expect(av('http://x/a.png')).toBeUndefined(); expect(av('')).toBeUndefined();
  });
  it('whoLabel uses profile name', () => {
    expect(whoLabel('ai:claude', DEFAULT_LABELS, [{ id: 'claude', name: 'Opus' }])).toBe('Opus');
    expect(whoLabel('ai:claude', DEFAULT_LABELS)).toBe('Claude');
  });
  it('avatar adds width: none 0, image 12+gap, emoji measured+gap', () => {
    expect(cardW(undefined)).toBe(0); expect(cardW('assets/a.png')).toBe(AVATAR_SIZE + AVATAR_GAP); expect(cardW('✦')).toBe(10 + AVATAR_GAP);
  });
  it('sameProfiles detects changes (drives one-off static invalidation)', () => {
    const a = [{ id: 'a', name: 'A' }];
    expect(sameProfiles(a, [{ id: 'a', name: 'A' }])).toBe(true);
    expect(sameProfiles(a, [{ id: 'a', name: 'B' }])).toBe(false);
    expect(sameProfiles(a, [])).toBe(false);
  });
});
