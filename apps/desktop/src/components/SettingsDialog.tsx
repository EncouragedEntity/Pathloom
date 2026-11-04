import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconX, IconRotate, IconAlertTriangle, IconKeyboard, IconAdjustments, IconPlus, IconSparkles, IconCopy, IconCheck } from '@tabler/icons-react';
import { api, errorText } from '../api';
import { useApp } from '../store';
import { allThemes } from '../theme';
import { setLanguage } from '../i18n';
import { reopenLastEnabled, setReopenLast } from '../projectActions';
import {
  COMMAND_GROUPS, DEFAULT_KEYMAP, chordFromEvent, conflictsOf, effectiveKeymap, formatChord, useKeys, type Command,
} from '../keys';

/**
 * One recording field. A read-only <input> so the canvas ignores the keys while recording.
 * Escape cancels; any other combination is passed to onChord.
 */
function Recorder({ label, onChord, onDone, autoFocus, className }: {
  label: string; onChord: (chord: string) => void; onDone?: () => void; autoFocus?: boolean; className?: string;
}) {
  const { t } = useTranslation();
  const [recording, setRecording] = useState(false);
  return (
    <input
      readOnly
      autoFocus={autoFocus}
      className={`chord ${className ?? ''} ${recording ? 'rec' : ''}`}
      data-recording-shortcut={recording ? '' : undefined}
      value={recording ? t('settings.pressKeys') : label}
      size={Math.max(4, (recording ? t('settings.pressKeys') : label).length)}
      onFocus={() => setRecording(true)}
      onBlur={() => { setRecording(false); onDone?.(); }}
      onKeyDown={(e) => {
        if (!recording) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.code === 'Escape') { e.currentTarget.blur(); return; }
        const chord = chordFromEvent(e.nativeEvent);
        if (!chord) return; // bare modifier: keep waiting
        onChord(chord);
        e.currentTarget.blur();
      }}
    />
  );
}

/** All bindings of a command as chips: click a chip to change it, × removes it, + adds another one. */
function ChordList({ cmd, chords }: { cmd: Command; chords: string[] }) {
  const { t } = useTranslation();
  const bind = useKeys((s) => s.bind);
  const [adding, setAdding] = useState(false);
  const set = (next: string[]) => bind(cmd, [...new Set(next)]);
  return (
    <div className="chords" aria-label={t(`commands.${cmd}`)}>
      {chords.map((c, i) => (
        <span key={c} className="chip-k">
          <Recorder label={formatChord(c)} onChord={(ch) => set(chords.map((x, j) => (j === i ? ch : x)))} />
          <button className="chip-x" title={t('settings.removeKey')} aria-label={t('settings.removeKey')} onClick={() => set(chords.filter((_, j) => j !== i))}>
            <IconX size={11} />
          </button>
        </span>
      ))}
      {adding ? (
        <Recorder autoFocus label="" onChord={(ch) => set([...chords, ch])} onDone={() => setAdding(false)} />
      ) : (
        <button className="chip-add" title={t('settings.addKey')} aria-label={t('settings.addKey')} onClick={() => setAdding(true)}>
          <IconPlus size={12} />{chords.length === 0 && t('settings.addKey')}
        </button>
      )}
    </div>
  );
}

function Shortcuts() {
  const { t } = useTranslation();
  const { overrides, reset } = useKeys();
  const map = useMemo(() => effectiveKeymap(overrides), [overrides]);
  const conflicts = useMemo(() => conflictsOf(map), [map]);
  return (
    <div className="kb">
      <p className="hint">{t('settings.shortcutsHint')}</p>
      {COMMAND_GROUPS.map((g) => (
        <section key={g.id}>
          <h3>{t(`settings.groups.${g.id}`)}</h3>
          {g.commands.map((cmd) => {
            const clash = conflicts.get(cmd);
            const changed = JSON.stringify(map[cmd]) !== JSON.stringify(DEFAULT_KEYMAP[cmd]);
            return (
              <div key={cmd} className={`kb-row ${clash ? 'clash' : ''}`}>
                <span className="kb-name">
                  {t(`commands.${cmd}`)}
                  {clash && <span className="kb-warn"><IconAlertTriangle size={13} />{t('settings.conflict', { with: clash.map((c) => t(`commands.${c}`)).join(', ') })}</span>}
                </span>
                <ChordList cmd={cmd} chords={map[cmd]} />
                <button className="icon-btn" title={t('settings.reset')} aria-label={t('settings.reset')} disabled={!changed} onClick={() => reset(cmd)}>
                  <IconRotate size={14} />
                </button>
              </div>
            );
          })}
        </section>
      ))}
      <button className="btn" onClick={() => reset()}><IconRotate size={14} />{t('settings.resetAll')}</button>
    </div>
  );
}

function General() {
  const { t, i18n } = useTranslation();
  const { theme, renderStyle, customThemes, set } = useApp();
  const [reopen, setReopen] = useState(reopenLastEnabled());
  return (
    <dl className="meta settings-general">
      <dt>{t('sidebar.language')}</dt>
      <dd>
        <select value={i18n.language.startsWith('uk') ? 'uk' : 'en'} onChange={(e) => setLanguage(e.target.value as 'en' | 'uk')}>
          <option value="uk">Українська</option>
          <option value="en">English</option>
        </select>
      </dd>
      <dt>{t('sidebar.theme')}</dt>
      <dd>
        <select value={theme} onChange={(e) => set({ theme: e.target.value as typeof theme })}>
          {allThemes(customThemes).map((th) => <option key={th.id} value={th.id}>{th.name}</option>)}
        </select>
      </dd>
      <dt>{t('settings.renderStyle')}</dt>
      <dd>
        <select value={renderStyle} onChange={(e) => set({ renderStyle: e.target.value as typeof renderStyle })}>
          <option value="theme">{t('settings.styles.theme')}</option>
          <option value="clean">{t('settings.styles.clean')}</option>
          <option value="sketch">{t('settings.styles.sketch')}</option>
        </select>
      </dd>
      <dt>{t('menu.reopenLast')}</dt>
      <dd><input type="checkbox" checked={reopen} onChange={(e) => { setReopenLast(e.target.checked); setReopen(e.target.checked); }} /></dd>
    </dl>
  );
}

function CopyLine({ text }: { text: string }) {
  const { t } = useTranslation();
  const [done, setDone] = useState(false);
  return (
    <div className="copy-line">
      <code>{text}</code>
      <button className="icon-btn" title={t('settings.copy')} aria-label={t('settings.copy')} onClick={() => { void navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }); }}>
        {done ? <IconCheck size={14} /> : <IconCopy size={14} />}
      </button>
    </div>
  );
}

/** How to connect AI agents: review mode, CLI path, MCP config for Claude Code and other clients. */
function Agents() {
  const { t } = useTranslation();
  const { project, set } = useApp();
  const [setup, setSetup] = useState<{ cliPath: string | null; agentChanges: 'auto' | 'review' } | null>(null);
  useEffect(() => { api.agentSetup().then(setSetup).catch(() => setSetup({ cliPath: null, agentChanges: 'auto' })); }, []);
  if (!setup) return null;
  const cli = setup.cliPath ? (setup.cliPath.includes(' ') ? '"' + setup.cliPath + '"' : setup.cliPath) : 'pathloom';
  const json = JSON.stringify({ mcpServers: { pathloom: { command: setup.cliPath ?? 'pathloom', args: ['mcp'] } } }, null, 2);
  const toggle = (review: boolean) => api.setAgentChanges(review)
    .then(() => setSetup({ ...setup, agentChanges: review ? 'review' : 'auto' }))
    .catch((e) => set({ error: errorText(e) }));
  return (
    <div className="agents">
      <h3>{t('settings.agentMode')}</h3>
      <label className="radio"><input type="radio" checked={setup.agentChanges === 'auto'} onChange={() => void toggle(false)} />{t('settings.modeAuto')}</label>
      <label className="radio"><input type="radio" checked={setup.agentChanges === 'review'} onChange={() => void toggle(true)} />{t('settings.modeReview')}</label>
      <p className="hint">{t('settings.modeHint', { project: project?.name ?? '' })}</p>
      <h3>{t('settings.claudeCode')}</h3>
      <p className="hint">{t('settings.claudeHint')}</p>
      <CopyLine text={'claude mcp add pathloom -- ' + cli + ' mcp'} />
      <p className="hint">{t('settings.pluginHint')}</p>
      <CopyLine text="/plugin marketplace add XxArDy/Pathloom" />
      <CopyLine text="/plugin install pathloom@pathloom" />
      <h3>{t('settings.otherClients')}</h3>
      <p className="hint">{t('settings.otherHint')}</p>
      <pre className="code">{json}</pre>
      <h3>{t('settings.cli')}</h3>
      <p className="hint">{setup.cliPath ? t('settings.cliFound') : t('settings.cliMissing')}</p>
      {setup.cliPath && <CopyLine text={setup.cliPath} />}
      <CopyLine text={cli + ' next'} />
    </div>
  );
}

export function SettingsDialog() {
  const { t } = useTranslation();
  const { settingsTab, set } = useApp();
  const close = () => set({ settingsTab: null });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.code === 'Escape' && !document.querySelector('[data-recording-shortcut]')) close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!settingsTab) return null;
  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={t('menu.settings')}>
        <div className="modal-head">
          <h2>{t('menu.settings')}</h2>
          <div className="i-tabs" role="tablist">
            <button role="tab" aria-selected={settingsTab === 'general'} className={settingsTab === 'general' ? 'on' : ''} onClick={() => set({ settingsTab: 'general' })}><IconAdjustments size={14} />{t('settings.general')}</button>
            <button role="tab" aria-selected={settingsTab === 'keys'} className={settingsTab === 'keys' ? 'on' : ''} onClick={() => set({ settingsTab: 'keys' })}><IconKeyboard size={14} />{t('settings.shortcuts')}</button>
            <button role="tab" aria-selected={settingsTab === 'agents'} className={settingsTab === 'agents' ? 'on' : ''} onClick={() => set({ settingsTab: 'agents' })}><IconSparkles size={14} />{t('settings.agents')}</button>
          </div>
          <button className="icon-btn push" aria-label={t('inspector.close')} onClick={close}><IconX size={16} /></button>
        </div>
        <div className="modal-body">{settingsTab === 'general' ? <General /> : settingsTab === 'keys' ? <Shortcuts /> : <Agents />}</div>
      </div>
    </div>
  );
}
