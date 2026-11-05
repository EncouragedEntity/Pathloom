import type { CanvasLabels } from './editor-types';
import type { StageView, Task, ThemeTokens } from './types';
import { parseHex } from './stage';

/** Named executors (`ai:<name>` / `human:<name>`) and task claims: pure helpers (unit-tested). */

type Claim = NonNullable<StageView['claims']>[number];

/** Eight well-separated hues; lightness/saturation are picked per theme mode (see agentColor). */
const HUES = [8, 38, 84, 150, 186, 217, 268, 324];

const isDarkBg = (bg: string): boolean => {
  const [r, g, b] = parseHex(bg);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
};

function hsl(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return '#' + [f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** Stable colour for an agent/person name: FNV-1a hash (bits 12+) -> one of 8 hues; light tone on dark themes, deep tone on light ones. */
export function agentColor(name: string, theme: ThemeTokens): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193) >>> 0;
  return isDarkBg(theme.bg) ? hsl(HUES[(h >>> 12) % 8], 0.72, 0.68) : hsl(HUES[(h >>> 12) % 8], 0.7, 0.29);
}

/** `claude-code` -> `Claude Code`. */
export const displayName = (name: string): string =>
  name.split(/[-_.]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

/** Name part of a named `who` (`ai:claude` -> `claude`), or null for `me`/`ai`/`both`. */
export function whoName(who: string): string | null {
  const m = /^(?:ai|human):(.+)$/.exec(who);
  return m ? m[1] : null;
}

/** Host-supplied look for an agent id (`ai:<id>`, claim `agent`). Everything but `id` is optional. */
export interface AgentProfile { id: string; name?: string; color?: string; avatar?: string; kind?: string }

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const isAssetAvatar = (a: string): boolean => a.startsWith('assets/');
/** Avatar is drawable: 1-2 characters (emoji) or an `assets/...` path. Anything else is ignored. */
const validAvatar = (a: string | undefined): a is string => !!a && (isAssetAvatar(a) || [...a].length <= 2);

/** Profile name > derived display name; profile colour (valid #rgb/#rrggbb) > agentColor; avatar only if valid. */
export function resolveAgent(id: string, profiles: readonly AgentProfile[] | undefined, theme: ThemeTokens): { name: string; color: string; avatar?: string } {
  const p = profiles?.find((x) => x.id === id), name = p?.name?.trim();
  return { name: name || displayName(id), color: p?.color && HEX.test(p.color) ? p.color : agentColor(id, theme), avatar: validAvatar(p?.avatar) ? p.avatar : undefined };
}

/** Same profiles (so setAgentProfiles can skip a pointless static repaint). */
export const sameProfiles = (a: readonly AgentProfile[], b: readonly AgentProfile[]): boolean =>
  a.length === b.length && a.every((p, i) => JSON.stringify(p) === JSON.stringify(b[i]));

export const AVATAR_SIZE = 12, AVATAR_GAP = 3;
/** Width an avatar adds in front of a chip's name (0 if none): image = 12px circle, emoji = its measured text. */
export const avatarWidth = (avatar: string | undefined, measure: (t: string) => number): number =>
  !avatar ? 0 : (isAssetAvatar(avatar) ? AVATAR_SIZE : measure(avatar)) + AVATAR_GAP;
export { isAssetAvatar };

export function whoLabel(who: string, labels: CanvasLabels, profiles?: readonly AgentProfile[]): string {
  const n = whoName(who);
  if (n) return profiles?.length ? (profiles.find((x) => x.id === n)?.name?.trim() || displayName(n)) : displayName(n);
  return who === 'me' ? labels.whoMe : who === 'both' ? labels.whoBoth : labels.whoAi;
}

/** Claims by task id; a claim on a task also covers all its subtasks. */
export function claimIndex(stage: Pick<StageView, 'tasks' | 'claims'>): Map<string, Claim> {
  const out = new Map<string, Claim>();
  if (!stage.claims?.length) return out;
  const byTask = new Map(stage.claims.map((c) => [c.taskId, c]));
  const walk = (ts: Task[], inherited: Claim | undefined) => {
    for (const t of ts) {
      const c = byTask.get(t.id) ?? inherited;
      if (c) out.set(t.id, c);
      walk(t.sub, c);
    }
  };
  walk(stage.tasks, undefined);
  return out;
}

/** Claim shown on a top-level task row: its own/inherited one, else the first claim on a descendant. */
export function rowClaim(idx: Map<string, Claim>, task: Task): Claim | undefined {
  if (!idx.size) return undefined;
  const find = (t: Task): Claim | undefined => idx.get(t.id) ?? t.sub.map(find).find(Boolean);
  return find(task);
}
