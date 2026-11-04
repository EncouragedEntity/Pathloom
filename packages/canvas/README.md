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
| `tool.image` / `tool.sticky` / `tool.eraser` | 8 / 9 / 0 |
| `edit.group` / `edit.ungroup` | Ctrl+G / Ctrl+Shift+G |
| `align.left` ... `align.bottom`, `distribute.h` / `distribute.v` | unbound (bind in settings) |
| `view.toggleSnap` | Ctrl+' |
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

## Live editing (agent changes)

- `highlightStages(keys, ms = 8000)`: accent glow on those cards, fading out (ease-out). Drawn on the interactive layer, so the static bitmap cache is untouched; the rAF loop runs only while a highlight is alive. Repeated keys restart their timer.
- `setGhosts(ghosts: Ghost[])`: proposed stages as dashed translucent cards with a `labels.ghostBadge` ("Proposed") badge and dashed dependency edges (to real cards or other ghosts). Not board elements (not saved, selected, hit-tested or in undo); included in `zoomToFit`. `[]` clears.
- `setBoard(board, { keepCamera: true })`: keeps camera, tool and selection (ids that still exist); history is still cleared (undo cannot resurrect stale state).

## M4 canvas features

- Sticky (`tool.sticky`): `type:'sticky'`, theme tint + shadow (clean) / hand font (sketch); text wraps and the height grows on commit.
- Images: `CanvasHost.saveAsset(file, name) => path` and `EditorOptions.assetUrl(path) => url` (host-provided storage). Image tool (file picker), clipboard paste and file drop create `type:'image'` (long side capped at 800). Corner resize keeps aspect, Shift frees it. Without `saveAsset` all of it is disabled. Placeholder while loading, broken-image glyph on error.
- Eraser: drag to mark (dimmed), release deletes in one undo step; locked elements and frames are never erased; not available in Execution mode.
- Groups share `group`: click selects the whole group, double-click enters it, Esc leaves. No nested groups (grouping replaces the old id).
- Align/distribute (groups count as one unit; distribute needs 3) are commands and context-menu items.
- `setSnap/getSnap`: 20-unit grid; with snap off, moving shows smart guides (6 px) against nearby elements.
- `setMinimap/getMinimap`, `findElements(query)`; `focusElement` glides the camera (~250 ms).
