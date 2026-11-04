import { useEffect } from 'react';
import { useApp } from './store';
import { THEMES, applyCssVars } from './theme';
import { StartScreen } from './components/StartScreen';
import { Workspace } from './components/Workspace';

export function App() {
  const project = useApp((s) => s.project);
  const theme = useApp((s) => s.theme);

  useEffect(() => {
    const t = THEMES[theme];
    applyCssVars(t.tokens);
    document.documentElement.dataset.mode = t.mode;
  }, [theme]);

  return project ? <Workspace /> : <StartScreen />;
}
