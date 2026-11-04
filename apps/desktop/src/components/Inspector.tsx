import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ask } from '@tauri-apps/plugin-dialog';
import {
  IconX, IconCheck, IconPlus, IconCalendar, IconFlag, IconUser, IconGitBranch, IconTrash,
  IconFileText, IconListDetails, IconDiamond, IconCornerDownRight,
} from '@tabler/icons-react';
import type { StageView, Task } from '@pathloom/canvas';
import { api, errorText, type StageMeta } from '../api';
import { editorRef, useApp } from '../store';
import { StatusIcon, focusStage } from './Sidebar';

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

function TaskRow({ task, sub }: { task: Task; sub?: boolean }) {
  const { t } = useTranslation();
  const call = useStageCall();
  const [adding, setAdding] = useState(false);
  const done = isDone(task);
  return (
    <>
      <li className={`trow ${done ? 'done' : ''} ${sub ? 'sub' : ''}`}>
        <button className="chk" aria-label={task.id} aria-pressed={done} onClick={() => call(api.taskToggle(task.id))}><IconCheck size={11} /></button>
        <span className="tid">{task.id}</span>
        <InlineText className="tt" value={task.title} onCommit={(v) => call(api.taskRename(task.id, v))} />
        <span className="row-actions">
          {!sub && (
            <button className="icon-btn" title={t('inspector.addSubtask')} aria-label={t('inspector.addSubtask')} onClick={() => setAdding(true)}><IconCornerDownRight size={13} /></button>
          )}
          <button className="icon-btn" title={t('inspector.removeTask')} aria-label={t('inspector.removeTask')} onClick={() => call(api.taskRemove(task.id))}><IconTrash size={13} /></button>
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
  const { stages, set, setStages } = useApp();
  const call = useStageCall();
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
    <aside className="insp" aria-label={stage.title}>
      <div className="i-top">
        <span className="c-key">{stage.key}</span>
        <div className="i-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'details'} className={tab === 'details' ? 'on' : ''} onClick={() => setTab('details')}><IconListDetails size={14} />{t('inspector.details')}</button>
          <button role="tab" aria-selected={tab === 'file'} className={tab === 'file' ? 'on' : ''} onClick={() => setTab('file')}><IconFileText size={14} />{t('inspector.file')}</button>
        </div>
        <button className="icon-btn push" aria-label={t('inspector.close')} onClick={() => set({ selectedStage: null })}><IconX size={16} /></button>
      </div>
      <div className="insp-scroll">
        {tab === 'file' ? (
          <FileTab stageKey={stage.key} version={JSON.stringify(stage)} />
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
                </select>
              </dd>
              <dt><IconUser size={14} />{t('inspector.who')}</dt>
              <dd>
                <select value={stage.who} onChange={(e) => update({ who: e.target.value as StageView['who'] })}>
                  {(['me', 'ai', 'both'] as const).map((w) => <option key={w} value={w}>{t(`who.${w}`)}</option>)}
                </select>
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
            {stage.kind !== 'milestone' && (
              <>
                <div className="i-h"><span>{t('inspector.tasks')}</span><span>{stage.progress[0]} / {stage.progress[1]}</span></div>
                <ul className="i-tasks">
                  {stage.tasks.map((task) => (
                    <TaskGroup key={task.id} task={task} />
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

function TaskGroup({ task }: { task: Task }) {
  return (
    <>
      <TaskRow task={task} />
      {task.sub.map((s) => <TaskRow key={s.id} task={s} sub />)}
    </>
  );
}
