import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Command } from 'cmdk';
import { IconCheck } from '@tabler/icons-react';
import { useApp } from '../store';
import { setLanguage } from '../i18n';
import { allThemes } from '../theme';

const LANGUAGES = [
  { id: 'uk', name: 'Українська', en: 'Ukrainian' },
  { id: 'en', name: 'English', en: 'English' },
] as const;

/**
 * VS Code style pickers: "Theme…" previews each theme while you move through the list with the arrows (Escape
 * restores the old one), "Language…" switches the UI language. Opened from the project menu and the palette.
 */
export function QuickPick() {
  const { t, i18n } = useTranslation();
  const { picker, theme, customThemes, set } = useApp();
  const original = useRef(theme);
  // remember the theme in use when the picker opens, to restore it on Escape
  const [sel, setSel] = useState('');
  useEffect(() => {
    if (picker === 'theme') original.current = useApp.getState().theme;
    setSel(picker === 'theme' ? useApp.getState().theme : i18n.language.startsWith('uk') ? 'uk' : 'en');
  }, [picker, i18n.language]);
  if (!picker) return null;

  const close = (restore: boolean) => {
    if (restore && picker === 'theme') set({ theme: original.current });
    set({ picker: null });
  };
  const themes = allThemes(customThemes);
  const current = picker === 'theme' ? theme : i18n.language.startsWith('uk') ? 'uk' : 'en';

  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) close(true); }}>
      <Command
        className="palette quickpick"
        label={picker === 'theme' ? t('picker.theme') : t('picker.language')}
        value={sel}
        onValueChange={(v) => {
          setSel(v);
          // live preview while moving through the list
          const th = themes.find((x) => x.id.toLowerCase() === v.toLowerCase());
          if (picker === 'theme' && th) set({ theme: th.id });
        }}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); close(true); } }}
      >
        <Command.Input autoFocus placeholder={picker === 'theme' ? t('picker.themePlaceholder') : t('picker.languagePlaceholder')} />
        <Command.List>
          <Command.Empty>{t('palette.empty')}</Command.Empty>
          {picker === 'theme'
            ? themes.map((th) => (
              <Command.Item key={th.id} value={th.id} keywords={[th.name ?? th.id]} onSelect={() => { original.current = th.id; set({ theme: th.id }); close(false); }}>
                <span className="qp-swatch" style={{ background: th.tokens.bg, borderColor: th.tokens.accent }} />
                {th.name ?? th.id}
                {th.id === original.current && <IconCheck size={14} className="pal-meta" />}
              </Command.Item>
            ))
            : LANGUAGES.map((l) => (
              <Command.Item key={l.id} value={l.id} keywords={[l.name, l.en]} onSelect={() => { setLanguage(l.id); close(false); }}>
                {l.name}<span className="muted">&nbsp;{l.name !== l.en ? l.en : ''}</span>
                {l.id === current && <IconCheck size={14} className="pal-meta" />}
              </Command.Item>
            ))}
        </Command.List>
      </Command>
    </div>
  );
}
