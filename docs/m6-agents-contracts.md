# Агенти v2 — контракти (claim, імена агентів, журнал)

Ідеї 1–3 з [ideas.md](ideas.md). Мета: кілька агентів (Claude Code, Codex, Cursor…) працюють над одним планом, не беруться за одну задачу, людина бачить, хто що робить і що змінилося.

Власники: `crates/` — агент ядра; `packages/canvas` — агент полотна; `apps/desktop`, `plugin/`, docs — оркестратор.

## 1. Виконавець з ім'ям (`who`)

`who` стає рядком (зворотно сумісно з `me | ai | both`):

| Значення | Зміст |
|---|---|
| `me` | власник проєкту |
| `ai` | будь-який агент |
| `both` | разом |
| `ai:<name>` | конкретний агент: `ai:claude`, `ai:codex`, `ai:cursor` (name: `[a-z0-9._-]{1,32}`) |
| `human:<name>` | інша людина: `human:olia` (name: будь-які літери/цифри/пробіл/`._-`, до 32) |

Rust: `pub struct Who(String)` з serde як рядок, валідацією, `Default = "ai"`, методами `is_agent()`, `agent_name() -> Option<&str>`, `display()` (`ai:claude` → `Claude`, `human:olia` → `Olia`). Невалідне значення у файлі — помилка парсингу з повідомленням.
TS: `who: string`.
Колір: стабільний хеш імені → одна з 8 палітрових відтінків (полотно рахує сам, функція `agentColor(name, theme)` експортується з `@pathloom/canvas`).

## 2. Захоплення задач (claim)

Файл `.pathloom/claims.json` (у `.pathloom/.gitignore` — стан машини, не плану):
```json
{ "claims": [ { "task_id": "AUTH-02", "agent": "claude", "at": "2026-11-05T01:00:00Z", "expires_at": "2026-11-05T01:30:00Z", "note": "" } ] }
```
```rust
pub struct Claim { pub task_id: String, pub agent: String, pub at: String, pub expires_at: String, pub note: String }
impl Project {
    pub fn claim_task(&self, task_id: &str, agent: &str, ttl_secs: u64, note: &str) -> Result<Claim>;  // повторний claim тим самим агентом продовжує TTL; чужий живий → Error::Claimed { task_id, by, expires_at }
    pub fn release_task(&self, task_id: &str, agent: &str, force: bool) -> Result<()>;               // чужий без force → Error::Claimed
    pub fn claims(&self) -> Result<Vec<Claim>>;                                                       // лише живі (прострочені відкидаються й прибираються при записі)
}
```
- TTL за замовчуванням 30 хв, максимум 8 год.
- `set_task_done(true)` знімає claim цієї задачі (і підзадач). Для задачі з підзадачами claim на батьківську задачу покриває підзадачі.
- `next_tasks` пропускає задачі, захоплені іншими агентами; новий параметр `for_agent: Option<&str>` — свої захоплені задачі йдуть першими.
- `StageView` отримує `claims: Vec<ClaimView>` (`ClaimView { task_id, agent, expires_at }`) — заповнюється `Project::stage_views_live()` (нова функція: stage_views + живі claims). Стара `stage_views(&[Stage])` лишає `claims` порожнім.
- Нова помилка `Error::Claimed { task_id, by, expires_at }`, код MCP `CLAIMED`.

CLI: `pathloom task claim <ID> [--ttl 30m] [--note ...]`, `pathloom task release <ID> [--force]`, `pathloom claims`. Агент за замовчуванням = `--author` без префікса `agent:`.
MCP: tools `claim_task {task_id, ttl_minutes?, note?}`, `release_task {task_id, force?}`; агент = MCP clientInfo name, нормалізований до `[a-z0-9._-]` (напр. `claude-code`), або `--author`. `next` повертає поле `claimed_by` для задач і за замовчуванням ставить свої захоплені першими. `get_stage` містить `claims`. Інструкція `pathloom://guide/workflow` пояснює: claim → робота → set_task done (знімає claim) або release.

## 3. Журнал дій

`.pathloom/log/agent.jsonl` (вже в .gitignore), рядок на дію:
```json
{"at":"2026-11-05T01:02:03Z","author":"claude-code","source":"mcp","action":"apply","summary":"created AUTH, UI; 3 tasks","stages":["AUTH","UI"],"tasks":["AUTH-01"],"files":["plan/stages/AUTH.md"]}
```
- Пишуть CLI і MCP після кожної успішної мутації (`apply`, `propose`, `set_task`, `add_comment`, `claim_task`, `release_task`, `layout_board`, `validate --fix`, `stage add`, `task add/done/undo`, `link`, `unlink`, `proposals accept/reject`).
- `source`: `mcp` | `cli` | `app`. Застосунок теж пише свої дії з `author: "me"`, `source: "app"` для прийняття/відхилення пропозицій і скасування змін агента.
- Ротація: при > 5 МБ файл перейменовується в `agent.1.jsonl` (одна стара копія).
```rust
pub struct LogEntry { pub at: String, pub author: String, pub source: String, pub action: String, pub summary: String, pub stages: Vec<String>, pub tasks: Vec<String>, pub files: Vec<String> }
impl Project {
    pub fn log_action(&self, entry: &LogEntry) -> Result<()>;            // append, ніколи не валить основну дію (помилка логу → warning)
    pub fn read_log(&self, limit: usize, stage: Option<&str>) -> Result<Vec<LogEntry>>;   // найновіші першими
}
```
MCP: tool `activity {limit?, stage?}` — останні дії (щоб агент бачив, що робили інші). CLI: `pathloom log [--limit N] [--stage KEY]`.

## 4. Полотно

- Чіп виконавця на картці: `me`/`ai`/`both` — як зараз; `ai:claude` → «Claude» кольором агента; `human:olia` → «Olia».
- Захоплена задача: у рядку задачі праворуч маленький кольоровий чіп з ім'ям агента; у шапці картки, якщо є хоч один claim, — пульсуюча точка кольору агента («працює зараз»). Без анімації, коли нічого не захоплено (продуктивність).
- Нові labels: `claimedBy` (`"{agent} is on it"`), `working` (`"working"`).

## 5. Застосунок

- Inspector: поле «Хто робить» — select (Я / AI / Разом / агенти, які вже траплялися в плані чи журналі / «Інший…» з введенням `ai:name` або `human:name`); у задачах — чіп захоплення з кнопкою «Звільнити».
- Список: фільтр за виконавцем; колонка «Захоплено».
- Огляд: блок «Активність агентів» з журналу (останні 15 дій: хто, що, коли, клік → етап) і «Зараз працюють» (живі claims).
- Watcher: зміни `.pathloom/claims.json` і `.pathloom/log/` → перечитати claims/журнал (без банера «змінено поза застосунком»).
