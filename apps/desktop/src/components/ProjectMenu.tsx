import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  IconChevronDown, IconPlus, IconFolderOpen, IconClock, IconX, IconLanguage, IconPalette, IconCheck,
} from '@tabler/icons-react';
import { api, errorText, type RecentProject } from '../api';
import { useApp } from '../store';
import { setLanguage } from '../i18n';
import { createProject, openProject, reopenLastEnabled, setReopenLast } from '../projectActions';
import type { ThemeId } from '../theme';

const THEME_NAMES: Record<ThemeId, string> = { graphite: 'Graphite', paper: 'Warm paper' };

/** Project switcher + quick settings, opened from the project name in the sidebar (Ctrl+O opens a folder). */
export function ProjectMenu() {
  const { t, i18n } = useTranslation();
  const { project, theme, closeProject, set } = useApp();
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const [reopen, setReopen] = useState(reopenLastEnabled());
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) api.recentProjects().then(setRecent).catch(() => setRecent([]));
  }, [open]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); void run(() => openProject()); }
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); window.removeEventListener('keydown', onKey); };
  }, []);

  async function run(action: () => Promise<void>) {
    setOpen(false);
    try {
      await action();
    } catch (e) {
      set({ error: errorText(e) });
    }
  }

  const others = recent.filter((r) => r.path !== project?.root).slice(0, 6);

  return (
    <div className="pmenu" ref={ref}>
      <button className="pm-trigger" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} title={project?.root}>
        <span className="mk">◆</span>
        <span className="pname">{project?.name}</span>
        <IconChevronDown size={14} />
      </button>
      {open && (
        <div className="pm-pop" role="menu">
          <button role="menuitem" onClick={() => run(createProject)}><IconPlus size={15} />{t('menu.newProject')}</button>
          <button role="menuitem" onClick={() => run(() => openProject())}><IconFolderOpen size={15} />{t('menu.openFolder')}<kbd>Ctrl O</kbd></button>
          {others.length > 0 && <div className="pm-sec">{t('start.recent')}</div>}
          {others.map((r) => (
            <button key={r.path} role="menuitem" title={r.path} onClick={() => run(() => openProject(r.path))}>
              <IconClock size={15} /><span className="pm-name">{r.name}</span>
            </button>
          ))}
          <div className="pm-sep" />
          <div className="pm-sec">{t('menu.settings')}</div>
          <button role="menuitemcheckbox" aria-checked={reopen} onClick={() => { setReopenLast(!reopen); setReopen(!reopen); }}>
            <span className="pm-check">{reopen && <IconCheck size={13} />}</span>{t('menu.reopenLast')}
          </button>
          <button role="menuitem" onClick={() => setLanguage(i18n.language === 'uk' ? 'en' : 'uk')}>
            <IconLanguage size={15} />{t('sidebar.language')}<span className="pm-val">{i18n.language === 'uk' ? 'Українська' : 'English'}</span>
          </button>
          <button role="menuitem" onClick={() => set({ theme: theme === 'graphite' ? 'paper' : 'graphite' })}>
            <IconPalette size={15} />{t('sidebar.theme')}<span className="pm-val">{THEME_NAMES[theme]}</span>
          </button>
          <div className="pm-sep" />
          <button role="menuitem" onClick={() => run(closeProject)}><IconX size={15} />{t('menu.closeProject')}</button>
        </div>
      )}
    </div>
  );
}
