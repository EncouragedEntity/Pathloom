# M1 — контракти між модулями

Мета M1 (spec §12): запустити застосунок → створити/відкрити проєкт → дошка з фігурами → картки етапів із задачами → залежність стрілкою між картками → зберегти й відкрити знову.

Модулі й власники директорій (не редагувати чужі директорії):

| Модуль | Директорія | Мова |
|---|---|---|
| Ядро | `crates/pathloom-core` | Rust |
| Полотно | `packages/canvas` | TypeScript (без React) |
| Застосунок | `apps/desktop` (`src-tauri` + `src`) | Rust + React |

Формати файлів — [spec.md §4](spec.md). Цей документ фіксує API.

## 1. `pathloom-core` (Rust)

```rust
pub struct Project { pub root: PathBuf, pub config: ProjectConfig }

#[derive(Serialize, Deserialize)]
pub struct ProjectConfig { pub format: u32, pub name: String, pub plan_dir: String, pub agent_changes: AgentChanges }
pub enum AgentChanges { Auto, Review }           // serde: "auto" | "review"

impl Project {
    pub fn init(root: &Path, name: &str) -> Result<Project>;   // .pathloom/project.toml, .pathloom/.gitignore (cache/ proposals/ log/), plan/boards/roadmap.board.json, plan/stages/
    pub fn open(root: &Path) -> Result<Project>;               // помилка NotAProject, якщо нема .pathloom/project.toml
    pub fn find(start: &Path) -> Result<Project>;              // шукає вгору
    pub fn plan_dir(&self) -> PathBuf;

    pub fn list_boards(&self) -> Result<Vec<String>>;          // "roadmap", "arch/backend" — шлях відносно plan/boards без .board.json, роздільник '/'
    pub fn load_board(&self, name: &str) -> Result<Board>;
    pub fn save_board(&self, name: &str, board: &Board) -> Result<()>;   // атомарно, канонічний формат
    pub fn create_board(&self, name: &str, title: &str) -> Result<Board>;

    pub fn load_stages(&self) -> Result<Vec<Stage>>;           // усі plan/stages/*.md, відсортовані за key
    pub fn load_stage(&self, key: &str) -> Result<Stage>;
    pub fn save_stage(&self, stage: &Stage) -> Result<()>;     // атомарно
    pub fn create_stage(&self, title: &str, key: Option<&str>) -> Result<Stage>;  // key: заданий або згенерований (див. нижче)
    pub fn delete_stage(&self, key: &str) -> Result<()>;       // також прибирає key з depends інших етапів
    pub fn add_task(&self, key: &str, title: &str) -> Result<Stage>;   // ID = <KEY>-<NN>, NN = max+1, 2 цифри мінімум
    pub fn set_task_done(&self, task_id: &str, done: bool) -> Result<Stage>; // для задачі з підзадачами — ставить усім підзадачам
    pub fn rename_task(&self, task_id: &str, title: &str) -> Result<Stage>;
    pub fn remove_task(&self, task_id: &str) -> Result<Stage>;
    pub fn link(&self, from: &str, to: &str, soft: bool) -> Result<()>;  // додає from у depends етапу `to`; цикл → Error::Cycle
    pub fn unlink(&self, from: &str, to: &str) -> Result<()>;
}

pub fn compute_statuses(stages: &[Stage]) -> BTreeMap<String, Status>;   // spec §5
pub fn stage_views(stages: &[Stage]) -> Vec<StageView>;                    // для UI

pub enum Status { Done, Active, Ready, Blocked }   // serde: lowercase
```

Генерація ключа з назви: латинські літери/цифри з перших слів (транслітерація кирилиці → латиниця), верхній регістр, 2–4 символи; якщо зайнято — додати цифру; якщо порожньо — `S1`, `S2`…

Типи (serde, JSON для UI — `camelCase`):

```rust
pub struct Stage {
    pub key: String, pub title: String,
    pub kind: StageKind,              // stage | milestone
    pub who: Who,                     // me | ai | both  (за замовчуванням ai)
    pub due: Option<String>, pub priority: Priority,   // low | med | high (за замовчуванням med)
    pub branch: Option<String>, pub pr: Option<String>, pub tags: Vec<String>,
    pub depends: Vec<Dep>,            // Dep { id: String, soft: bool }
    pub description: String,          // текст між frontmatter і першою керованою секцією
    pub tasks: Vec<Task>,             // Task { id, title, done, sub: Vec<Task> }
    pub comments: Vec<Comment>,       // Comment { at: String, author: String, text: String }
    // + невидимі для UI поля для збереження невідомих ключів frontmatter і довільного тексту поза керованими секціями
}

pub struct StageView { /* усі поля Stage для UI */ pub status: Status, pub progress: (u32, u32) }

pub struct Board { pub format: String, pub title: String, pub style: String, pub elements: Vec<serde_json::Map<String, Value>> }
```

`Board.elements` ядро трактує як непрозорі об'єкти (геометрією володіє полотно). Канонічний запис: один елемент на рядок; порядок ключів: `id, type, ref, x, y, w, h, angle, index`, далі решта за алфавітом. Невідомі ключі зберігаються.

Помилки: `thiserror` — `Io`, `Parse { path, message }`, `NotAProject`, `NotFound(String)`, `DuplicateKey(String)`, `InvalidKey(String)`, `Cycle(Vec<String>)`.

## 2. `@pathloom/canvas` (TypeScript)

```ts
export function createEditor(container: HTMLElement, opts: EditorOptions): Editor;

export interface EditorOptions {
  board: Board;
  stages: StageView[];          // для рендеру карток і залежностей
  host: CanvasHost;
  theme: ThemeTokens;
  style?: 'clean' | 'sketch';
}

export interface Editor {
  setBoard(board: Board): void;            // повна заміна (відкриття іншої дошки)
  setStages(stages: StageView[]): void;    // оновлення даних карток без зміни геометрії
  setTheme(theme: ThemeTokens): void;
  setStyle(style: 'clean' | 'sketch'): void;
  setTool(tool: Tool): void;
  getTool(): Tool;
  undo(): void; redo(): void;
  zoomToFit(): void; zoomTo(scale: number): void; getZoom(): number;
  focusElement(id: string): void;
  getBoard(): Board;                       // поточний стан для збереження
  destroy(): void;
}

export type Tool = 'select' | 'hand' | 'rect' | 'ellipse' | 'diamond' | 'arrow' | 'line' | 'pencil' | 'text' | 'stage';

export interface CanvasHost {
  onBoardChange(board: Board): void;                          // після кожної завершеної дії; хост сам дебаунсить збереження
  onSelectionChange(sel: { elementIds: string[]; stageKey: string | null }): void;
  onToolChange(tool: Tool): void;
  onZoomChange(scale: number): void;
  createStage(title: string): Promise<StageView>;              // інструмент `stage` і «Перетворити на етап»
  toggleTask(taskId: string): Promise<void>;                   // клік по чекбоксу на картці
  linkStages(from: string, to: string): Promise<string | null>;// null = ок, рядок = помилка для тосту (напр. цикл)
  unlinkStages(from: string, to: string): Promise<void>;
  openStage(key: string): void;                                // подвійний клік по картці
}
```

Типи елементів — `packages/canvas/src/types.ts` (джерело правди для формату елементів). `StageView` у TS дзеркалить Rust (`camelCase`).

Поведінка M1:
- Інструменти: select, hand, rect, ellipse, diamond, arrow, line, pencil, text, stage. Shortcuts як у spec §6.
- Pan (space+drag, middle mouse, hand), zoom колесом/тачпадом до курсора (0.1–4), dot-grid.
- Виділення, рамкове виділення, multi-select (Shift), move, resize, delete, duplicate (`Ctrl+D`), copy/paste у межах дошки, undo/redo (`Ctrl+Z`/`Ctrl+Shift+Z`) для геометрії.
- Текст: подвійний клік по фігурі або інструмент text → DOM-оверлей `textarea`.
- Стрілка прив'язується до фігури/картки під кінцем (binding), переїжджає разом із нею.
- **Стрілка від картки до картки = залежність**: елемент не створюється, викликається `linkStages(from, to)`; залежності малюються з `stages[].depends` між картками, які є на дошці; виділення ребра + Delete → `unlinkStages`.
- Картка етапу: висота з кількості задач; шапка (ключ, «хто», стан), назва, прогрес, задачі з чекбоксами (клік → `toggleTask`), футер (дедлайн, пріоритет, гілка). Semantic zoom < 0.55: лише ключ, назва, стан, прогрес.
- Рендер: Canvas2D, два шари (static + interactive), dirty-redraw, culling через `rbush`; стиль `sketch` через `roughjs` з `seed` елемента; `perfect-freehand` для олівця.
- Без React і без Tauri API; вся взаємодія з даними — через `CanvasHost`.

## 3. Застосунок (`apps/desktop`)

Tauri-команди (Rust → JSON, `camelCase`):
```
project_create(path, name) -> ProjectSnapshot
project_open(path) -> ProjectSnapshot
recent_projects() -> Vec<RecentProject>
board_load(name) -> Board
board_save(name, board) -> ()
board_create(name, title) -> Board
stage_create(title) -> StageView
task_toggle(taskId) -> Vec<StageView>
task_add(key, title) -> Vec<StageView>
stage_link(from, to) -> Result<Vec<StageView>, String>
stage_unlink(from, to) -> Vec<StageView>
stages_list() -> Vec<StageView>

ProjectSnapshot { root, name, boards: Vec<String>, stages: Vec<StageView> }
```
Відкритий проєкт зберігається в `tauri::State<Mutex<Option<Project>>>`. UI — layout концепту A (sidebar, tabs, canvas, inspector, status bar), i18n `en`/`uk`.
