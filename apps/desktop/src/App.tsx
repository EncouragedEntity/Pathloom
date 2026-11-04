import { useEffect, useState } from 'react';
import { useApp } from './store';
import { THEMES, applyCssVars } from './theme';
import { reopenLastProject } from './projectActions';
import { StartScreen } from './components/StartScreen';
import { Workspace } from './components/Workspace';

export function App() {
  const project = useApp((s) => s.project);
  const theme = useApp((s) => s.theme);
  // Until the last project has been tried, show nothing instead of flashing the start screen.
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    const t = THEMES[theme];
    applyCssVars(t.tokens);
    document.documentElement.dataset.mode = t.mode;
    try { localStorage.setItem('pathloom.theme', theme); } catch { /* preference only */ }
  }, [theme]);

  useEffect(() => {
    void reopenLastProject().finally(() => setBooting(false));
  }, []);

  if (booting) return null;
  return project ? <Workspace /> : <StartScreen />;
}
