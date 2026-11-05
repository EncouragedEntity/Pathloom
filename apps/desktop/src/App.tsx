import { useEffect, useState } from 'react';
import { useApp } from './store';
import { applyCssVars, findTheme } from './theme';
import { reopenLastProject } from './projectActions';
import { StartScreen } from './components/StartScreen';
import { Workspace } from './components/Workspace';
import { QuickPick } from './components/QuickPick';

export function App() {
  const project = useApp((s) => s.project);
  const theme = useApp((s) => s.theme);
  const customThemes = useApp((s) => s.customThemes);
  // Until the last project has been tried, show nothing instead of flashing the start screen.
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    const t = findTheme(theme, customThemes);
    applyCssVars(t.tokens);
    document.documentElement.dataset.mode = t.mode;
    try { localStorage.setItem('pathloom.theme', theme); } catch { /* preference only */ }
  }, [theme, customThemes]);

  useEffect(() => {
    void reopenLastProject().finally(() => setBooting(false));
  }, []);

  if (booting) return null;
  return (
    <>
      {project ? <Workspace /> : <StartScreen />}
      <QuickPick />
    </>
  );
}
