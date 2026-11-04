# Pathloom — Специфікація v0.1 (на затвердження)

Статус: чернетка Stage 3 + Stage 5. Після затвердження власником — основа для реалізації.
Джерела рішень: [discovery.md](discovery.md) (D1–D25), [features.md](features.md), [research.md](research.md), макет [prototypes/concepts.html](../prototypes/concepts.html) (концепт A).

---

## 1. Продукт

**Що це.** Десктопний застосунок з нескінченною дошкою, на якій малюнки й план проєкту живуть разом. План — це картки етапів зі списками задач, з'єднані залежностями. AI-агенти (Claude Code тощо) читають і змінюють план через CLI, MCP або файли, а застосунок одразу показує зміни.

**Для кого (MVP).** Сам власник і соло-розробники, що будують проєкти з AI. Малі команди — через git.

**Головний сценарій.** Відкрив папку → агент або ти склав план → бачиш, що можна робити зараз → відмічаєш прогрес → `git commit`.

**Не-цілі MVP.** Хмара, акаунти, real-time колаборація, вбудований AI-чат, Gantt/календар, time tracking, мобільна версія.

**Принципи.**
1. Файли — джерело правди. Застосунок можна видалити, план лишиться читабельним у будь-якому редакторі.
2. Новачок малює одразу; планування з'являється, лише коли воно потрібне.
3. Стан етапу обчислюється, а не ставиться руками.
4. Все, що вміє застосунок з планом, вміє й агент без застосунку.

## 2. Користувацькі сценарії

**F1. Перший запуск.** Стартовий екран: «Новий проєкт», «Відкрити папку», недавні. «Новий проєкт» → вибір папки (можна корінь репо з кодом) → Pathloom створює `.pathloom/` і `plan/` з дошкою `roadmap` → відкривається порожня дошка з підказкою.

**F2. План від агента.** У терміналі: `claude` → «сплануй MVP у pathloom». Агент через MCP викликає `project_info`, потім `apply` зі spec (етапи, задачі, залежності). Pathloom (якщо відкритий) показує нові картки з підсвіткою «змінено агентом». Режим «review» → картки-пропозиції пунктиром з кнопками «Прийняти / Відхилити».

**F3. Щоденна робота.** Відкрив дошку → Execution mode → бачиш підсвічені «можна робити» → клацаєш галочки задач → залежні етапи автоматично стають доступними. Або агент: `pathloom task done M0-04`.

**F4. Малюнок → план.** Намалював прямокутник з текстом «Авторизація» → контекстне меню «Перетворити на етап» (`Ctrl+Shift+S`) → з'являється картка з ключем `AUTH`, позиція й колір збережені, створено файл `plan/stages/AUTH.md`.

**F5. Команда через git.** Двоє працюють у гілках, кожен змінює свої етапи → merge без конфліктів (один етап = один файл, дошка — один елемент на рядок). Конфлікт ключа або битий зв'язок → `pathloom validate` показує, `--fix` виправляє очевидне.

## 3. Інформаційна архітектура

```
Проєкт = папка на диску (маркер: .pathloom/project.toml)
├── Дошки (plan/boards/*.board.json) — можуть бути в підпапках
│   └── Елементи: фігури, стрілки, текст, малюнки, frames, sticky,
│                 картки (посилання на етап), портали (посилання на дошку)
└── Етапи (plan/stages/*.md) — спільні для всього проєкту
    ├── kind: stage | milestone
    ├── задачі (чекліст з ID) → підзадачі
    └── depends → інші етапи проєкту
```

- **Етап належить проєкту, а не дошці.** Картка на дошці — його відображення. Один етап може бути на кількох дошках.
- **Залежності — властивість етапів** (поле `depends` у файлі етапу). Дошка лише малює їх між картками, які на ній є.
- **Фаза = frame** на дошці. Прогрес фази рахується з карток усередині frame.
- **Перегляди** (Дошка, Список, Огляд) показують ті самі дані.

## 4. Формат файлів

### 4.1 Структура проєкту

```
<project>/
  .pathloom/
    project.toml        # назва, plan_dir, налаштування агента
    themes/             # власні теми (опційно)
    cache/              # SQLite-індекс — у .gitignore
    proposals/          # пропозиції агента в режимі review — у .gitignore
    log/agent.jsonl     # журнал дій агента — у .gitignore
  plan/
    boards/roadmap.board.json
    stages/M0.md
    assets/<hash>.png
```

`project.toml`:
```toml
format = 1
name = "my-game"
plan_dir = "plan"
agent_changes = "auto"      # auto | review
```

### 4.2 Файл етапу `plan/stages/<KEY>.md`

```markdown
---
id: M0
title: Ядро і формат файлів
kind: stage            # stage | milestone
who: ai                # me | ai | both
due: 2026-11-14        # необов'язково
priority: high         # low | med | high
branch: feat/core      # необов'язково
pr: 12                 # необов'язково
tags: [core]
depends: [S0, {id: M2, soft: true}]
---
Довільний опис у Markdown. Зберігається байт-у-байт.

## Tasks
- [x] M0-01 Формат stage-файлу
- [ ] M0-02 Формат board.json
  - [x] M0-02a Стабільне сортування ключів
  - [ ] M0-02b Атомарний запис

## Comments
- 2026-11-04T10:12Z agent:claude — M0-03 готово, тести в core/tests/graph.rs.
- 2026-11-04T11:02Z human — Перевір поведінку при git checkout.
```

Правила:
- `id` (ключ) — `[A-Z][A-Z0-9]{0,7}`, унікальний у проєкті, збігається з ім'ям файлу.
- Задача: `- [ ]`/`- [x]`, ID `<KEY>-<NN>`, підзадача — суфікс літерою (`M0-02a`). Лише 2 рівні вкладення.
- Задача з підзадачами виконана, коли виконані всі підзадачі.
- Pathloom переписує лише frontmatter і секції `## Tasks` / `## Comments`; решта тексту не змінюється.
- Milestone не має задач.
- Задачі, яким треба більше полів (дедлайн, виконавець, опис), виносяться в окремий етап (`Promote to stage`).

### 4.3 Файл дошки `plan/boards/<name>.board.json`

```json
{
  "format": "pathloom.board/1",
  "title": "Roadmap MVP",
  "style": "clean",
  "elements": [
{"id":"e7K3Q9XMB","type":"card","ref":"M0","x":360,"y":120,"w":250,"index":"a1"},
{"id":"eP2W8ZK4D","type":"frame","name":"Фаза 1 · Фундамент","x":30,"y":90,"w":620,"h":360,"index":"a0"},
{"id":"eQ9M1XC7T","type":"rect","x":40,"y":600,"w":160,"h":80,"angle":0,"stroke":"#c9c2ec","fill":null,"strokeWidth":1.5,"strokeStyle":"solid","roughness":1,"seed":81723,"index":"a2"},
{"id":"eA5N0RB3Y","type":"arrow","points":[[0,0],[140,-60]],"x":200,"y":640,"start":{"el":"eQ9M1XC7T"},"end":{"el":"e7K3Q9XMB"},"index":"a3"}
  ]
}
```

- Один елемент на рядок, ключі в фіксованому порядку, z-порядок — fractional `index`.
- Типи елементів MVP: `rect`, `ellipse`, `diamond`, `line`, `arrow`, `freedraw`, `text`, `image`, `sticky`, `frame`, `card`, `portal`.
- Спільні поля: `id`, `type`, `x`, `y`, `w`, `h`, `angle`, `index`, `locked`, `frame` (id frame-батька), `group`.
- `card.ref` → ключ етапу; `portal.board` → шлях дошки.
- Залежності між картками в дошку **не пишуться** — малюються з `depends`. Звичайні стрілки між картками — просто стрілки.
- Картка, чий етап видалено, показується як «зламане посилання» (не видаляється мовчки).

## 5. Модель roadmap

**Стан етапу** (обчислюється в `pathloom-core`):
```
done     — усі задачі виконані (milestone: усі hard-залежності done)
blocked  — є hard-залежність, яка не done
active   — не blocked, хоча б одна задача виконана
ready    — не blocked, жодна задача не виконана
```
- `soft`-залежність малюється пунктиром і не блокує.
- **Цикли заборонені.** Створення залежності, що утворює цикл, відхиляється з помилкою `CYCLE` і списком вузлів циклу.
- **«Що робити далі»** (`next`) = невиконані задачі етапів у стані `ready`/`active`, сортування: пріоритет → дедлайн → порядок у файлі.
- **Прогрес** етапу = виконані/усі задачі; фази (frame) = сума задач карток у frame; проєкту = усі задачі.
- **Milestone без дати** — нормальний стан; дата лише відображається.
- **Auto-layout** — шаруватий зліва направо (longest-path layering + barycenter), у Rust-ядрі. Застосовується до вибраного або до нових карток зі spec; існуючі картки не рухає без явного запиту.

## 6. Інтерфейс (layout концепту A)

```
┌──────────┬──────────────────────────────────────────────┬────────────┐
│ Sidebar  │ Tabs: roadmap × architecture +    [Execution][Агент][Експорт] │
│ пошук    ├──────────────────────────────────────────────┤ Inspector  │
│ дерево   │ Breadcrumbs · прогрес      [Дошка|Список|Огляд] │ (по виділенню)
│ дошок    ├──────────────────────────────────────────────┤ Деталі │ Файл│
│          │              [ toolbar ]                      │            │
│ Етапи    │                                               │            │
│ [Усі|Акт.|Готові]          ПОЛОТНО                      │            │
│ outline  │ [zoom]                              [minimap] │            │
│ агент ●  ├──────────────────────────────────────────────┤            │
│          │ Status: N можна робити · M заблоковано · гілка · збережено │
└──────────┴──────────────────────────────────────────────┴────────────┘
```

- **Sidebar** (згортається `Ctrl+B`): пошук, дерево дошок (реальні папки), outline етапів поточної дошки з фільтром і лічильниками, статус підключення агента.
- **Tabs**: відкриті дошки; back/forward `Alt+←/→`.
- **Toolbar** (плаваючий): hand `H`, select `1`, rect `2`, diamond `3`, ellipse `4`, arrow `5`, pencil `6`, text `7`, image `8`, sticky `9`, frame `F`, eraser `0`, stage card `S`.
- **Inspector** (праворуч, `Ctrl+I`): для етапу — стан, мета (хто, дедлайн, пріоритет, гілка, залежить від / блокує), опис (CodeMirror), задачі, коментарі; вкладка «Файл» — сирий Markdown. Для фігури — властивості стилю.
- **Execution mode** (`E`): приглушує done/blocked, підсвічує ready/active, ховає виконані задачі, блокує переміщення.
- **Semantic zoom**: < 55% — картка показує ключ, назву, стан, прогрес; ≥ 55% — повністю.
- **Command palette** `Ctrl+K`, **Quick open** `Ctrl+P`, **глобальний пошук** `Ctrl+Shift+F`.
- **Список**: таблиця задач з фільтрами (усі / можна робити / заблоковані / готові). **Огляд**: прогрес, фази, що далі, заблоковано, дедлайни, активність агента.

**Теми й стиль (D25).** Тема = JSON-файл токенів:
```json
{ "name": "Midnight", "mode": "dark", "style": "clean",
  "colors": { "bg": "#0f0d16", "panel": "#181524", "card": "#1b1827", "border": "#2a2540",
              "text": "#ece9f7", "muted": "#7d769a", "accent": "#9b87f5",
              "ok": "#4cc38a", "warn": "#e8b04a", "bad": "#ef5b6a", "edge": "#4a4370", "grid": "#231f35" },
  "radius": { "card": 14, "control": 8 }, "font": { "ui": "Inter", "hand": "Caveat", "mono": "JetBrains Mono" } }
```
Стиль рендеру `clean | sketch` — окреме налаштування (за замовчуванням з теми, можна перевизначити на дошці). MVP-теми: Graphite (за замовчуванням, акцент бурштиновий), Light, Warm paper (sketch). Фіолетову Midnight прибрано за рішенням власника (D26).

**i18n:** `en`, `uk`; усі рядки в `locales/*.json` з першого коміту. CLI і MCP — англійською.

## 7. Агенти: CLI і MCP

Одна бінарка `pathloom`. Корінь проєкту — `--project <path>` або пошук `.pathloom/` вгору від поточної папки.

### 7.1 CLI (кожна команда має `--json`)
```
pathloom init [--plan-dir plan]
pathloom board create <name> | list
pathloom stage add <KEY> "<title>" [--after <KEY>] [--who ai] [--board roadmap]
pathloom stage show <KEY> | list [--status ready]
pathloom task add <KEY> "<title>" | done <TASK-ID> | undo <TASK-ID>
pathloom link <FROM> <TO> [--soft] | unlink <FROM> <TO>
pathloom comment <KEY> "<text>"
pathloom next [--limit 10]
pathloom apply <spec.yaml|-> [--dry-run]
pathloom layout <board> [--only-new]
pathloom validate [--fix]
pathloom schema stage|board|spec
pathloom mcp [--read-only]
```

### 7.2 MCP (stdio, `rmcp`)
Tools:
| Tool | Призначення |
|---|---|
| `project_info` | Коротке зведення: дошки, кількість етапів по станах, топ-5 «далі» |
| `list_stages` | Фільтри `status/who/board/query`, пагінація `limit/cursor`, повертає лише ключ/назву/стан/прогрес |
| `get_stage` | Повний етап + `hash` версії файлу |
| `next` | Задачі, які можна робити зараз |
| `search` | FTS по етапах і задачах |
| `apply` | Пакетна зміна за spec; `dry_run`; транзакція «все або нічого» |
| `set_task` | Відмітити задачу виконаною/невиконаною |
| `add_comment` | Коментар від агента |
| `layout_board` | Auto-layout дошки або нових карток |
| `validate` | Перевірка цілісності |

Resources: `pathloom://guide/workflow` (як працювати з Pathloom), `pathloom://schema/{stage,board,spec}`.

**Помилки** структуровані: `{code, message, details}`; коди: `NOT_FOUND`, `CYCLE`, `DUPLICATE_KEY`, `CONFLICT` (хеш не збігся), `INVALID_SPEC`, `READ_ONLY`, `OUT_OF_PROJECT`.

### 7.3 Spec для `apply`
```yaml
board: roadmap              # створиться, якщо нема
stages:
  - id: AUTH
    title: Авторизація
    who: ai
    depends: [M0]
    tasks: [Логін, Реєстрація, Скидання пароля]   # ID присвоюються автоматично
    place: { after: M0 }     # або { x: 100, y: 200 }; без place — auto-layout
  - id: M0
    tasks_done: [M0-04]      # оновлення існуючого етапу
links: [{ from: AUTH, to: RELEASE }]
frames: [{ name: "Фаза 2", members: [AUTH, M1] }]
expected: { M0: "<hash>" }   # опційно: захист від перезапису чужих змін
```
Результат: список створених/змінених файлів і коротке зведення. При `agent_changes = review` `apply` пише пропозицію в `.pathloom/proposals/` замість файлів.

### 7.4 Плагін для Claude Code
Папка `plugin/` у репо: `.mcp.json` (`pathloom mcp`), `skills/pathloom/SKILL.md` (формат, команди, приклади, правила «не видаляй чужі етапи», «перед змінами читай project_info»). Підключення вручну: `claude mcp add pathloom -- pathloom mcp`.

## 8. Синхронізація застосунку з файлами

- `pathloom-core` у застосунку стежить за `plan/` (`notify` + debounce 200 мс).
- Свої записи ігноруються за хешем вмісту.
- Зовнішні зміни: перечитати файл → оновити модель → надіслати патч UI → підсвітити змінені картки на 10 с (мітка «агент» / «зовні»).
- **Undo агентських змін:** зміни з одного `apply` або однієї серії зовнішніх змін (вікно 3 с) — одна група; «Скасувати зміни агента» відновлює попередній вміст файлів.
- Якщо користувач редагує той самий етап у Inspector — банер «файл змінено зовні: [Взяти їхнє] [Залишити моє]», без мовчазного перезапису.
- Запис — тільки атомарний (temp-файл у тій самій папці → `fsync` → rename, retry на Windows).

## 9. Безпека і дозволи

- MCP/CLI працюють тільки в межах кореня проєкту; шляхи канонізуються, вихід за корінь → `OUT_OF_PROJECT`.
- `pathloom mcp --read-only` — лише читання.
- `agent_changes = review` — усі зміни агента через пропозиції.
- Ні мережі, ні запуску команд у MCP-сервері. Виняток — виклик системного `git` для читання (гілка, лог).
- Ліміти парсера: розмір файлу (1 МБ етап, 20 МБ дошка), глибина YAML, кількість елементів у spec.
- Журнал дій агента `.pathloom/log/agent.jsonl` (час, tool, змінені файли).
- WebView не має прямого доступу до файлової системи (без `tauri-plugin-fs`); усе через команди core.

## 10. Архітектура й технології

```
crates/
  pathloom-core   модель, парсер/серіалізатор файлів, граф, стани, layout,
                  індекс (SQLite FTS5), watcher, apply/spec, undo-групи
  pathloom-cli    бінарка `pathloom`: clap-команди + `mcp` (rmcp)
apps/desktop/
  src-tauri/      Tauri 2: команди → core, події → UI
  src/            React UI (shell, inspector, списки, overview)
packages/canvas/  TS-рендер полотна (Canvas2D), незалежний від Tauri
plugin/           Claude Code плагін (MCP + skill)
themes/           вбудовані теми
docs/  prototypes/
```

Стек — [research.md](research.md) «Рекомендований стек». Ключове:
- Rust: `serde`, `serde-saphyr`, `serde_json`, `pulldown-cmark`, `petgraph`, `rusqlite` (bundled, FTS5), `notify` + `notify-debouncer-full`, `tempfile`, `nanoid` (ID елементів), `fractional_index`, `clap`, `rmcp`, `schemars`.
- Tauri 2 плагіни: dialog, window-state, single-instance; updater — у V1.
- UI: React, `zustand`, `i18next`, `cmdk`, CodeMirror 6.
- Полотно: Canvas2D, `rbush`, `roughjs`, `perfect-freehand`; два шари (статичний + інтерактивний), culling, перемальовування за dirty-прапором; редагування тексту — DOM-оверлей.
- Undo/redo користувача — у core (команди), щоб CLI/MCP і UI мали одну історію.
- Ліцензія проєкту: **MIT OR Apache-2.0** (стандарт Rust-екосистеми). Донати — `.github/FUNDING.yml`.

**Цілі швидкодії:** 60 FPS pan/zoom на дошці з 2 000 елементів; відкриття проєкту з 1 000 етапів < 1 с (з кешем); реакція на зовнішню зміну файлу < 300 мс.

## 11. Тестування

- **core (головне):** юніт-тести графа (цикли, стани, next), round-trip файлів байт-у-байт (golden-файли в `crates/pathloom-core/tests/fixtures`), atomic write, конфлікт хешів, apply-spec (dry-run і транзакційність), layout без перетинів на типових графах.
- **CLI/MCP:** інтеграційні тести на тимчасовій папці проєкту; ручна перевірка через MCP Inspector перед релізом.
- **canvas:** vitest для геометрії, hit-test, semantic zoom; бенчмарк-сцена 5 000 елементів.
- **UI:** ручний чекліст ключових сценаріїв F1–F5 перед кожним milestone; e2e — пізніше.
- **Linux:** бенчмарк полотна в WSL2 (WSLg) на початку M1; реальне залізо — у друга перед публічним релізом.
- `cargo-deny` (ліцензії, RustSec) — з CI наприкінці MVP.

## 12. План реалізації

Кожен milestone закінчується робочим застосунком.

**Стан на 2026-11-05:** M1–M4 готові. M5 частково: інсталятори Windows збираються локально (NSIS + MSI) з CLI всередині, README en/uk зі скріншотами, CI/Release workflows лише з ручним запуском; не зроблено підпис, автооновлення, перевірку Linux/macOS, «Install command line tool» (зараз шлях і команди показано в Налаштування → AI-агенти).

| # | Milestone | Результат |
|---|---|---|
| M1 | **Перша дошка** | Запуск, новий/відкрити проєкт, дошка: rect/ellipse/diamond/arrow/text/pencil, pan/zoom, select/move/resize, undo; картки етапів із задачами; залежність стрілкою між картками; збереження у файли й повторне відкриття. Перед стартом — spike полотна в WSL. |
| M2 | **Roadmap** | Стани ready/blocked, заборона циклів, frames-фази з прогресом, Execution mode, sidebar outline з фільтрами, Inspector (деталі + файл), Список, `Convert to stage`. |
| M3 | **Агенти** | CLI повністю, MCP-сервер, `apply` + auto-layout, live reload з підсвіткою, undo змін агента, review-режим з пропозиціями, Claude Code плагін. |
| M4 | **Повне полотно й вигляд** | Image, sticky, eraser, lock, group, align, snap, minimap, semantic zoom, sketch-стиль, 3 теми + власні, en/uk, Ctrl+K, пошук, Огляд. |
| M5 | **Реліз** | Інсталятори Win/macOS/Linux, «Install command line tool», CI (GitHub Actions), гарний README двома мовами (en + uk) зі скріншотами, GIF і прикладами використання з агентом, публічний репо. |

## 13. Відкриті питання (не блокують старт M1)

- Назва «Pathloom» — перевірити, чи не зайнята (домен, торгова марка) перед публічним релізом.
- Підпис інсталяторів (Apple Developer, SignPath) — вирішити в M5.
- Merge driver для `*.board.json` — V1, якщо конфлікти дошок реально заважатимуть.
