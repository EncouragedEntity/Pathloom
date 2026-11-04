import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconX, IconCheck, IconPlus, IconCalendar, IconFlag, IconUser, IconGitBranch } from '@tabler/icons-react';
import type { Task } from '@pathloom/canvas';
import { api, errorText } from '../api';
import { useApp } from '../store';
import { StatusIcon, focusStage } from './Sidebar';

const isDone = (t: Task) => (t.sub.length ? t.sub.every((s) => s.done) : t.done);

function TaskRow({ task, sub }: { task: Task; sub?: boolean }) {
  const { setStages, set } = useApp();
  const done = isDone(task);
  const toggle = () => api.taskToggle(task.id).then(setStages).catch((e) => set({ error: errorText(e) }));
  return (
    <li className={`${done ? 'done' : ''} ${sub ? 'sub' : ''}`}>
      <button className="chk" aria-label={task.id} aria-pressed={done} onClick={toggle}><IconCheck size={11} /></button>
      <span className="tid">{task.id}</span>
      <span className="tt">{task.title}</span>
    </li>
  );
}

export function Inspector({ stageKey }: { stageKey: string }) {
  const { t } = useTranslation();
  const { stages, setStages, set } = useApp();
  const [adding, setAdding] = useState('');
  const stage = stages.find((s) => s.key === stageKey);
  if (!stage) return null;
  const blocks = stages.filter((s) => s.depends.some((d) => d.id === stage.key));

  function rename(value: string) {
    const title = value.trim();
    if (stage && title && title !== stage.title) api.stageRename(stage.key, title).then(setStages).catch((e) => set({ error: errorText(e) }));
  }

  function addTask() {
    const title = adding.trim();
    setAdding('');
    if (title && stage) api.taskAdd(stage.key, title).then(setStages).catch((e) => set({ error: errorText(e) }));
  }

  return (
    <aside className="insp" aria-label={stage.title}>
      <div className="i-top">
        <span className="c-key">{stage.key}</span>
        <span className={`pill p-${stage.status}`}><StatusIcon status={stage.status} />{t(`status.${stage.status}`)}</span>
        <button className="icon-btn push" aria-label={t('inspector.close')} onClick={() => set({ selectedStage: null })}><IconX size={16} /></button>
      </div>
      <div className="insp-scroll">
        <input
          key={`${stage.key}:${stage.title}`}
          className="i-title"
          defaultValue={stage.title}
          aria-label="title"
          onBlur={(e) => rename(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') { e.currentTarget.value = stage.title; e.currentTarget.blur(); }
          }}
        />
        <dl className="meta">
          <dt><IconUser size={14} />{t('inspector.who')}</dt><dd><span className={`who ${stage.who}`}>{t(`who.${stage.who}`)}</span></dd>
          <dt><IconCalendar size={14} />{t('inspector.due')}</dt><dd>{stage.due ?? '—'}</dd>
          <dt><IconFlag size={14} />{t('inspector.priority')}</dt><dd className={stage.priority === 'high' ? 'warn' : ''}>{t(`inspector.priorities.${stage.priority}`)}</dd>
          {stage.branch && (<><dt><IconGitBranch size={14} />{t('inspector.branch')}</dt><dd className="mono">{stage.branch}</dd></>)}
          <dt>{t('inspector.dependsOn')}</dt>
          <dd>{stage.depends.length ? stage.depends.map((d) => <button key={d.id} className="dep" onClick={() => focusStage(d.id)}>{d.id}{d.soft ? ' ~' : ''}</button>) : '—'}</dd>
          <dt>{t('inspector.blocks')}</dt>
          <dd>{blocks.length ? blocks.map((b) => <button key={b.key} className="dep" onClick={() => focusStage(b.key)}>{b.key}</button>) : '—'}</dd>
        </dl>
        {stage.description.trim() && <p className="i-desc">{stage.description.trim()}</p>}
        <div className="i-h"><span>{t('inspector.tasks')}</span><span>{stage.progress[0]} / {stage.progress[1]}</span></div>
        <ul className="i-tasks">
          {stage.tasks.map((task) => (
            <li key={task.id} className="group">
              <ul>
                <TaskRow task={task} />
                {task.sub.map((s) => <TaskRow key={s.id} task={s} sub />)}
              </ul>
            </li>
          ))}
        </ul>
        <label className="add">
          <IconPlus size={14} />
          <input
            value={adding}
            placeholder={t('inspector.addTask')}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addTask(); }}
          />
        </label>
      </div>
    </aside>
  );
}
