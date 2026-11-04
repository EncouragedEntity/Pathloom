# M2 — контракти (Roadmap)

Мета M2 (spec §12): frames-фази з прогресом, Execution mode, Inspector (деталі + файл + редагування), Список задач, `Convert to stage`, контекстне меню. Стани ready/blocked і заборона циклів уже є з M1.

Власники директорій як у M1: `packages/canvas` — агент полотна; `crates/pathloom-core` і `apps/desktop` — оркестратор.

## Полотно (`@pathloom/canvas`) — доповнення API

```ts
export type Tool = /* M1 */ | 'frame';          // shortcut F

export interface Editor {
  // M1 API без змін, плюс:
  setExecutionMode(on: boolean): void;           // див. нижче
  getExecutionMode(): boolean;
  removeStageCards(key: string): void;           // прибрати всі картки етапу з дошки (етап видалено); одна дія undo
}

export interface CanvasHost {
  // M1 без змін, плюс (опційний):
  onContextAction?(action: 'convertToStage' | 'openStage', payload: { elementId?: string; stageKey?: string }): void;
}

export interface CanvasLabels {
  // M1 + :
  frameDefaultName: string;        // "Phase"
  frameProgress: string;           // "{done} of {total} stages"
  ctxConvertToStage: string; ctxDuplicate: string; ctxDelete: string;
  ctxBringToFront: string; ctxSendToBack: string; ctxLock: string; ctxUnlock: string;
  ctxOpenStage: string; ctxRename: string;
}
```

### Frames (фази)
- Інструмент `frame` (`F`): drag створює рамку `type:'frame'` з `name` = `labels.frameDefaultName` + номер; рамка під іншими елементами (менший `index`).
- Належність: елемент належить рамці, якщо його центр усередині рамки на момент завершення переміщення; записується в поле `frame` елемента (spec §4.3). Переміщення рамки рухає всіх її членів (одна дія undo). Видалення рамки не видаляє членів (лише очищає `frame`).
- Заголовок над рамкою: назва + міні-прогрес-бар + `frameProgress` (`done`/`total` — кількість карток-етапів у рамці зі статусом `done` / усіх карток). Подвійний клік по назві — редагування назви (DOM-оверлей).
- Clean: пунктирна рамка з радіусом; sketch: rough-рамка, назва рукописним шрифтом.

### Execution mode
- `setExecutionMode(true)`: картки `done` і `blocked` приглушені (opacity ~0.3/0.5), `ready`/`active` — з акцентною обводкою; у картках сховані виконані задачі; довільні фігури, стрілки, sticky, текст — приглушені до ~0.15.
- Редагування заблоковане: не можна створювати, переміщувати, змінювати розмір, видаляти; інструменти, крім `select`/`hand`, вимкнені (setTool ігнорує). Дозволено: pan/zoom, виділення карток, чекбокси задач, подвійний клік → `openStage`.
- Вимкнення повертає звичайний вигляд. Стан не пишеться в дошку.

### Контекстне меню (правий клік)
Власне DOM-меню в контейнері полотна (тема з `ThemeTokens`, закривається Escape/кліком поза ним):
- фігура з текстом (rect/ellipse/diamond): Convert to stage, Duplicate, Bring to front, Send to back, Lock/Unlock, Delete;
- картка: Open stage (→ `host.openStage`), Duplicate недоступний, Bring to front, Send to back, Lock/Unlock, Delete (прибирає лише картку з дошки);
- рамка: Rename, Bring to front/Send to back, Lock/Unlock, Delete;
- кілька елементів: Bring to front, Send to back, Lock/Unlock, Delete.
Також shortcut `Ctrl+Shift+S` = Convert to stage, `Ctrl+]`/`Ctrl+[` = front/back, `Ctrl+Shift+L` = lock/unlock.

## Ядро (`pathloom-core`) — доповнення
```rust
pub struct StageMeta { pub title: Option<String>, pub who: Option<Who>, pub priority: Option<Priority>,
                       pub due: Option<Option<String>>, pub branch: Option<Option<String>>, pub kind: Option<StageKind> }
impl Project {
    pub fn update_meta(&self, key: &str, meta: StageMeta) -> Result<Stage>;   // None = не змінювати
    pub fn stage_source(&self, key: &str) -> Result<String>;                  // сирий текст файлу
    pub fn add_subtask(&self, task_id: &str, title: &str) -> Result<Stage>;   // M0-02 → M0-02a, b, …
}
```

## Застосунок
- Перемикач переглядів у рядку breadcrumbs: Дошка | Список.
- Список: таблиця всіх задач проєкту (ID, задача, етап, хто, стан етапу) з фільтрами Усі / Можна робити / Заблоковані / Готові і пошуком; клік по етапу → дошка + фокус.
- Inspector: вкладки Деталі / Файл; редагування хто/пріоритет/дедлайн/гілка/тип; перейменування, видалення задач, підзадачі; «Видалити етап» з підтвердженням.
- Кнопка Execution (`E`) у панелі вкладок, стан у сторі.
