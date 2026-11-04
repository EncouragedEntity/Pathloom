import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  IconHandStop, IconPointer, IconSquare, IconDiamond, IconCircle, IconArrowUpRight, IconLine,
  IconPencil, IconTypography, IconLayoutCards, IconMinus, IconPlus, IconMaximize,
  IconArrowBackUp, IconArrowForwardUp,
} from '@tabler/icons-react';
import { createEditor, type CanvasHost, type Tool } from '@pathloom/canvas';
import { api, errorText } from '../api';
import { editorRef, useApp } from '../store';
import { THEMES } from '../theme';

const TOOLS: { tool: Tool; key: string; icon: typeof IconSquare }[] = [
  { tool: 'hand', key: 'H', icon: IconHandStop },
  { tool: 'select', key: '1', icon: IconPointer },
  { tool: 'rect', key: '2', icon: IconSquare },
  { tool: 'diamond', key: '3', icon: IconDiamond },
  { tool: 'ellipse', key: '4', icon: IconCircle },
  { tool: 'arrow', key: '5', icon: IconArrowUpRight },
  { tool: 'line', key: 'L', icon: IconLine },
  { tool: 'pencil', key: '6', icon: IconPencil },
  { tool: 'text', key: '7', icon: IconTypography },
  { tool: 'stage', key: 'S', icon: IconLayoutCards },
];

export function CanvasView() {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const tool = useApp((s) => s.tool);
  const zoom = useApp((s) => s.zoom);
  const theme = useApp((s) => s.theme);

  useEffect(() => {
    const el = ref.current;
    const state = useApp.getState();
    if (!el || !state.board) return;
    const store = useApp.getState;

    const host: CanvasHost = {
      onBoardChange: (board) => store().boardChanged(board),
      onSelectionChange: ({ stageKey }) => store().set({ selectedStage: stageKey }),
      onToolChange: (tool) => store().set({ tool }),
      onZoomChange: (zoom) => store().set({ zoom }),
      async createStage(title) {
        const view = await api.stageCreate(title);
        store().setStages(await api.stagesList());
        return view;
      },
      async toggleTask(taskId) {
        try {
          store().setStages(await api.taskToggle(taskId));
        } catch (e) {
          store().set({ error: errorText(e) });
        }
      },
      async linkStages(from, to) {
        try {
          store().setStages(await api.stageLink(from, to));
          return null;
        } catch (e) {
          return errorText(e);
        }
      },
      async unlinkStages(from, to) {
        store().setStages(await api.stageUnlink(from, to));
      },
      openStage: (key) => store().set({ selectedStage: key }),
    };

    const th = THEMES[state.theme];
    const editor = createEditor(el, {
      board: state.board,
      stages: state.stages,
      host,
      theme: th.tokens,
      style: state.board.style ?? th.style,
      labels: {
        newStage: t('canvas.newStage'),
        cycleError: t('canvas.cycleError'),
        missingStage: t('canvas.missingStage'),
        statusDone: t('status.done'),
        statusActive: t('status.active'),
        statusReady: t('status.ready'),
        statusBlocked: t('status.blocked'),
        whoMe: t('who.me'),
        whoAi: t('who.ai'),
        whoBoth: t('who.both'),
        priorityHigh: t('inspector.priorities.high'),
        moreTasks: t('canvas.moreTasks'),
      },
    });
    editorRef.current = editor;
    return () => {
      editor.destroy();
      if (editorRef.current === editor) editorRef.current = null;
    };
    // The editor is created once per board (CanvasView is keyed by board name).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    editorRef.current?.setTheme(THEMES[theme].tokens);
  }, [theme]);

  return (
    <>
      <div ref={ref} className="canvas-host" />
      <div className="toolbar" role="toolbar">
        {TOOLS.map(({ tool: tl, key, icon: Icon }) => (
          <button
            key={tl}
            className={tool === tl ? 'on' : ''}
            title={`${t(`tools.${tl}`)} (${key})`}
            aria-label={t(`tools.${tl}`)}
            onClick={() => editorRef.current?.setTool(tl)}
          >
            <Icon size={18} />
            <sub>{key}</sub>
          </button>
        ))}
      </div>
      <div className="zoom">
        <button aria-label={t('common.zoomOut')} onClick={() => editorRef.current?.zoomTo(zoom / 1.2)}><IconMinus size={15} /></button>
        <span className="zl">{Math.round(zoom * 100)}%</span>
        <button aria-label={t('common.zoomIn')} onClick={() => editorRef.current?.zoomTo(zoom * 1.2)}><IconPlus size={15} /></button>
        <button aria-label={t('common.fit')} title={t('common.fit')} onClick={() => editorRef.current?.zoomToFit()}><IconMaximize size={15} /></button>
        <span className="vsep" />
        <button aria-label={t('common.undo')} title={t('common.undo')} onClick={() => editorRef.current?.undo()}><IconArrowBackUp size={15} /></button>
        <button aria-label={t('common.redo')} title={t('common.redo')} onClick={() => editorRef.current?.redo()}><IconArrowForwardUp size={15} /></button>
      </div>
    </>
  );
}
