# Зовнішні клієнти — контракти (протокол, ідентичність агента, події, сесії)

Запит від проєкту власника з агентами (Maestro), але корисно будь-якому клієнту: Claude Code, Codex, Cursor, власні оркестратори.

## 1. Версія протоколу й можливості

`project_info` (MCP) і `pathloom info --json` (CLI) повертають:
```json
{
  "protocol": "pathloom/1",
  "version": "0.1.0",
  "capabilities": ["read", "apply", "proposals", "claims", "activity", "agents", "events", "sessions", "layout", "validate"],
  "agent_changes": "auto",
  "...": "наявні поля project_info"
}
```
- `protocol` — мажорна версія контракту файлів і MCP. Ламальні зміни → `pathloom/2`. Додавання полів/tools не змінює протокол, лише `capabilities`.
- `version` — версія збірки (`CARGO_PKG_VERSION`).
- `capabilities` — що підтримує ця збірка. У `--read-only` мутаційних можливостей немає (лишаються `read`, `activity`, `events`, `validate`).
- Константи в ядрі: `pub const PROTOCOL: &str = "pathloom/1"`, `pub fn capabilities(read_only: bool) -> Vec<&'static str>`.

## 2. Ідентичність агента

Файл `plan/agents.json` (у git: кольори й імена спільні для команди):
```json
{ "agents": [
  { "id": "claude-code", "name": "Claude", "color": "#d97757", "avatar": "🤖" },
  { "id": "maestro", "name": "Maestro", "color": "#3fb6f2", "avatar": "assets/maestro.png", "kind": "orchestrator" }
] }
```
- `id`: `[a-z0-9._-]{1,32}` — той самий, що в `who: ai:<id>`, claims і журналі.
- `name`: ≤ 40 символів. `color`: `#rgb` / `#rrggbb`. `avatar`: один емодзі/≤ 2 символи **або** шлях `assets/<file>` (png/jpg/webp/svg, у `plan/assets`). Інтернет-URL не дозволені (застосунок офлайн, CSP).
- `kind`: довільна мітка (`agent` за замовчуванням, `orchestrator`, `reviewer`…).
- Ядро: `AgentProfile { id, name, color, avatar, kind }`, `Project::{agents() -> Vec<AgentProfile>, upsert_agent(profile) -> AgentProfile, remove_agent(id)}` з валідацією; запис атомарний.
- MCP: tool `register_agent {name?, color?, avatar?, kind?}` — реєструє/оновлює **себе** (id = ідентичність виклику); `list_agents`. `project_info` містить `agents`. CLI: `pathloom agent set <id> [--name] [--color] [--avatar] [--kind]`, `pathloom agent list`, `pathloom agent remove <id>`.
- Застосунок/полотно: якщо профіль є — його `name` і `color` замінюють згенеровані (`agentColor`), аватар показується в чіпі (емодзі — текстом, файл — зображенням через `plasset`).

## 3. Потік подій

`pathloom watch --json` — нескінченний NDJSON у stdout (один JSON на рядок), поки процес живий:
```json
{"type":"hello","protocol":"pathloom/1","version":"0.1.0","at":"..."}
{"type":"stage","key":"AUTH","change":"created|updated|deleted","at":"..."}
{"type":"board","name":"roadmap","change":"updated","at":"..."}
{"type":"claims","claims":[{"task_id":"AUTH-02","agent":"claude-code","expires_at":"...","session":null}],"at":"..."}
{"type":"activity","entry":{ "...": "LogEntry" }}
{"type":"proposal","id":"01J...","change":"created|deleted","at":"..."}
{"type":"agents","at":"..."}
```
- Debounce 200 мс; події дедуплікуються в межах вікна.
- `activity` — нові рядки журналу (tail), по одному на подію.
- Без `--json` — короткий людський формат.
- `--since <RFC3339>` спершу віддає записи журналу після цього часу (щоб клієнт наздогнав пропущене), потім живі події.
- Завершення: Ctrl+C / закриття stdin не потрібне, клієнт просто вбиває процес.
- Ядро: `pathloom_core::events::{Event, EventWatcher}` (окремий модуль на `notify`), щоб застосунок колись міг перейти на той самий код.

## 4. Посилання на зовнішні сесії

Структура:
```json
{ "client": "maestro", "id": "sess_8f2", "url": "maestro://session/sess_8f2", "title": "Implement auth" }
```
- `client`: `[a-z0-9._-]{1,32}`; `id`: ≤ 128 друкованих символів; `url`: необов'язковий, `http(s)://` або власна схема `[a-z][a-z0-9+.-]*://` (без `javascript:`, `data:`, `file:`); `title`: ≤ 120.
- **Етап**: frontmatter `sessions: [ ... ]` (необов'язково; історія сесій, що працювали над етапом, найновіші останніми, максимум 20 — старі відкидаються). Через `apply`: `stages[].sessions_add: [ ... ]` (дедуп за `client`+`id`).
- **Claim**: `claim_task {task_id, session?}` — `Claim.session: Option<SessionRef>`; при claim з сесією вона також додається в `sessions` етапу.
- **Журнал**: `LogEntry.session: Option<SessionRef>`. MCP може приймати сесію в будь-якому мутаційному виклику через необов'язковий аргумент `session`.
- `StageView.sessions` (camelCase поля як у SessionRef).
- Застосунок: в інспекторі блок «Сесії» (клієнт, назва, відносний час з журналу якщо є, кнопка «Відкрити» для `url` через системний обробник після підтвердження, «Копіювати id»); чіп claim показує, що є сесія.
