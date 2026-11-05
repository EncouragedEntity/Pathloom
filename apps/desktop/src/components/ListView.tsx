import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconSearch, IconCheck } from '@tabler/icons-react';
import type { StageView, Task } from '@pathloom/canvas';
import { api, errorText } from '../api';
import { useApp } from '../store';
import { StatusIcon, focusStage } from './Sidebar';
import { agentText, claimOf, knownWhos, whoText } from '../agents';
import { claimChipText } from '@pathloom/canvas';

type Filter = 'all' | 'next' | 'blocked' | 'done';
const isDone = (t: Task) => (t.sub.length ? t.sub.every((s) => s.done) : t.done);

/** All tasks of the project as one table; same data as the board (spec §6 "Список"). */
export function ListView() {
  const { t } = useTranslation();
  const { stages, setStages, set, activity, agents } = useApp();
  const [filter, setFilter] = useState<Filter>('all');
  const [who, setWho] = useState<string>('');
  const [query, setQuery] = useState('');

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out: { stage: StageView; task: Task }[] = [];
    const sorted = [...stages].sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
    for (const stage of sorted) {
      for (const task of stage.tasks) {
        const done = isDone(task);
        if (filter === 'next' && (done || !(stage.status === 'ready' || stage.status === 'active'))) continue;
        if (filter === 'blocked' && stage.status !== 'blocked') continue;
        if (filter === 'done' && !done) continue;
        if (who && stage.who !== who) continue;
        if (q && !`${task.id} ${task.title} ${stage.key} ${stage.title}`.toLowerCase().includes(q)) continue;
        out.push({ stage, task });
      }
    }
    return out;
  }, [stages, filter, query, who]);

  const toggle = (id: string) => api.taskToggle(id).then(setStages).catch((e) => set({ error: errorText(e) }));
  const goTo = (key: string) => { set({ view: 'board' }); setTimeout(() => focusStage(key), 0); };

  return (
    <div className="page">
      <div className="list-head">
        <div className="flt wide" role="tablist">
          {(['all', 'next', 'blocked', 'done'] as Filter[]).map((f) => (
            <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>{t(`list.${f}`)}</button>
          ))}
        </div>
        <label className="search narrow">
          <IconSearch size={15} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('sidebar.search')} />
        </label>
        <select className="who-filter" value={who} onChange={(e) => setWho(e.target.value)} aria-label={t('inspector.who')}>
          <option value="">{t('agentsUi.anyone')}</option>
          {knownWhos(stages, activity, agents).map((w) => <option key={w} value={w}>{whoText(w, t, agents)}</option>)}
        </select>
        <span className="muted">{t('list.count', { count: rows.length })}</span>
      </div>
      {rows.length === 0 ? (
        <p className="muted pad">{t('list.empty')}</p>
      ) : (
        <table className="list">
          <thead>
            <tr><th className="c-chk" /><th className="c-id">ID</th><th>{t('list.task')}</th><th className="c-stage">{t('list.stage')}</th><th className="c-who">{t('inspector.who')}</th><th className="c-claim">{t('agentsUi.claimed')}</th><th className="c-st">{t('list.state')}</th></tr>
          </thead>
          <tbody>
            {rows.map(({ stage, task }) => {
              const done = isDone(task);
              return (
                <tr key={task.id} className={done ? 'done' : ''}>
                  <td><button className="chk" aria-label={task.id} aria-pressed={done} onClick={() => void toggle(task.id)}><IconCheck size={11} /></button></td>
                  <td className="tid">{task.id}</td>
                  <td className="tt">{task.title}{task.sub.length > 0 && <span className="subc"> {task.sub.filter((s) => s.done).length}/{task.sub.length}</span>}</td>
                  <td><button className="dep" onClick={() => goTo(stage.key)}>{stage.key}</button> <span className="st-title">{stage.title}</span></td>
                  <td><span className={`who ${stage.who.split(':')[0]}`}>{whoText(stage.who, t, agents)}</span></td>
                  <td className="muted">{(() => { const c = claimOf(stage, task.id); return c ? claimChipText(agentText(c.agent, agents), c.note) : ''; })()}</td>
                  <td><span className={`pill p-${stage.status}`}><StatusIcon status={stage.status} />{t(`status.${stage.status}`)}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
