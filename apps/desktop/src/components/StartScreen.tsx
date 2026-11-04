import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { open } from '@tauri-apps/plugin-dialog';
import { IconFolderOpen, IconPlus, IconClock } from '@tabler/icons-react';
import { api, errorText, type RecentProject } from '../api';
import { useApp } from '../store';

function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function StartScreen() {
  const { t } = useTranslation();
  const enterProject = useApp((s) => s.enterProject);
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.recentProjects().then(setRecent).catch(() => setRecent([]));
  }, []);

  async function run(action: () => Promise<void>) {
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(errorText(e));
    }
  }

  const createNew = () =>
    run(async () => {
      const dir = await open({ directory: true, title: t('start.pickFolderNew') });
      if (typeof dir !== 'string') return;
      await enterProject(await api.projectCreate(dir, folderName(dir)));
    });

  const openExisting = (path?: string) =>
    run(async () => {
      const dir = path ?? (await open({ directory: true, title: t('start.pickFolderOpen') }));
      if (typeof dir !== 'string') return;
      await enterProject(await api.projectOpen(dir));
    });

  return (
    <div className="start">
      <div className="start-card">
        <div className="logo big"><span className="mk">◆</span>Pathloom</div>
        <p className="tagline">{t('start.tagline')}</p>
        <div className="start-actions">
          <button className="btn pri lg" onClick={createNew}><IconPlus size={18} />{t('start.newProject')}</button>
          <button className="btn lg" onClick={() => openExisting()}><IconFolderOpen size={18} />{t('start.openFolder')}</button>
        </div>
        {error && <p className="err" role="alert">{error}</p>}
        <div className="sec">{t('start.recent')}</div>
        {recent.length === 0 && <p className="muted">{t('start.noRecent')}</p>}
        <ul className="recent">
          {recent.map((r) => (
            <li key={r.path}>
              <button onClick={() => openExisting(r.path)}>
                <IconClock size={16} />
                <span className="rn">{r.name}</span>
                <span className="rp">{r.path}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
