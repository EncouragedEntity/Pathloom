# @pathloom/canvas

Canvas2D whiteboard + roadmap stage cards. API: `docs/m1-contracts.md` section 2.

- `main`/`module`/`types` point at `src/index.ts` on purpose: the desktop app consumes TS source through the npm workspace (Vite compiles it). `npm run build` still emits an ESM lib + d.ts into `dist/`.
- Dev harness: `npm run dev -w @pathloom/canvas`, then open http://localhost:5174/ (mock host, themes, stress test).
- Extras beyond the contract: `EditorOptions.labels` (localized canvas strings), `Editor.convertSelectionToStage()` (single selected rect/ellipse/diamond becomes a stage card via `host.createStage(label)`; bound arrows are re-bound to the card), `panBy`, `getStats`.
- Global key shortcuts are bound on `window` and ignored while an input/textarea is focused (see Keyboard).
- Cards are never duplicated/pasted (one card per stage per board).

## Keyboard

Shortcuts are a configurable keymap (`DEFAULT_CANVAS_KEYMAP`, override with `EditorOptions.keymap` / `editor.setKeymap()`, read with `getKeymap()`, trigger from menus with `editor.runCommand(cmd)`). Bindings match the physical key (`KeyboardEvent.code`), so they work on any layout (the `E` position stays `KeyE` on a Ukrainian layout).

Chord format (stable, safe to store in settings): modifiers in fixed order `Mod+Alt+Shift+` then the `code`, e.g. `Mod+Shift+KeyS`, `Digit1`, `BracketRight`, `Delete`, `Escape`. `Mod` is Ctrl on Windows/Linux and Cmd on macOS. A command maps to a list of chords (alternatives); an empty list unbinds it. Helpers: `chordFromEvent(e)` (null for bare modifiers; use it to record a new binding), `formatChord(chord)` (label like `Ctrl+Shift+S` / `⌘⇧S`), `findConflicts(map)`.

Events from inputs, textareas and contenteditable are ignored, and only matched chords get `preventDefault`. Not rebindable: Space (temporary hand), arrow keys (nudge, Shift = 10px), Enter/Escape inside text editing and menus. In Execution mode only tool selection (hand/select), `edit.cancel` and `view.*` act.

| Command | Default |
|---|---|
| `tool.select` | V, 1 |
| `tool.hand` | H |
| `tool.rect` / `tool.diamond` / `tool.ellipse` | 2 / 3 / 4 |
| `tool.arrow` / `tool.line` / `tool.pencil` / `tool.text` | 5 / L / 6 / 7 |
| `tool.frame` / `tool.stage` | F / S |
| `edit.undo` | Ctrl+Z |
| `edit.redo` | Ctrl+Shift+Z, Ctrl+Y |
| `edit.delete` | Del, Backspace |
| `edit.duplicate` / `edit.copy` / `edit.paste` / `edit.selectAll` | Ctrl+D / C / V / A |
| `edit.convertToStage` | Ctrl+Shift+S |
| `arrange.front` / `arrange.back` | Ctrl+] / Ctrl+[ |
| `edit.toggleLock` | Ctrl+Shift+L |
| `view.zoomIn` | Ctrl+=, Ctrl+Shift+=, Ctrl+Num + |
| `view.zoomOut` | Ctrl+-, Ctrl+Num - |
| `view.fit` / `view.zoom100` | Shift+1 / Shift+0 |
| `edit.cancel` | Esc |
