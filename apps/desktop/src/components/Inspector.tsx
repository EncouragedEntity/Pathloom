import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ask, open as openFile } from '@tauri-apps/plugin-dialog';
import {
  IconX, IconCheck, IconPlus, IconCalendar, IconFlag, IconUser, IconGitBranch, IconTrash,
  IconFileText, IconListDetails, IconDiamond, IconCornerDownRight, IconCopy, IconExternalLink, IconShieldCheck, IconAlertTriangle,
  IconArrowLeft, IconPaperclip, IconLink, IconChevronRight,
} from '@tabler/icons-react';
import type { StageView, Task } from '@pathloom/canvas';
import { api, errorText, type StageMeta } from '../api';
import i18n from '../i18n';
import { editorRef, useApp } from '../store';
import { StatusIcon, focusStage } from './Sidebar';
import { agentText, ago, claimOf, knownWhos, whoColor, whoText, type LogEntry } from '../agents';
import type { Evidence } from '@pathloom/canvas';
import { findTheme } from '../theme';

/** External session links open only after the user confirms (the URL may start another app). */
async function openSession(url: string): Promise<void> {
  const ok = await ask(i18n.t('sessions.confirm', { url }), { title: i18n.t('sessions.open'), kind: 'info' });
  if (ok) await api.openUrl(url).catch((e) => useApp.getState().set({ error: errorText(e) }));
}

/** Tooltip: "cargo test → 0 · 94 passed · 12 s · claude, 5 min ago". */
function evidenceText(e: Evidence, t: (k: string, o?: Record<string, unknown>) => string, name: (id: string) => string = (x) => x): string {
  const parts = [`${e.command} → ${e.exit_code}`];
  if (e.summary) parts.push(e.summary);
  if (e.duration_ms != null) parts.push(e.duration_ms < 1000 ? `${e.duration_ms} ms` : `${Math.round(e.duration_ms / 100) / 10} s`);
  if (e.by || e.at) parts.push([e.by ? name(e.by) : '', e.at ? ago(e.at, t as never) : ''].filter(Boolean).join(', '));
  return `${t('evidence.verified')}: ${parts.join(' · ')}${e.log ? `\n${e.log}` : ''}`;
}

/** Gate result and "Run check" (the app runs the stage's `check` command in the project folder). */
function GateBox({ stage }: { stage: StageView }) {
  const { t } = useTranslation();
  const { setStages, set, agents } = useApp();
  const [running, setRunning] = useState(false);
  const ev = stage.evidence?.[stage.key];
  const run = async () => {
    if (!stage.check) return;
    const ok = await ask(t('gate.confirm', { cmd: stage.check }), { title: t('gate.run'), kind: 'warning' });
    if (!ok) return;
    setRunning(true);
    try { setStages(await api.gateRun(stage.key)); } catch (e) { set({ error: errorText(e) }); } finally { setRunning(false); }
  };
  return (
    <div className={`gate ${ev ? 'ok' : ''}`}>
      <span className="grow">{ev ? evidenceText(ev, t, (x) => agentText(x, agents)) : stage.check ? t('gate.notRun') : t('gate.noCheck')}</span>
      {stage.check && <button className="btn" disabled={running} onClick={() => void run()}>{running ? t('gate.running') : t('gate.run')}</button>}
    </div>
  );
}

/** Close the panel and drop the card selection too, so clicking the same card opens it again. */
function closeInspector() {
  editorRef.current?.runCommand('edit.cancel');
  useApp.getState().set({ selectedStage: null });
}

const isDone = (t: Task) => (t.sub.length ? t.sub.every((s) => s.done) : t.done);

function useStageCall() {
  const { setStages, set } = useApp();
  return (p: Promise<StageView[]>) => p.then(setStages).catch((e) => set({ error: errorText(e) }));
}

/** Text that turns into an input on click; commits on Enter/blur, Escape cancels. */
function InlineText({ value, onCommit, className }: { value: string; onCommit: (v: string) => void; className?: string }) {
  return (
    <input
      key={value}
      className={`inline-edit ${className ?? ''}`}
      defaultValue={value}
      onBlur={(e) => { const v = e.currentTarget.value.trim(); if (v && v !== value) onCommit(v); else e.currentTarget.value = value; }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') { e.currentTarget.value = value; e.currentTarget.blur(); }
      }}
    />
  );
}

function TaskRow({ task, sub, stage }: { task: Task; sub?: boolean; stage: StageView }) {
  const { t } = useTranslation();
  const call = useStageCall();
  const { theme, customThemes, agents, set } = useApp();
  const claim = claimOf(stage, task.id);
  const claimColor = claim ? whoColor(`ai:${claim.agent}`, findTheme(theme, customThemes).tokens, agents) : null;
  const [adding, setAdding] = useState(false);
  const done = isDone(task);
  const ev = stage.evidence?.[task.id];
  return (
    <>
      <li className={`trow ${done ? 'done' : ''} ${sub ? 'sub' : ''}`}>
        <button className="chk" aria-label={task.id} aria-pressed={done} onClick={() => call(api.taskToggle(task.id))}><IconCheck size={11} /></button>
        <span className="tid">{task.id}</span>
        <button className="tt tt-open" title={t('task.open')} onClick={() => set({ selectedTask: task.id })}>
          {task.title}
          {(stage.taskInfo?.[task.id]?.files?.length ?? 0) > 0 && <IconPaperclip size={11} className="muted tt-clip" />}
        </button>
        {done && ev && (
          <span className="verified" title={evidenceText(ev, t, (x) => agentText(x, agents))} aria-label={t('evidence.verified')}><IconShieldCheck size={13} /></span>
        )}
        {claim && (
          <button className={`claim-chip ${claim.silent ? 'silent' : ''}`} style={claimColor && !claim.silent ? { color: claimColor, borderColor: claimColor } : undefined}
            title={(claim.silent ? t('agentsUi.silentHint', { agent: agentText(claim.agent, agents), ago: ago(claim.heartbeatAt ?? '', t) }) + '\n' : '')
              + (claim.note ? claim.note + '\n' : '') + t('agentsUi.release', { agent: agentText(claim.agent, agents) })}
            onClick={() => call(api.claimRelease(claim.taskId))}>
            {claim.silent && <IconAlertTriangle size={10} />}{agentText(claim.agent, agents)} <IconX size={10} />
          </button>
        )}
        <span className="row-actions">
          {!sub && (
            <button className="icon-btn" title={t('inspector.addSubtask')} aria-label={t('inspector.addSubtask')} onClick={() => setAdding(true)}><IconCornerDownRight size={13} /></button>
          )}
          <button className="icon-btn" title={t('inspector.removeTask')} aria-label={t('inspector.removeTask')} onClick={() => call(api.taskRemove(task.id))}><IconTrash size={13} /></button>
          <button className="icon-btn" title={t('task.open')} aria-label={t('task.open')} onClick={() => set({ selectedTask: task.id })}><IconChevronRight size={13} /></button>
        </span>
      </li>
      {adding && (
        <li className="trow sub">
          <IconPlus size={13} className="muted" />
          <input
            autoFocus
            className="inline-edit"
            placeholder={t('inspector.addSubtask')}
            onBlur={(e) => { const v = e.currentTarget.value.trim(); setAdding(false); if (v) void call(api.subtaskAdd(task.id, v)); }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.currentTarget.value = ''; e.currentTarget.blur(); } }}
          />
        </li>
      )}
    </>
  );
}

function FileTab({ stageKey, version }: { stageKey: string; version: string }) {
  const { t } = useTranslation();
  const [text, setText] = useState<string>('');
  useEffect(() => {
    api.stageSource(stageKey).then(setText).catch((e) => setText(errorText(e)));
  }, [stageKey, version]);
  return (
    <>
      <div className="i-h"><span className="mono">plan/stages/{stageKey}.md</span></div>
      <pre className="code">{text}</pre>
      <p className="hint">{t('inspector.fileHint')}</p>
    </>
  );
}

export function Inspector({ stageKey }: { stageKey: string }) {
  const { t } = useTranslation();
  const { stages, set, setStages, activity, agents, selectedTask, inspWidth } = useApp();
  const call = useStageCall();
  const [otherWho, setOtherWho] = useState(false);
  const [tab, setTab] = useState<'details' | 'file'>('details');
  const [adding, setAdding] = useState('');
  const stage = stages.find((s) => s.key === stageKey);
  if (!stage) return null;
  const blocks = stages.filter((s) => s.depends.some((d) => d.id === stage.key));
  const update = (meta: StageMeta) => call(api.stageUpdate(stage.key, meta));

  function addTask() {
    const title = adding.trim();
    setAdding('');
    if (title && stage) void call(api.taskAdd(stage.key, title));
  }

  async function remove() {
    if (!stage) return;
    const ok = await ask(t('inspector.deleteConfirm', { key: stage.key, title: stage.title }), { title: t('inspector.deleteStage'), kind: 'warning' });
    if (!ok) return;
    try {
      const next = await api.stageDelete(stage.key);
      editorRef.current?.removeStageCards(stage.key);
      setStages(next);
      set({ selectedStage: null });
    } catch (e) {
      set({ error: errorText(e) });
    }
  }

  return (
    <aside className="insp" aria-label={stage.title} style={{ width: inspWidth }}>
      <div className="insp-resize" role="separator" aria-orientation="vertical" aria-label={t('inspector.resize')} title={t('inspector.resize')} onPointerDown={startResize} />
      <div className="i-top">
        <KeyEdit stageKey={stage.key} />
        <div className="i-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'details'} className={tab === 'details' ? 'on' : ''} onClick={() => setTab('details')}><IconListDetails size={14} />{t('inspector.details')}</button>
          <button role="tab" aria-selected={tab === 'file'} className={tab === 'file' ? 'on' : ''} onClick={() => setTab('file')}><IconFileText size={14} />{t('inspector.file')}</button>
        </div>
        <button className="icon-btn push" aria-label={t('inspector.close')} onClick={closeInspector}><IconX size={16} /></button>
      </div>
      <div className="insp-scroll">
        {tab === 'file' ? (
          <FileTab stageKey={stage.key} version={JSON.stringify(stage)} />
        ) : selectedTask && findTask(stage, selectedTask) ? (
          <TaskDetail stage={stage} taskId={selectedTask} />
        ) : (
          <>
            <span className={`pill p-${stage.status}`}><StatusIcon status={stage.status} />{t(`status.${stage.status}`)}</span>
            <InlineText className="i-title" value={stage.title} onCommit={(v) => update({ title: v })} />
            <dl className="meta">
              <dt><IconDiamond size={14} />{t('inspector.kind')}</dt>
              <dd>
                <select value={stage.kind} onChange={(e) => update({ kind: e.target.value as StageView['kind'] })}>
                  <option value="stage">{t('inspector.kinds.stage')}</option>
                  <option value="milestone">{t('inspector.kinds.milestone')}</option>
                  <option value="gate">{t('inspector.kinds.gate')}</option>
                </select>
              </dd>
              {stage.kind === 'gate' && (
                <>
                  <dt><IconShieldCheck size={14} />{t('gate.check')}</dt>
                  <dd>
                    <input
                      key={stage.check ?? ''}
                      className="inline-edit mono"
                      defaultValue={stage.check ?? ''}
                      placeholder="npm test"
                      onBlur={(e) => { const v = e.currentTarget.value.trim(); if (v !== (stage.check ?? '')) update({ check: v }); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                    />
                  </dd>
                </>
              )}
              <dt><IconUser size={14} />{t('inspector.who')}</dt>
              <dd>
                {otherWho ? (
                  <input
                    autoFocus
                    className="inline-edit mono"
                    placeholder="ai:claude · human:olia"
                    onBlur={(e) => { const v = e.currentTarget.value.trim(); setOtherWho(false); if (v) update({ who: v }); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.currentTarget.value = ''; e.currentTarget.blur(); } }}
                  />
                ) : (
                  <select value={stage.who} onChange={(e) => { if (e.target.value === '__other') setOtherWho(true); else update({ who: e.target.value }); }}>
                    {knownWhos(stages, activity, agents).map((w) => <option key={w} value={w}>{whoText(w, t, agents)}</option>)}
                    <option value="__other">{t('agentsUi.other')}</option>
                  </select>
                )}
              </dd>
              <dt><IconFlag size={14} />{t('inspector.priority')}</dt>
              <dd>
                <select value={stage.priority} className={stage.priority === 'high' ? 'warn' : ''} onChange={(e) => update({ priority: e.target.value as StageView['priority'] })}>
                  {(['low', 'med', 'high'] as const).map((p) => <option key={p} value={p}>{t(`inspector.priorities.${p}`)}</option>)}
                </select>
              </dd>
              <dt><IconCalendar size={14} />{t('inspector.due')}</dt>
              <dd><input type="date" value={stage.due ?? ''} onChange={(e) => update({ due: e.target.value })} /></dd>
              <dt><IconGitBranch size={14} />{t('inspector.branch')}</dt>
              <dd>
                <input
                  key={stage.branch ?? ''}
                  className="inline-edit mono"
                  defaultValue={stage.branch ?? ''}
                  placeholder="feat/…"
                  onBlur={(e) => { const v = e.currentTarget.value.trim(); if (v !== (stage.branch ?? '')) update({ branch: v }); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                />
              </dd>
              <dt>{t('inspector.dependsOn')}</dt>
              <dd>{stage.depends.length ? stage.depends.map((d) => <button key={d.id} className="dep" onClick={() => focusStage(d.id)}>{d.id}{d.soft ? ' ~' : ''}</button>) : '—'}</dd>
              <dt>{t('inspector.blocks')}</dt>
              <dd>{blocks.length ? blocks.map((b) => <button key={b.key} className="dep" onClick={() => focusStage(b.key)}>{b.key}</button>) : '—'}</dd>
            </dl>
            {stage.description.trim() && <p className="i-desc">{stage.description.trim()}</p>}
            {stage.kind === 'gate' && <GateBox stage={stage} />}
            {(stage.artifacts ?? []).length > 0 && (
              <>
                <div className="i-h"><span>{t('artifacts.title')}</span></div>
                <ul className="sessions">
                  {(stage.artifacts ?? []).map((a) => (
                    <li key={a}>
                      <IconFileText size={13} className="muted" />
                      <span className="grow mono" title={a}>{a}</span>
                      <button className="icon-btn" title={t('artifacts.open')} aria-label={t('artifacts.open')}
                        onClick={() => void (/^https?:\/\//i.test(a) ? openSession(a) : api.artifactOpen(a).catch((e) => set({ error: errorText(e) })))}>
                        <IconExternalLink size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {(stage.sessions ?? []).length > 0 && (
              <>
                <div className="i-h"><span>{t('sessions.title')}</span></div>
                <ul className="sessions">
                  {[...(stage.sessions ?? [])].reverse().map((s) => (
                    <li key={`${s.client}:${s.id}`}>
                      <span className="who">{agentText(s.client, agents)}</span>
                      <span className="grow" title={s.id}>{s.title || s.id}</span>
                      <button className="icon-btn" title={t('sessions.copy')} aria-label={t('sessions.copy')} onClick={() => void navigator.clipboard.writeText(s.id)}><IconCopy size={13} /></button>
                      {s.url && <button className="icon-btn" title={t('sessions.open')} aria-label={t('sessions.open')} onClick={() => void openSession(s.url as string)}><IconExternalLink size={13} /></button>}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {stage.kind !== 'milestone' && (
              <>
                <div className="i-h"><span>{t('inspector.tasks')}</span><span>{stage.progress[0]} / {stage.progress[1]}</span></div>
                <ul className="i-tasks">
                  {stage.tasks.map((task) => (
                    <TaskGroup key={task.id} task={task} stage={stage} />
                  ))}
                </ul>
                <label className="add">
                  <IconPlus size={14} />
                  <input value={adding} placeholder={t('inspector.addTask')} onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addTask(); }} />
                </label>
              </>
            )}
            <button className="btn danger" onClick={() => void remove()}><IconTrash size={14} />{t('inspector.deleteStage')}</button>
          </>
        )}
      </div>
    </aside>
  );
}

/** Stage key in the panel header: click to change it (file, task ids, links and cards follow). */
function KeyEdit({ stageKey }: { stageKey: string }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const commit = async (raw: string) => {
    setEditing(false);
    const next = raw.trim().toUpperCase();
    if (!next || next === stageKey) return;
    const st = useApp.getState();
    try {
      await st.flushSave();
      const views = await api.stageRenameKey(stageKey, next);
      // Load the board the core just rewrote before the canvas sees the new stages, and drop any save of the
      // old board, or the old card ref would be written back.
      if (st.activeBoard) {
        const board = await api.boardLoad(st.activeBoard);
        st.dropPendingSave();
        st.set({ board });
        editorRef.current?.setBoard(board, { keepCamera: true });
      }
      st.setStages(views);
      st.set({ selectedStage: next, selectedTask: null });
    } catch (e) {
      st.set({ error: errorText(e) });
    }
  };
  if (!editing) {
    return <button className="c-key key-edit" title={t('inspector.renameKey')} onClick={() => setEditing(true)}>{stageKey}</button>;
  }
  return (
    <input
      autoFocus
      className="inline-edit mono key-input"
      defaultValue={stageKey}
      maxLength={8}
      aria-label={t('inspector.renameKey')}
      onBlur={(e) => void commit(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') { e.currentTarget.value = stageKey; e.currentTarget.blur(); }
      }}
    />
  );
}

/** Drag the panel's left edge; width is kept between 320 px and 70% of the window. */
function startResize(e: React.PointerEvent<HTMLDivElement>) {
  e.preventDefault();
  const handle = e.currentTarget;
  handle.setPointerCapture(e.pointerId);
  const startX = e.clientX, startW = useApp.getState().inspWidth;
  const move = (ev: PointerEvent) => {
    const w = Math.min(Math.max(320, startW + (startX - ev.clientX)), Math.max(320, window.innerWidth * 0.7));
    useApp.setState({ inspWidth: w });
  };
  const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up);
}

/** A task or subtask of the stage by id, with its parent for subtasks. */
function findTask(stage: StageView, id: string): { task: Task; parent: Task | null } | null {
  for (const t of stage.tasks) {
    if (t.id === id) return { task: t, parent: null };
    const s = t.sub.find((x) => x.id === id);
    if (s) return { task: s, parent: t };
  }
  return null;
}

/** One task: full title, state, who works on it, proof, subtasks, note, attached files and history. */
function TaskDetail({ stage, taskId }: { stage: StageView; taskId: string }) {
  const { t } = useTranslation();
  const { set, agents } = useApp();
  const call = useStageCall();
  const found = findTask(stage, taskId)!;
  const { task, parent } = found;
  const done = isDone(task);
  const claim = claimOf(stage, task.id);
  const ev = stage.evidence?.[task.id];
  const info = stage.taskInfo?.[task.id] ?? {};
  const [history, setHistory] = useState<LogEntry[]>([]);
  const [link, setLink] = useState('');
  const [addingSub, setAddingSub] = useState('');
  useEffect(() => {
    api.activity(200, stage.key).then((l) => setHistory(l.filter((e) => e.tasks.includes(task.id)))).catch(() => setHistory([]));
  }, [stage.key, task.id, JSON.stringify(stage)]);
  const openFileAt = (f: string) => void (/^https?:\/\//i.test(f) ? openSession(f) : api.artifactOpen(f).catch((e) => set({ error: errorText(e) })));
  const attach = async () => {
    const root = useApp.getState().project?.root;
    const picked = await openFile({ multiple: false, directory: false, defaultPath: root });
    if (typeof picked === 'string') void call(api.taskFileAdd(task.id, picked));
  };
  return (
    <div className="task-detail">
      <button className="back" onClick={() => set({ selectedTask: parent ? parent.id : null })}>
        <IconArrowLeft size={14} />{parent ? `${parent.id} · ${parent.title}` : `${stage.key} · ${stage.title}`}
      </button>
      <div className={`td-head ${done ? 'done' : ''}`}>
        <button className="chk" aria-label={task.id} aria-pressed={done} onClick={() => call(api.taskToggle(task.id))}><IconCheck size={11} /></button>
        <span className="tid">{task.id}</span>
        <span className="muted">{done ? t('task.done') : t('task.open_')}</span>
      </div>
      <textarea
        key={task.title}
        className="td-title"
        defaultValue={task.title}
        rows={Math.min(8, Math.max(2, Math.ceil(task.title.length / 38)))}
        onBlur={(e) => { const v = e.currentTarget.value.replace(/\s+/g, ' ').trim(); if (v && v !== task.title) void call(api.taskRename(task.id, v)); }}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.blur(); } }}
      />
      {claim && (
        <p className={`td-claim ${claim.silent ? 'silent' : ''}`}>
          {claim.silent && <IconAlertTriangle size={13} />}
          {t('task.claimedBy', { agent: agentText(claim.agent, agents), ago: ago(claim.heartbeatAt ?? '', t) })}
          {claim.note && <span className="muted"> · {claim.note}</span>}
          <button className="icon-btn" title={t('agentsUi.release', { agent: agentText(claim.agent, agents) })} onClick={() => call(api.claimRelease(claim.taskId))}><IconX size={12} /></button>
        </p>
      )}
      {done && ev && <div className="gate ok"><IconShieldCheck size={14} /><span className="grow">{evidenceText(ev, t, (x) => agentText(x, agents))}</span></div>}

      {!parent && (
        <>
          <div className="i-h"><span>{t('task.subtasks')}</span><span>{task.sub.filter((s) => s.done).length} / {task.sub.length}</span></div>
          <ul className="i-tasks">{task.sub.map((s) => <TaskRow key={s.id} task={s} sub stage={stage} />)}</ul>
          <label className="add">
            <IconPlus size={14} />
            <input value={addingSub} placeholder={t('inspector.addSubtask')} onChange={(e) => setAddingSub(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && addingSub.trim()) { void call(api.subtaskAdd(task.id, addingSub.trim())); setAddingSub(''); } }} />
          </label>
        </>
      )}

      <div className="i-h"><span>{t('task.note')}</span></div>
      <textarea
        key={`${task.id}:${info.note ?? ''}`}
        className="td-note"
        defaultValue={info.note ?? ''}
        placeholder={t('task.notePlaceholder')}
        rows={4}
        onBlur={(e) => { const v = e.currentTarget.value; if (v.trim() !== (info.note ?? '').trim()) void call(api.taskNoteSet(task.id, v)); }}
      />

      <div className="i-h"><span>{t('task.files')}</span></div>
      <ul className="sessions">
        {(info.files ?? []).map((f) => (
          <li key={f}>
            {/^https?:\/\//i.test(f) ? <IconLink size={13} className="muted" /> : <IconFileText size={13} className="muted" />}
            <button className="grow mono file-link" title={f} onClick={() => openFileAt(f)}>{f}</button>
            <button className="icon-btn" title={t('task.removeFile')} aria-label={t('task.removeFile')} onClick={() => call(api.taskFileRemove(task.id, f))}><IconX size={12} /></button>
          </li>
        ))}
      </ul>
      <div className="td-attach">
        <button className="btn" onClick={() => void attach()}><IconPaperclip size={14} />{t('task.attachFile')}</button>
        <input className="inline-edit" value={link} placeholder="https://…" onChange={(e) => setLink(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && link.trim()) { void call(api.taskFileAdd(task.id, link.trim())); setLink(''); } }} />
      </div>

      <div className="i-h"><span>{t('task.history')}</span></div>
      {history.length === 0 && <p className="muted small">{t('task.noHistory')}</p>}
      <ul className="td-history">
        {history.map((e, i) => (
          <li key={`${e.at}-${i}`}>
            <b>{e.source === 'app' || e.author === 'me' ? t('who.me') : agentText(e.author, agents)}</b> {e.summary}
            <span className="muted"> · {ago(e.at, t)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TaskGroup({ task, stage }: { task: Task; stage: StageView }) {
  return (
    <>
      <TaskRow task={task} stage={stage} />
      {task.sub.map((s) => <TaskRow key={s.id} task={s} sub stage={stage} />)}
    </>
  );
}
