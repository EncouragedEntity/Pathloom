import { useTranslation } from 'react-i18next';
import { IconX, IconMap, IconPlayerPlay, IconLock } from '@tabler/icons-react';
import { useApp } from '../store';
import { Sidebar } from './Sidebar';
import { CanvasView } from './CanvasView';
import { Inspector } from './Inspector';

function TabsBar() {
  const { openBoards, activeBoard, openBoard, closeBoard } = useApp();
  return (
    <div className="tabs" role="tablist">
      {openBoards.map((b) => (
        <div key={b} role="tab" aria-selected={b === activeBoard} className={`tab ${b === activeBoard ? 'on' : ''}`} onClick={() => void openBoard(b)}>
          <IconMap size={15} />
          {b}
          <button className="tab-x" aria-label="close" onClick={(e) => { e.stopPropagation(); void closeBoard(b); }}>
            <IconX size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

function StatusBar() {
  const { t } = useTranslation();
  const { stages, save } = useApp();
  const ready = stages
    .filter((s) => s.status === 'ready' || s.status === 'active')
    .reduce((n, s) => n + s.tasks.filter((x) => !(x.sub.length ? x.sub.every((y) => y.done) : x.done)).length, 0);
  const blocked = stages.filter((s) => s.status === 'blocked').length;
  return (
    <div className="status">
      <span><IconPlayerPlay size={13} className="ac" />{t('statusbar.ready', { count: ready })}</span>
      <span><IconLock size={13} />{t('statusbar.blocked', { count: blocked })}</span>
      <span className="grow" />
      <span className={save.kind === 'error' ? 'bad' : ''}>
        {save.kind === 'saved' ? t('statusbar.saved') : save.kind === 'saving' ? t('statusbar.saving') : t('statusbar.saveError', { message: save.message })}
      </span>
    </div>
  );
}

export function Workspace() {
  const { project, activeBoard, selectedStage, error, set } = useApp();
  return (
    <div className="ws">
      <Sidebar />
      <section className="main">
        <TabsBar />
        <div className="crumbs">
          {project?.name} <span className="sep">/</span> <b>{activeBoard ?? ''}</b>
        </div>
        <div className="area">
          {activeBoard ? <CanvasView key={activeBoard} /> : null}
          {error && (
            <div className="toast" role="alert" onClick={() => set({ error: null })}>{error}</div>
          )}
        </div>
        <StatusBar />
      </section>
      {selectedStage && <Inspector stageKey={selectedStage} />}
    </div>
  );
}
