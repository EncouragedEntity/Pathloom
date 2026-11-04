import { useTranslation } from 'react-i18next';
import { Command } from 'cmdk';
import type { CanvasCommand } from '@pathloom/canvas';
import { editorRef, useApp } from '../store';
import { focusStage } from './Sidebar';
import { openProject } from '../projectActions';
import { setLanguage } from '../i18n';
import { nextTheme } from '../theme';
import { COMMAND_GROUPS, effectiveKeymap, label, useKeys } from '../keys';
import { errorText } from '../api';

/** Ctrl+K: search stages, tasks and boards, and run any command. */
export function CommandPalette() {
  const { t, i18n } = useTranslation();
  const { paletteOpen, stages, boards, theme, customThemes, set, openBoard } = useApp();
  const keys = effectiveKeymap(useKeys((s) => s.overrides));
  if (!paletteOpen) return null;

  const close = () => set({ paletteOpen: false });
  const run = (fn: () => void) => () => { close(); fn(); };
  const canvasCommands = COMMAND_GROUPS.flatMap((g) => g.commands).filter((c) => !c.startsWith('app.')) as CanvasCommand[];

  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <Command className="palette" label={t('palette.title')} onKeyDown={(e) => { if (e.key === 'Escape') close(); }}>
        <Command.Input autoFocus placeholder={t('palette.placeholder')} />
        <Command.List>
          <Command.Empty>{t('palette.empty')}</Command.Empty>
          <Command.Group heading={t('palette.stages')}>
            {stages.map((s) => (
              <Command.Item key={s.key} value={`${s.key} ${s.title}`} onSelect={run(() => { set({ view: 'board' }); setTimeout(() => focusStage(s.key), 0); })}>
                <span className="tid">{s.key}</span>{s.title}<span className="pal-meta">{t(`status.${s.status}`)}</span>
              </Command.Item>
            ))}
          </Command.Group>
          <Command.Group heading={t('palette.tasks')}>
            {stages.flatMap((s) => s.tasks.map((task) => (
              <Command.Item key={task.id} value={`${task.id} ${task.title} ${s.title}`} onSelect={run(() => { set({ view: 'board' }); setTimeout(() => focusStage(s.key), 0); })}>
                <span className="tid">{task.id}</span>{task.title}<span className="pal-meta">{s.key}</span>
              </Command.Item>
            )))}
          </Command.Group>
          <Command.Group heading={t('palette.boards')}>
            {boards.map((b) => (
              <Command.Item key={b} value={`board ${b}`} onSelect={run(() => { set({ view: 'board' }); void openBoard(b); })}>{b}</Command.Item>
            ))}
          </Command.Group>
          <Command.Group heading={t('palette.actions')}>
            <Command.Item value="view board" onSelect={run(() => set({ view: 'board' }))}>{t('views.board')}</Command.Item>
            <Command.Item value="view list" onSelect={run(() => set({ view: 'list' }))}>{t('views.list')}</Command.Item>
            <Command.Item value="view overview" onSelect={run(() => set({ view: 'overview' }))}>{t('views.overview')}</Command.Item>
            <Command.Item value="focus" onSelect={run(() => { const s = useApp.getState(); s.set({ exec: !s.exec, view: 'board' }); })}>{t('commands.app.focus')}<span className="pal-meta">{label('app.focus', keys)}</span></Command.Item>
            <Command.Item value="open folder" onSelect={run(() => { openProject().catch((e) => set({ error: errorText(e) })); })}>{t('commands.app.openFolder')}</Command.Item>
            <Command.Item value="settings" onSelect={run(() => set({ settingsTab: 'general' }))}>{t('commands.app.settings')}</Command.Item>
            <Command.Item value="shortcuts keyboard" onSelect={run(() => set({ settingsTab: 'keys' }))}>{t('settings.shortcuts')}</Command.Item>
            <Command.Item value="theme" onSelect={run(() => set({ theme: nextTheme(theme, customThemes) }))}>{t('palette.nextTheme')}</Command.Item>
            <Command.Item value="language" onSelect={run(() => setLanguage(i18n.language === 'uk' ? 'en' : 'uk'))}>{t('sidebar.language')}</Command.Item>
            {canvasCommands.map((c) => (
              <Command.Item key={c} value={`${c} ${t(`commands.${c}`)}`} onSelect={run(() => editorRef.current?.runCommand(c))}>
                {t(`commands.${c}`)}<span className="pal-meta">{label(c, keys)}</span>
              </Command.Item>
            ))}
          </Command.Group>
        </Command.List>
      </Command>
    </div>
  );
}
