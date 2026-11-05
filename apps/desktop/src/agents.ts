// Named assignees (`ai:claude`, `human:olia`), claims and the activity log in the UI.
// See docs/m6-agents-contracts.md.
import type { TFunction } from 'i18next';
import { resolveAgent, type AgentProfile, type StageView, type ThemeTokens } from '@pathloom/canvas';

export interface LogEntry {
  at: string; author: string; source: string; action: string; summary: string;
  stages: string[]; tasks: string[]; files: string[];
}
export interface SessionRef { client: string; id: string; url?: string | null; title?: string | null }
export interface ClaimView { taskId: string; agent: string; expiresAt: string }

const GENERIC = new Set(['me', 'ai', 'both']);

/** "ai:claude-code" → profile name or "Claude Code"; me/ai/both → translated labels. */
export function whoText(who: string, t: TFunction, profiles: AgentProfile[] = []): string {
  if (GENERIC.has(who)) return t(`who.${who}`);
  const name = who.includes(':') ? who.slice(who.indexOf(':') + 1) : who;
  const p = profiles.find((x) => x.id === name);
  if (p?.name?.trim()) return p.name.trim();
  return name.split(/[-_.\s]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

/** Display name of an agent id from claims/log (profile name, else "claude-code" → "Claude Code"). */
export function agentText(agent: string, profiles: AgentProfile[] = []): string {
  const p = profiles.find((x) => x.id === agent);
  if (p?.name?.trim()) return p.name.trim();
  if (agent === 'me') return agent;
  return agent.split(/[-_.\s]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

/** Color for a named who / agent, or null for generic me/ai/both. */
export function whoColor(who: string, tokens: ThemeTokens, profiles: AgentProfile[] = []): string | null {
  if (GENERIC.has(who)) return null;
  const name = who.includes(':') ? who.slice(who.indexOf(':') + 1) : who;
  return resolveAgent(name, profiles, tokens).color;
}

/** Every assignee value worth offering in pickers: generic ones, those used in the plan, agents seen in the log. */
export function knownWhos(stages: StageView[], activity: LogEntry[], profiles: AgentProfile[] = []): string[] {
  const set = new Set<string>(['me', 'ai', 'both']);
  for (const p of profiles) set.add(`ai:${p.id}`);
  for (const s of stages) set.add(s.who);
  for (const s of stages) for (const c of s.claims ?? []) set.add(`ai:${c.agent}`);
  for (const e of activity) if (e.source !== 'app' && e.author && e.author !== 'me' && e.author !== 'agent') set.add(`ai:${e.author}`);
  return [...set];
}

/** Live claims of a stage keyed by task id (a claim on a parent covers its subtasks). */
export function claimOf(stage: StageView, taskId: string): ClaimView | undefined {
  const claims = stage.claims ?? [];
  return claims.find((c) => c.taskId === taskId) ?? claims.find((c) => taskId.startsWith(c.taskId) && /[a-z]$/.test(taskId));
}

/** "5 min ago" style relative time. */
export function ago(iso: string, t: TFunction): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (Number.isNaN(s)) return '';
  if (s < 60) return t('time.now');
  if (s < 3600) return t('time.min', { count: Math.round(s / 60) });
  if (s < 86400) return t('time.hour', { count: Math.round(s / 3600) });
  return t('time.day', { count: Math.round(s / 86400) });
}
