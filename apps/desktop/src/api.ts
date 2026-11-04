// Typed wrappers over Tauri commands (docs/m1-contracts.md §3).
import { invoke } from '@tauri-apps/api/core';
import type { Board, StageView } from '@pathloom/canvas';

export interface ProjectSnapshot {
  root: string;
  name: string;
  boards: string[];
  stages: StageView[];
}

/** Partial stage update; omitted fields stay unchanged, '' clears due/branch. */
export interface StageMeta {
  title?: string;
  kind?: StageView['kind'];
  who?: StageView['who'];
  priority?: StageView['priority'];
  due?: string;
  branch?: string;
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
  stageUpdate: (key: string, meta: StageMeta) => invoke<StageView[]>('stage_update', { key, meta }),
  stageSource: (key: string) => invoke<string>('stage_source', { key }),
  stageDelete: (key: string) => invoke<StageView[]>('stage_delete', { key }),
  taskRename: (taskId: string, title: string) => invoke<StageView[]>('task_rename', { taskId, title }),
  taskRemove: (taskId: string) => invoke<StageView[]>('task_remove', { taskId }),
  subtaskAdd: (taskId: string, title: string) => invoke<StageView[]>('subtask_add', { taskId, title }),
  stageRename:(key: string, title: string) => invoke<StageView[]>('stage_rename', { key, title }),
  stageLink:(from: string, to: string) => invoke<StageView[]>('stage_link', { from, to }),
  stageUnlink: (from: string, to: string) => invoke<StageView[]>('stage_unlink', { from, to }),
};

export function errorText(e: unknown): string {
  return typeof e === 'string' ? e : e instanceof Error ? e.message : String(e);
}
