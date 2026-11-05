// Live reload of plan files changed outside the app (agents, CLI, git), undo of those changes,
// and review-mode proposals shown as ghost cards. See docs/m3-contracts.md §4.
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import type { Ghost, StageView, Task } from '@pathloom/canvas';
import { api, errorText } from './api';
import { editorRef, useApp } from './store';

export interface PlanChanged { stages: string[]; boards: string[]; proposals: boolean; group: number | null }

export interface CardPlacement { key: string; x: number; y: number; w: number }
export interface ApplyReport {
  created: string[]; updated: string[]; board: string; cards_added: CardPlacement[];
  frames_added: string[]; warnings: string[]; files: string[];
}
interface SpecStage {
  id?: string; title?: string; kind?: StageView['kind']; who?: StageView['who']; priority?: StageView['priority'];
  depends?: (string | { id: string; soft?: boolean })[]; tasks?: string[];
}
export interface Proposal { id: string; created_at: string; author: string; spec: { board?: string; stages?: SpecStage[] }; preview: ApplyReport }

export const agentApi = {
  undo: (group: number) => invoke<StageView[]>('agent_undo', { group }),
  proposals: () => invoke<Proposal[]>('proposals_list'),
  accept: (id: string) => invoke<ApplyReport>('proposal_accept', { id }),
  reject: (id: string) => invoke<void>('proposal_reject', { id }),
};

/** Ghost cards for the proposal's new stages on the active board. */
export function ghostsFor(p: Proposal, activeBoard: string | null, real: StageView[] = []): Ghost[] {
  const done = new Set(real.filter((r) => r.status === 'done').map((r) => r.key));
  if ((p.preview.board || p.spec.board || 'roadmap') !== activeBoard) return [];
  const specs = new Map((p.spec.stages ?? []).filter((s) => s.id).map((s) => [s.id as string, s]));
  return p.preview.cards_added.map((c) => {
    const s = specs.get(c.key) ?? {};
    const tasks: Task[] = (s.tasks ?? []).map((title, i) => ({ id: `${c.key}-${String(i + 1).padStart(2, '0')}`, title, done: false, sub: [] }));
    const stage: StageView = {
      key: c.key, title: s.title ?? c.key, kind: s.kind ?? 'stage', who: s.who ?? 'ai', due: null, priority: s.priority ?? 'med',
      branch: null, pr: null, tags: [], description: '', comments: [], status: 'ready' as StageView['status'], progress: [0, tasks.length], tasks,
      depends: (s.depends ?? []).map((d) => (typeof d === 'string' ? { id: d, soft: false } : { id: d.id, soft: !!d.soft })),
    };
    if (stage.depends.some((d) => !d.soft && !done.has(d.id))) stage.status = 'blocked';
    return { stage, x: c.x, y: c.y };
  });
}

export async function refreshProposals(): Promise<void> {
  const st = useApp.getState();
  try {
    const proposals = await agentApi.proposals();
    st.set({ proposals });
    editorRef.current?.setGhosts(proposals[0] ? ghostsFor(proposals[0], st.activeBoard, st.stages) : []);
  } catch {
    st.set({ proposals: [] });
  }
}

async function onPlanChanged(ev: PlanChanged): Promise<void> {
  const st = useApp.getState();
  if (!st.project) return;
  // Decide about conflicts before anything below schedules derived saves (card heights etc.).
  const hadLocalEdits = st.save.kind === 'saving';
  // Board first, then stages: otherwise new stage data resizes cards of the stale board and saves it.
  if (st.activeBoard && ev.boards.includes(st.activeBoard)) {
    if (hadLocalEdits) {
      st.set({ boardConflict: true });
    } else {
      await reloadActiveBoard();
    }
  }
  if (ev.stages.length || ev.boards.length) {
    st.setStages(await api.stagesList());
    st.set({ boards: await api.boardsList() });
  }
  if (ev.stages.length) editorRef.current?.highlightStages(ev.stages);
  if (ev.group != null && (ev.stages.length || ev.boards.length)) {
    const prev = useApp.getState().agentChange;
    const same = prev?.group === ev.group;
    const merge = (a: string[], b: string[]) => [...new Set([...a, ...b])];
    useApp.getState().set({ agentChange: {
      group: ev.group,
      stages: same && prev ? merge(prev.stages, ev.stages) : ev.stages,
      boards: same && prev ? merge(prev.boards, ev.boards) : ev.boards,
      at: Date.now(),
    } });
  }
  if (ev.proposals) await refreshProposals();
}

/** Claims or the activity log changed (agents started/finished work): refresh both, no banner. */
export async function refreshAgents(): Promise<void> {
  const st = useApp.getState();
  if (!st.project) return;
  try {
    st.setStages(await api.stagesList());
    st.set({ activity: await api.activity(50), agents: await api.agentsList() });
  } catch {
    // Best effort: the plan itself is unaffected.
  }
}

/** Subscribes once per opened project; returns the unsubscribe function. */
export async function startAgentSync(): Promise<() => void> {
  const un = await listen<PlanChanged>('plan-changed', (e) => {
    onPlanChanged(e.payload).then(() => api.activity(50)).then((activity) => useApp.getState().set({ activity }))
      .catch((err) => useApp.getState().set({ error: errorText(err) }));
  });
  const un2 = await listen('agents-changed', () => { void refreshAgents(); });
  // "Silent agent" depends on the clock, not on files: while someone holds a claim, recheck every minute.
  const tick = window.setInterval(() => {
    if (useApp.getState().stages.some((s) => (s.claims ?? []).length)) void refreshAgents();
  }, 60_000);
  await refreshProposals();
  await refreshAgents();
  return () => { un(); un2(); window.clearInterval(tick); };
}

/** Replaces the canvas board with the file on disk, discarding any derived pending save. */
async function reloadActiveBoard(): Promise<void> {
  const st = useApp.getState();
  if (!st.activeBoard) return;
  st.dropPendingSave();
  const board = await api.boardLoad(st.activeBoard);
  useApp.getState().set({ board });
  editorRef.current?.setBoard(board, { keepCamera: true });
}

export async function undoAgentChange(): Promise<void> {
  const st = useApp.getState();
  const change = st.agentChange;
  if (!change) return;
  st.set({ agentChange: null });
  st.dropPendingSave();
  const stages = await agentApi.undo(change.group);
  if (st.activeBoard && change.boards.includes(st.activeBoard)) await reloadActiveBoard();
  useApp.getState().setStages(stages);
}

/** Board changed outside while local edits were pending: take theirs, or keep ours (save over theirs). */
export async function resolveBoardConflict(take: 'theirs' | 'mine'): Promise<void> {
  const st = useApp.getState();
  st.set({ boardConflict: false });
  if (!st.activeBoard) return;
  if (take === 'mine') {
    await st.flushSave();
    return;
  }
  await reloadActiveBoard();
}

export async function decideProposal(id: string, accept: boolean): Promise<void> {
  const st = useApp.getState();
  await st.flushSave(); // keep the user's pending edits before the proposal rewrites the board
  if (accept) {
    await agentApi.accept(id);
  } else {
    await agentApi.reject(id);
  }
  editorRef.current?.setGhosts([]);
  await reloadActiveBoard();
  st.setStages(await api.stagesList());
  await refreshProposals();
}
