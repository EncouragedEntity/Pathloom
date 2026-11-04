# M3 — контракти (агенти: CLI, MCP, live reload)

Мета M3 (spec §7, §8, §12): агент створює й змінює план без відкритого застосунку (CLI, MCP, файли); відкритий застосунок одразу показує зміни, підсвічує їх і дає скасувати; режим review показує пропозиції агента пунктиром.

Власники: `crates/pathloom-core` + `crates/pathloom-cli` — агент ядра; `packages/canvas` — агент полотна; `apps/desktop`, `plugin/` — оркестратор.

## 1. Ядро (`pathloom-core`) — доповнення

### Spec для `apply` (YAML або JSON, spec §7.3)
```yaml
board: roadmap                 # дошка для нових карток; створюється, якщо нема; за замовчуванням "roadmap"
stages:
  - id: AUTH                   # новий або існуючий ключ; без id → згенерувати з title
    title: Авторизація         # обов'язково для нового
    kind: stage                # stage | milestone
    who: ai                    # me | ai | both
    priority: high             # low | med | high
    due: 2026-12-01            # "" очищає
    branch: feat/auth          # "" очищає
    depends: [M0, {id: M2, soft: true}]   # повна заміна depends, якщо поле задано
    tasks: [Логін, Реєстрація]  # додати задачі (пропустити, якщо задача з таким самим title вже є)
    tasks_done: [AUTH-01]       # позначити виконаними
    tasks_undone: []
    place: {after: M0}          # або {x: 100, y: 200}; без place → auto-layout для нових карток
links: [{from: AUTH, to: RELEASE, soft: false}]
unlinks: [{from: X, to: Y}]
frames: [{name: "Фаза 2", members: [AUTH, M1]}]   # створити рамку навколо карток (на дошці board)
comments: [{stage: AUTH, text: "Почав з OAuth"}]   # автор = значення --author / MCP clientInfo, за замовчуванням "agent"
expected: {AUTH: "<hash>"}      # оптимістична конкуренція: хеш файлу етапу, який агент бачив
```

```rust
pub struct ApplyOptions { pub dry_run: bool, pub author: String }
pub struct ApplyReport {
    pub created: Vec<String>, pub updated: Vec<String>,          // ключі етапів
    pub board: String, pub cards_added: Vec<CardPlacement>,       // CardPlacement { key, x, y, w }
    pub frames_added: Vec<String>, pub warnings: Vec<String>,
    pub files: Vec<String>,                                       // відносні шляхи змінених файлів
}
impl Project {
    pub fn apply(&self, spec: &ApplySpec, opts: &ApplyOptions) -> Result<ApplyReport>;   // все або нічого
    pub fn parse_spec(text: &str) -> Result<ApplySpec>;                                   // YAML або JSON
    pub fn stage_hash(&self, key: &str) -> Result<String>;                                // sha256 hex вмісту файлу
    pub fn next_tasks(&self, limit: usize) -> Result<Vec<NextTask>>;                      // spec §5 «що далі»
    pub fn add_comment(&self, key: &str, author: &str, text: &str) -> Result<Stage>;
    pub fn layout_board(&self, board: &str, only_new: &[String]) -> Result<Board>;        // шаруватий LR
    pub fn validate(&self) -> Result<Vec<Issue>>;                                          // Issue { code, message, path }
}
```
Транзакційність: усі цільові файли обчислюються в пам'яті; помилка (цикл, невідомий ключ у depends, конфлікт хешу → `Error::Conflict { key }`) — нічого не записано. Запис — атомарний для кожного файлу.

Layout: longest-path layering за hard+soft depends, порядок у шарі — barycenter; крок по X 320, по Y 220 (картка 250 широка); нові картки без place розміщуються праворуч/нижче від наявних, не перекриваючи їх.

### Пропозиції (режим review)
```rust
pub struct Proposal { pub id: String /* ulid */, pub created_at: String, pub author: String,
                      pub spec: ApplySpec, pub preview: ApplyReport /* dry-run */ }
impl Project {
    pub fn propose(&self, spec: &ApplySpec, author: &str) -> Result<Proposal>;  // пише .pathloom/proposals/<id>.json
    pub fn list_proposals(&self) -> Result<Vec<Proposal>>;
    pub fn accept_proposal(&self, id: &str) -> Result<ApplyReport>;            // apply + видалити файл
    pub fn reject_proposal(&self, id: &str) -> Result<()>;
}
```
Якщо `config.agent_changes == Review`, CLI `apply` і MCP `apply` викликають `propose` замість `apply` (CLI має `--direct`, щоб людина могла обійти).

### Реєстр власних записів (для застосунку)
```rust
pub mod writes {
    pub fn record(path: &Path, content_hash: &str);              // викликає write_atomic автоматично
    pub fn is_own(path: &Path, content_hash: &str) -> bool;      // для watcher: ігнорувати власні записи процесу
}
pub fn hash_bytes(bytes: &[u8]) -> String;                       // sha256 hex
```

## 2. CLI (`crates/pathloom-cli`, бінарка `pathloom`)
Команди й прапорці — spec §7.1, усі з `--json`, `--project <path>` (інакше пошук `.pathloom/` вгору), `--author <name>`. Плюс `pathloom proposals list|accept <id>|reject <id>`.
`pathloom mcp [--read-only]` — MCP-сервер stdio на `rmcp` 3.8: tools зі spec §7.2 + `propose` поведінка за конфігом, resources `pathloom://guide/workflow`, `pathloom://schema/{stage,board,spec}`. Помилки — структуровані з кодами spec §7.2. Шляхи не виходять за корінь проєкту.

## 3. Полотно — доповнення
```ts
export interface Ghost { stage: StageView; x: number; y: number }
export interface Editor {
  highlightStages(keys: string[], ms?: number): void;       // акцентне світіння карток, що згасає (за замовчуванням 8000 мс)
  setGhosts(ghosts: Ghost[]): void;                         // пунктирні картки-пропозиції + їхні depends-ребра; [] прибирає
  setBoard(board: Board, opts?: { keepCamera?: boolean }): void;   // keepCamera для live reload
}
```
Ghost-картки не є елементами дошки, не зберігаються, не виділяються.

## 4. Застосунок
- Watcher у `src-tauri` (notify + debouncer 200 мс) на `plan/` і `.pathloom/proposals/`; власні записи ігноруються через `writes::is_own`.
- Подія `plan-changed { stages: [keys], boards: [names], proposals: bool }` → UI перечитує, підсвічує змінені картки, банер «Агент змінив N етапів · Скасувати».
- Скасування: застосунок тримає знімок останнього відомого вмісту файлів плану; група зовнішніх змін (вікно 3 с) відновлюється атомарним записом попереднього вмісту (нові файли видаляються).
- Конфлікт: якщо дошка має незбережені локальні зміни, а файл дошки змінено зовні — банер «Взяти їхню / Лишити мою», без мовчазного перезапису.
- Review: банер «Claude пропонує: …» з «Прийняти» / «Відхилити», ghost-картки на дошці.
