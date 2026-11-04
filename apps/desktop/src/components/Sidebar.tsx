import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  IconSearch, IconMap, IconPlus, IconCircleCheck, IconProgress, IconPlayerPlay, IconLock,
  IconDiamond, IconFlag,
} from '@tabler/icons-react';
import type { CardElement, StageStatus } from '@pathloom/canvas';
import { editorRef, useApp } from '../store';
import { ProjectMenu } from './ProjectMenu';

type Filter = 'all' | 'active' | 'done';

export function StatusIcon({ status, milestone }: { status: StageStatus; milestone?: boolean }) {
  const cls = `sicon ${status}`;
  if (milestone) return <IconDiamond size={15} className={cls} />;
  switch (status) {
    case 'done': return <IconCircleCheck size={15} className={cls} />;
    case 'active': return <IconProgress size={15} className={cls} />;
    case 'ready': return <IconPlayerPlay size={15} className={cls} />;
    default: return <IconLock size={15} className={cls} />;
  }
}

export function focusStage(key: string): void {
  const board = useApp.getState().board;
  const card = board?.elements.find((e): e is CardElement => e.type === 'card' && e.ref === key);
  if (card) editorRef.current?.focusElement(card.id);
  useApp.getState().set({ selectedStage: key });
}

export function Sidebar() {
  const { t } = useTranslation();
  const { boards, activeBoard, board, stages, selectedStage, openBoard, createBoard } = useApp();
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [naming, setNaming] = useState(false);
  const [newName, setNewName] = useState('');

  const onBoard = useMemo(() => {
    const keys = new Set(board?.elements.filter((e): e is CardElement => e.type === 'card').map((e) => e.ref));
    return stages.filter((s) => keys.has(s.key)).sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
  }, [board, stages]);

  const q = query.trim().toLowerCase();
  const list = onBoard.filter((s) => {
    if (filter === 'active' && s.status === 'done') return false;
    if (filter === 'done' && s.status !== 'done') return false;
    if (!q) return true;
    return s.key.toLowerCase().includes(q) || s.title.toLowerCase().includes(q) || s.tasks.some((x) => x.title.toLowerCase().includes(q) || x.id.toLowerCase().includes(q));
  });

  function submitBoard() {
    const name = newName.trim().replace(/[^\p{L}\p{N}_\- /]/gu, '').replace(/\s+/g, '-').toLowerCase();
    setNaming(false);
    setNewName('');
    if (name) void createBoard(name);
  }

  return (
    <aside className="sb">
      <div className="sb-top">
        <ProjectMenu />
        <label className="search">
          <IconSearch size={15} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('sidebar.search')} />
        </label>
      </div>

      <div className="sec">
        {t('sidebar.boards')}
        <button className="icon-btn" aria-label={t('sidebar.newBoard')} onClick={() => setNaming(true)}><IconPlus size={14} /></button>
      </div>
      <div className="tree">
        {boards.map((b) => (
          <button key={b} className={`row ${b === activeBoard ? 'on' : ''}`} onClick={() => void openBoard(b)}>
            <IconMap size={15} />{b}
          </button>
        ))}
        {naming && (
          <input
            className="inline-input"
            autoFocus
            placeholder={t('sidebar.boardName')}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onBlur={submitBoard}
            onKeyDown={(e) => { if (e.key === 'Enter') submitBoard(); if (e.key === 'Escape') { setNaming(false); setNewName(''); } }}
          />
        )}
      </div>

      <div className="sec">{t('sidebar.stages')}</div>
      <div className="flt" role="tablist">
        {(['all', 'active', 'done'] as Filter[]).map((f) => (
          <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>{t(`sidebar.${f}`)}</button>
        ))}
      </div>
      <div className="outline">
        {list.length === 0 && <p className="muted pad">{t('sidebar.noStages')}</p>}
        {list.map((s) => (
          <button key={s.key} className={`ol ${s.key === selectedStage ? 'on' : ''}`} onClick={() => focusStage(s.key)}>
            <StatusIcon status={s.status} milestone={s.kind === 'milestone'} />
            <span className="k">{s.key}</span>
            <span className="n">{s.title}</span>
            {s.priority === 'high' && s.status !== 'done' && <IconFlag size={12} className="warn" />}
            {s.kind !== 'milestone' && <span className="c">{s.progress[0]}/{s.progress[1]}</span>}
          </button>
        ))}
      </div>

    </aside>
  );
}
