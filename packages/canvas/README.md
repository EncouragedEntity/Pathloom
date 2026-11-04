# @pathloom/canvas

Canvas2D whiteboard + roadmap stage cards. API: `docs/m1-contracts.md` section 2.

- `main`/`module`/`types` point at `src/index.ts` on purpose: the desktop app consumes TS source through the npm workspace (Vite compiles it). `npm run build` still emits an ESM lib + d.ts into `dist/`.
- Dev harness: `npm run dev -w @pathloom/canvas`, then open http://localhost:5174/ (mock host, themes, stress test).
- Extras beyond the contract: `EditorOptions.labels` (localized canvas strings), `Editor.convertSelectionToStage()` (single selected rect/ellipse/diamond becomes a stage card via `host.createStage(label)`; bound arrows are re-bound to the card), `panBy`, `getStats`.
- Global key shortcuts are bound on `window` and ignored while an input/textarea is focused.
- Cards are never duplicated/pasted (one card per stage per board).
