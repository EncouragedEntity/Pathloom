import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { IconLock, IconCalendar, IconSparkles, IconUser, IconDiamond } from '@tabler/icons-react';
import type { CardElement, FrameElement, StageView, Task } from '@pathloom/canvas';
import { useApp } from '../store';
import { focusStage } from './Sidebar';
import { ago, agentText, claimOf, whoText } from '../agents';

const isDone = (t: Task) => (t.sub.length ? t.sub.every((s) => s.done) : t.done);
const PRIO = { high: 0, med: 1, low: 2 } as const;

/** Calm project overview (spec §6): progress, phases, what's next, blockers, deadlines, recent notes. */
export function OverviewView() {
  const { t } = useTranslation();
  const { stages, board, project, set, activity, agents } = useApp();
  const go = (key: string) => { set({ view: 'board' }); setTimeout(() => focusStage(key), 0); };

  const data = useMemo(() => {
    const byKey = new Map(stages.map((s) => [s.key, s]));
    const all = stages.flatMap((s) => s.tasks);
    const done = all.filter(isDone).length;
    const next = stages
      .filter((s) => s.status === 'ready' || s.status === 'active')
      .flatMap((s) => s.tasks.filter((x) => !isDone(x)).map((task) => ({ s, task })))
      .sort((a, b) => PRIO[a.s.priority] - PRIO[b.s.priority] || (a.s.due ?? '9999').localeCompare(b.s.due ?? '9999'))
      .slice(0, 8);
    const blocked = stages.filter((s) => s.status === 'blocked').map((s) => ({
      s, waiting: s.depends.filter((d) => !d.soft && byKey.get(d.id)?.status !== 'done').map((d) => d.id),
    }));
    const deadlines = stages.filter((s) => s.due && s.status !== 'done').sort((a, b) => (a.due ?? '').localeCompare(b.due ?? '')).slice(0, 6);
    const notes = stages
      .flatMap((s) => s.comments.map((c) => ({ s, c })))
      .sort((a, b) => b.c.at.localeCompare(a.c.at))
      .slice(0, 6);
    // Phases = frames on the active board; members are cards whose `frame` points at the frame.
    const frames = (board?.elements.filter((e): e is FrameElement => e.type === 'frame') ?? []).map((f) => {
      const members = (board?.elements.filter((e): e is CardElement => e.type === 'card' && e.frame === f.id) ?? [])
        .map((c) => byKey.get(c.ref)).filter((x): x is StageView => !!x);
      const tasks = members.flatMap((m) => m.tasks);
      return { name: f.name, done: tasks.filter(isDone).length, total: tasks.length };
    });
    return { done, total: all.length, next, blocked, deadlines, notes, frames };
  }, [stages, board]);

  const pct = data.total ? Math.round((data.done / data.total) * 100) : 0;
  const doneStages = stages.filter((s) => s.status === 'done').length;

  return (
    <div className="page overview">
      <h1>{project?.name}</h1>
      <p className="muted">{t('overview.subtitle')}</p>
      <div className="ov-grid">
        <section className="box">
          <h3>{t('overview.progress')}</h3>
          <div className="big">{pct}%</div>
          <p className="muted">{t('overview.counts', { done: data.done, total: data.total, sdone: doneStages, stotal: stages.length })}</p>
          {data.frames.map((f) => (
            <div key={f.name} className="ph">
              <div><span>{f.name}</span><span>{f.done}/{f.total}</span></div>
              <div className="bar"><i style={{ width: `${f.total ? (f.done / f.total) * 100 : 0}%` }} /></div>
            </div>
          ))}
        </section>
        <section className="box">
          <h3>{t('overview.next')}</h3>
          {data.next.length === 0 && <p className="muted">{t('overview.nothingNext')}</p>}
          {data.next.map(({ s, task }) => (
            <button key={task.id} className="ov-row" onClick={() => go(s.key)}>
              <span className="tid">{task.id}</span><span className="grow">{task.title}</span>
              {(() => {
                const c = claimOf(s, task.id);
                return c
                  ? <span className="who taken" title={t('agentsUi.claimed')}>{agentText(c.agent, agents)}</span>
                  : <span className={`who ${s.who.split(':')[0]}`}>{whoText(s.who, t, agents)}</span>;
              })()}
            </button>
          ))}
        </section>
        <section className="box">
          <h3>{t('overview.blocked')}</h3>
          {data.blocked.length === 0 && <p className="muted">{t('overview.noneBlocked')}</p>}
          {data.blocked.slice(0, 8).map(({ s, waiting }) => (
            <button key={s.key} className="ov-row" onClick={() => go(s.key)}>
              <IconLock size={14} className="muted" /><span className="grow">{s.key} · {s.title}</span>
              <span className="muted">{t('overview.waits', { keys: waiting.join(', ') })}</span>
            </button>
          ))}
        </section>
        <section className="box">
          <h3>{t('overview.deadlines')}</h3>
          {data.deadlines.length === 0 && <p className="muted">{t('overview.noDeadlines')}</p>}
          {data.deadlines.map((s) => (
            <button key={s.key} className="ov-row" onClick={() => go(s.key)}>
              {s.kind === 'milestone' ? <IconDiamond size={14} className="muted" /> : <IconCalendar size={14} className="muted" />}
              <span className="grow">{s.title}</span><span className="muted">{s.due}</span>
            </button>
          ))}
        </section>
        <section className="box">
          <h3>{t('agentsUi.workingNow')}</h3>
          {stages.every((s) => !(s.claims ?? []).length) && <p className="muted">{t('agentsUi.nobody')}</p>}
          {stages.flatMap((s) => (s.claims ?? []).map((c) => ({ s, c }))).map(({ s, c }) => (
            <button key={c.taskId} className="ov-row" onClick={() => go(s.key)}>
              <IconSparkles size={14} className="ac" /><span className="grow">{c.taskId} · {s.tasks.find((x) => x.id === c.taskId)?.title ?? s.title}</span>
              <span className="muted">{agentText(c.agent, agents)}</span>
            </button>
          ))}
        </section>
        <section className="box">
          <h3>{t('agentsUi.activity')}</h3>
          {activity.length === 0 && <p className="muted">{t('agentsUi.noActivity')}</p>}
          {activity.slice(0, 15).map((e, i) => (
            <button key={`${e.at}-${i}`} className="ov-row" onClick={() => e.stages[0] && go(e.stages[0])}>
              {e.source === 'app' ? <IconUser size={14} className="muted" /> : <IconSparkles size={14} className="ac" />}
              <span className="grow"><b className="act-who">{e.source === 'app' || e.author === 'me' ? t('who.me') : agentText(e.author, agents)}</b> {e.summary}</span>
              <span className="muted">{ago(e.at, t)}</span>
            </button>
          ))}
        </section>
        <section className="box">
          <h3>{t('overview.notes')}</h3>
          {data.notes.length === 0 && <p className="muted">{t('overview.noNotes')}</p>}
          {data.notes.map(({ s, c }, i) => (
            <button key={`${s.key}-${i}`} className="ov-row" onClick={() => go(s.key)}>
              {c.author.startsWith('agent') ? <IconSparkles size={14} className="ac" /> : <IconUser size={14} className="muted" />}
              <span className="grow">{c.text}</span><span className="muted">{s.key}</span>
            </button>
          ))}
        </section>
      </div>
    </div>
  );
}
