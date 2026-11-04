// Shared "new / open / reopen project" actions for the start screen, the project menu and startup.
import { open } from '@tauri-apps/plugin-dialog';
import i18n from './i18n';
import { api } from './api';
import { useApp } from './store';

const REOPEN_KEY = 'pathloom.reopenLast';

function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export async function createProject(): Promise<void> {
  const dir = await open({ directory: true, title: i18n.t('start.pickFolderNew') });
  if (typeof dir !== 'string') return;
  await useApp.getState().enterProject(await api.projectCreate(dir, folderName(dir)));
}

export async function openProject(path?: string): Promise<void> {
  const dir = path ?? (await open({ directory: true, title: i18n.t('start.pickFolderOpen') }));
  if (typeof dir !== 'string') return;
  await useApp.getState().enterProject(await api.projectOpen(dir));
}

export function reopenLastEnabled(): boolean {
  try {
    return localStorage.getItem(REOPEN_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function setReopenLast(on: boolean): void {
  try {
    localStorage.setItem(REOPEN_KEY, String(on));
  } catch {
    // Preference only; ignore storage failures.
  }
}

/** On app start: reopen the most recent project, like VS Code. Falls back to the start screen. */
export async function reopenLastProject(): Promise<void> {
  if (!reopenLastEnabled()) return;
  const [last] = await api.recentProjects().catch(() => []);
  if (!last) return;
  try {
    await openProject(last.path);
  } catch {
    // Folder moved or deleted: stay on the start screen, where the recent list shows it.
  }
}
