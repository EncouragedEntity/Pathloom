// Typed wrappers over Tauri commands (docs/m1-contracts.md §3).
import { invoke } from '@tauri-apps/api/core';
import type { Board, StageView } from '@pathloom/canvas';

export interface ProjectSnapshot {
  root: string;
  name: string;
  boards: string[];
  stages: StageView[];
}

export interface RecentProject {
  path: string;
  name: string;
  openedAt: number;
}

export const api = {
  projectCreate: (path: string, name: string) => invoke<ProjectSnapshot>('project_create', { path, name }),
  projectOpen: (path: string) => invoke<ProjectSnapshot>('project_open', { path }),
  recentProjects: () => invoke<RecentProject[]>('recent_projects'),
  boardLoad: (name: string) => invoke<Board>('board_load', { name }),
  boardSave: (name: string, board: Board) => invoke<void>('board_save', { name, board }),
  boardCreate: (name: string, title: string) => invoke<Board>('board_create', { name, title }),
  boardsList: () => invoke<string[]>('boards_list'),
  stagesList: () => invoke<StageView[]>('stages_list'),
  stageCreate: (title: string) => invoke<StageView>('stage_create', { title }),
  taskToggle: (taskId: string) => invoke<StageView[]>('task_toggle', { taskId }),
  taskAdd: (key: string, title: string) => invoke<StageView[]>('task_add', { key, title }),
  stageRename: (key: string, title: string) => invoke<StageView[]>('stage_rename', { key, title }),
  stageLink:(from: string, to: string) => invoke<StageView[]>('stage_link', { from, to }),
  stageUnlink: (from: string, to: string) => invoke<StageView[]>('stage_unlink', { from, to }),
};

export function errorText(e: unknown): string {
  return typeof e === 'string' ? e : e instanceof Error ? e.message : String(e);
}
