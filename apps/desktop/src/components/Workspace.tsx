import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { IconX, IconMap, IconPlayerPlay, IconLock, IconLayoutBoard, IconListDetails, IconFocus2, IconChartDonut } from '@tabler/icons-react';
import { useApp } from '../store';
import { Sidebar } from './Sidebar';
import { CanvasView } from './CanvasView';
import { Inspector } from './Inspector';
import { ListView } from './ListView';
import { SettingsDialog } from './SettingsDialog';
import { AgentBanner } from './AgentBanner';
import { OverviewView } from './OverviewView';
import { CommandPalette } from './CommandPalette';
import { startAgentSync } from '../agentSync';
import { effectiveKeymap, label, useAppShortcuts, useKeys } from '../keys';
import { openProject } from '../projectActions';
import { errorText } from '../api';

function TabsBar() {
  const { t } = useTranslation();
  const { openBoards, activeBoard, openBoard, closeBoard, exec, set } = useApp();
  const keys = effectiveKeymap(useKeys((s) => s.overrides));
  return (
    <div className="tabs">
      <div className="tab-list" role="tablist">
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
      <div className="tab-actions">
        <button className={`btn sm ${exec ? 'on' : ''}`} aria-pressed={exec} title={`${t('exec.hint')} (${label('app.focus', keys)})`} onClick={() => set({ exec: !exec, view: 'board' })}>
          <IconFocus2 size={14} />{t('exec.on')}
        </button>
      </div>
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
  const { t } = useTranslation();
  const { project, activeBoard, selectedStage, error, view, set } = useApp();

  const handlers = useMemo(() => ({
    'app.focus': () => { const s = useApp.getState(); s.set({ exec: !s.exec, view: 'board' }); },
    'app.toggleView': () => { const s = useApp.getState(); s.set({ view: s.view === 'board' ? 'list' : 'board' }); },
    'app.openFolder': () => { openProject().catch((e) => useApp.getState().set({ error: errorText(e) })); },
    'app.settings': () => useApp.getState().set({ settingsTab: 'general' }),
    'app.palette': () => useApp.getState().set({ paletteOpen: true }),
  }), []);
  useAppShortcuts(handlers);

  const root = project?.root;
  useEffect(() => {
    if (!root) return;
    let stop: (() => void) | undefined;
    let alive = true;
    startAgentSync().then((un) => { if (alive) stop = un; else un(); }).catch(() => undefined);
    return () => { alive = false; stop?.(); };
  }, [root]);

  return (
    <div className="ws">
      <Sidebar />
      <section className="main">
        <TabsBar />
        <div className="crumbs">
          {project?.name} <span className="sep">/</span> <b>{activeBoard ?? ''}</b>
          <div className="views" role="tablist">
            <button role="tab" aria-selected={view === 'board'} className={`btn sm ${view === 'board' ? 'on' : ''}`} onClick={() => set({ view: 'board' })}><IconLayoutBoard size={14} />{t('views.board')}</button>
            <button role="tab" aria-selected={view === 'list'} className={`btn sm ${view === 'list' ? 'on' : ''}`} onClick={() => set({ view: 'list' })}><IconListDetails size={14} />{t('views.list')}</button>
            <button role="tab" aria-selected={view === 'overview'} className={`btn sm ${view === 'overview' ? 'on' : ''}`} onClick={() => set({ view: 'overview' })}><IconChartDonut size={14} />{t('views.overview')}</button>
          </div>
        </div>
        <div className="area">
          {activeBoard ? <CanvasView key={activeBoard} /> : null}
          {view === 'list' && <div className="overlay-page"><ListView /></div>}
          {view === 'overview' && <div className="overlay-page"><OverviewView /></div>}
          <AgentBanner />
          {error && (
            <div className="toast" role="alert" onClick={() => set({ error: null })}>{error}</div>
          )}
        </div>
        <StatusBar />
      </section>
      {selectedStage && <Inspector stageKey={selectedStage} />}
      <SettingsDialog />
      <CommandPalette />
    </div>
  );
}
