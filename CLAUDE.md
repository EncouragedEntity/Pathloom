# Pathloom

Локальний десктопний застосунок: нескінченна дошка (малювання) + roadmap з карток етапів і залежностей + робота AI-агентів через CLI/MCP/файли.

Власник — XxArDy. Спілкування українською, технічні терміни англійською. Власник не знає Rust: код пише й підтримує Claude, тому документація й тести — обов'язкова частина кожної зміни.

## Документи (читати перед роботою)
- `docs/spec.md` — затверджена специфікація v0.1 (джерело правди).
- `docs/m1-contracts.md` … `docs/m3-contracts.md`, `docs/m6-agents-contracts.md`, `docs/m7-clients-contracts.md`, `docs/m8-proof-contracts.md` — API між модулями.
- `docs/ideas.md` — що робити далі.
- `docs/discovery.md` — журнал рішень і причини.
- Інший проєкт власника (Maestro) — окремий продукт; Pathloom інтегрується з будь-якими клієнтами лише через публічний протокол (MCP/CLI/файли/`watch`).
- `docs/research.md` — бібліотеки, ліцензії, ризики.
- `prototypes/concepts.html` — клікабельний макет (обрано концепт A).

## Структура
- `crates/pathloom-core` — модель, формати файлів, граф залежностей, стани (Rust).
- `crates/pathloom-cli` — бінарка `pathloom` (CLI + `mcp`).
- `packages/canvas` — рендер і редактор полотна (TypeScript, Canvas2D, без React).
- `apps/desktop` — Tauri 2 застосунок (`src-tauri` Rust + `src` React).

## Правила
- Файли проєкту користувача — джерело правди; запис лише атомарний; не переписувати текст, яким Pathloom не керує.
- Стан етапу обчислюється, не зберігається.
- Rust: правила зі skill `rust-skills` (`.claude/skills/rust-skills`), `thiserror` для помилок, без `unwrap` поза тестами.
- Нові залежності — лише з ліцензіями MIT/Apache/BSD/ISC/CC0 (див. research.md).
- UI-рядки — тільки через i18n (`en`, `uk`).

## Команди
- Тести: `cargo test --workspace`; полотно: `npm run test -w @pathloom/canvas`
- Перед першим `tauri dev`: `npm run build:cli -w @pathloom/desktop` (sidecar CLI)
- CLI/MCP: `crates/pathloom-cli` (`pathloom`, `pathloom mcp`); плагін Claude Code: `plugin/`
- Полотно: `npm run test -w @pathloom/canvas`, дев-стенд: `npm run dev -w @pathloom/canvas`
- Застосунок: `npm run tauri dev -w @pathloom/desktop`
