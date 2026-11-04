import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  IconHandStop, IconPointer, IconSquare, IconDiamond, IconCircle, IconArrowUpRight, IconLine,
  IconPencil, IconTypography, IconLayoutCards, IconMinus, IconPlus, IconMaximize,
  IconArrowBackUp, IconArrowForwardUp, IconFrame, IconNote, IconPhoto, IconEraser, IconGridDots, IconMap2,
} from '@tabler/icons-react';
import { createEditor, type CanvasHost, type Tool } from '@pathloom/canvas';
import { api, assetUrl, errorText } from '../api';
import { editorRef, useApp } from '../store';
import { THEMES } from '../theme';
import { canvasPart, effectiveKeymap, label, useKeys } from '../keys';

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
  { tool: 'sticky', key: '9', icon: IconNote },
  { tool: 'image', key: '8', icon: IconPhoto },
  { tool: 'eraser', key: '0', icon: IconEraser },
  { tool: 'frame', key: 'F', icon: IconFrame },
  { tool: 'stage', key: 'S', icon: IconLayoutCards },
];

export function CanvasView() {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const tool = useApp((s) => s.tool);
  const zoom = useApp((s) => s.zoom);
  const theme = useApp((s) => s.theme);
  const exec = useApp((s) => s.exec);
  const renderStyle = useApp((s) => s.renderStyle);
  const snap = useApp((s) => s.snap);
  const minimap = useApp((s) => s.minimap);
  const style = renderStyle === 'theme' ? THEMES[theme].style : renderStyle;
  const keys = effectiveKeymap(useKeys((s) => s.overrides));

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
      saveAsset: async (file, name) => api.assetSave(name, Array.from(new Uint8Array(await file.arrayBuffer()))),
    };

    const th = THEMES[state.theme];
    const editor = createEditor(el, {
      board: state.board,
      stages: state.stages,
      host,
      theme: th.tokens,
      style: state.renderStyle === 'theme' ? th.style : state.renderStyle,
      keymap: canvasPart(effectiveKeymap(useKeys.getState().overrides)),
      assetUrl,
      snap: state.snap,
      minimap: state.minimap,
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
        frameDefaultName: t('canvas.frameDefaultName'),
        frameProgress: t('canvas.frameProgress'),
        ctxConvertToStage: t('canvas.ctxConvertToStage'),
        ctxDuplicate: t('canvas.ctxDuplicate'),
        ctxDelete: t('canvas.ctxDelete'),
        ctxBringToFront: t('canvas.ctxBringToFront'),
        ctxSendToBack: t('canvas.ctxSendToBack'),
        ctxLock: t('canvas.ctxLock'),
        ctxUnlock: t('canvas.ctxUnlock'),
        ctxOpenStage: t('canvas.ctxOpenStage'),
        ctxRename: t('canvas.ctxRename'),
        ctxGroup: t('commands.edit.group'),
        ctxUngroup: t('commands.edit.ungroup'),
        ctxAlignLeft: t('commands.align.left'),
        ctxAlignCenter: t('commands.align.center'),
        ctxAlignRight: t('commands.align.right'),
        ctxAlignTop: t('commands.align.top'),
        ctxAlignMiddle: t('commands.align.middle'),
        ctxAlignBottom: t('commands.align.bottom'),
        ctxDistributeH: t('commands.distribute.h'),
        ctxDistributeV: t('commands.distribute.v'),
        imageBroken: t('canvas.imageBroken'),
        minimap: t('canvas.minimap'),
        ghostBadge: t('canvas.ghostBadge'),
      },
    });
    editorRef.current = editor;
    if (state.exec) editor.setExecutionMode(true);
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

  useEffect(() => {
    editorRef.current?.setStyle(style);
    try { localStorage.setItem('pathloom.renderStyle', useApp.getState().renderStyle); } catch { /* preference only */ }
  }, [style]);

  useEffect(() => {
    editorRef.current?.setExecutionMode(exec);
  }, [exec]);

  useEffect(() => { editorRef.current?.setSnap(snap); }, [snap]);
  useEffect(() => { editorRef.current?.setMinimap(minimap); }, [minimap]);

  const keysJson = JSON.stringify(keys);
  useEffect(() => {
    editorRef.current?.setKeymap(canvasPart(JSON.parse(keysJson)));
  }, [keysJson]);

  return (
    <>
      <div ref={ref} className="canvas-host" />
      <div className={`toolbar ${exec ? 'hidden' : ''}`} role="toolbar">
        {TOOLS.map(({ tool: tl, icon: Icon }) => (
          <button
            key={tl}
            className={tool === tl ? 'on' : ''}
            title={`${t(`tools.${tl}`)} (${label(`tool.${tl}`, keys)})`}
            aria-label={t(`tools.${tl}`)}
            onClick={() => editorRef.current?.setTool(tl)}
          >
            <Icon size={18} />
            <sub>{label(`tool.${tl}`, keys)}</sub>
          </button>
        ))}
      </div>
      <div className="zoom">
        <button aria-label={t('common.zoomOut')} onClick={() => editorRef.current?.zoomTo(zoom / 1.2)}><IconMinus size={15} /></button>
        <span className="zl">{Math.round(zoom * 100)}%</span>
        <button aria-label={t('common.zoomIn')} onClick={() => editorRef.current?.zoomTo(zoom * 1.2)}><IconPlus size={15} /></button>
        <button aria-label={t('common.fit')} title={t('common.fit')} onClick={() => editorRef.current?.zoomToFit()}><IconMaximize size={15} /></button>
        <span className="vsep" />
        <button className={snap ? 'on' : ''} aria-pressed={snap} title={`${t('commands.view.toggleSnap')} (${label('view.toggleSnap', keys)})`} onClick={() => useApp.getState().set({ snap: !snap })}><IconGridDots size={15} /></button>
        <button className={minimap ? 'on' : ''} aria-pressed={minimap} title={t('canvas.minimap')} onClick={() => useApp.getState().set({ minimap: !minimap })}><IconMap2 size={15} /></button>
        <span className="vsep" />
        <button aria-label={t('common.undo')} title={`${t('common.undo')} (${label('edit.undo', keys)})`} onClick={() => editorRef.current?.undo()}><IconArrowBackUp size={15} /></button>
        <button aria-label={t('common.redo')} title={`${t('common.redo')} (${label('edit.redo', keys)})`} onClick={() => editorRef.current?.redo()}><IconArrowForwardUp size={15} /></button>
      </div>
    </>
  );
}
