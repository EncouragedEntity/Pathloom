# Pathloom — Технічне дослідження (research)

Дата: 2026-11-04. Версії й дати релізів перевірено через API crates.io, npm registry і GitHub того ж дня.
Позначка «не перевірено» означає, що твердження взято з пам'яті або вторинного джерела без підтвердження.
Формат пунктів: **назва** — ліцензія — статус — рекомендація.

## 1. Rust core (`pathloom-core`, CLI, MCP)

### MCP і CLI
- **rmcp** 3.8.0 — Apache-2.0 — офіційний Rust SDK (`modelcontextprotocol/rust-sdk`), реліз 2026-10-26, активний. Підтримує специфікацію MCP 2026-07-28 і сумісний зі старішими. Має транспорт stdio (`transport-io`) і макроси `#[tool]`, `#[tool_router]`, `#[tool_handler]` (схеми входу через schemars). — **Брати.** Версії 1.x→3.x змінювали API швидко, тому закріпити мінорну версію і тримати MCP-шар тонким (`pathloom-core` не залежить від rmcp).
- **rust-mcp-sdk** 2.0.0 — MIT — сторонній SDK, ~115 тис. завантажень за 90 днів проти ~26 млн у rmcp. — Не брати.
- **clap** 4.6.7 (derive) — MIT OR Apache-2.0 — стандарт де-факто, активний. — **Брати.** Одна бінарка `pathloom` з підкомандами `board`, `task`, `mcp`, `check`, `schema`. Вивід `--json` для агентів.

### Файли: спостереження й атомарний запис
- **notify** 8.2.1 (CC0-1.0; є 9.0.0-rc.7) + **notify-debouncer-full** 0.7.0 (MIT OR Apache-2.0; є 0.8.0-rc.2) — активні. Debouncer-full склеює rename-події й відстежує перейменування. — **Брати.** Вікно дебаунсу 150–300 мс. Власні записи гасити за хешем вмісту (echo suppression), інакше буде цикл «записав → перечитав → перерендерив».
- **tempfile** 3.27.0 — MIT OR Apache-2.0 — активний. Атомарний запис: `NamedTempFile::new_in(той_самий_каталог)` → `write` → `sync_all` → `persist`. — **Брати.** На Windows `persist` іноді падає через антивірус або відкритий дескриптор, тому потрібен короткий retry.
- **atomicwrites** 0.4.4 — MIT — останній реліз 2024-09. — Не потрібен, tempfile покриває те саме.

### YAML frontmatter і Markdown
- **serde_yaml** 0.9.34+deprecated — архівовано автором у березні 2024. — Не брати.
- **serde_yml** 0.0.13 — deprecated, тепер шим поверх noyalib. Була пов'язана з RUSTSEC-2025-0068. — **Не брати.**
- **serde_yaml_ng** 0.10.0 (останній реліз 2024-05) і **serde_norway** 0.9.42 (2024-12) — форки без свіжих релізів. — Не брати.
- **yaml_serde** 0.10.7 — MIT OR Apache-2.0 — форк serde_yaml під організацією `yaml` (github.com/yaml/yaml-serde), реліз 2026-08-18, ~4,4 млн завантажень за 90 днів. Заміна serde_yaml майже 1:1, працює на `unsafe-libyaml`. — **Основний кандидат**, якщо потрібна поведінка serde_yaml.
- **serde-saphyr** 2.1.0 — MIT OR Apache-2.0 — реліз 2026-11-03, дуже активний. Чистий Rust із `forbid(unsafe)`, серіалізація й десеріалізація, бюджети проти шкідливого YAML, за замовчуванням відкидає дублікати ключів. API не сумісний із serde_yaml. — **Рекомендую для Pathloom:** файли пишуть агенти, тож суворий парсер із лімітами тут доречний. Перед вибором перевірити, що серіалізація дає стабільний формат (порядок полів, лапки).
- **gray_matter** 0.3.2 — MIT — реліз 2025-07. — Не потрібен. Розділити frontmatter за `---` можна в ~15 рядках, а YAML віддати serde-saphyr.
- **pulldown-cmark** 0.13.6 — MIT — активний, швидкий pull-парсер CommonMark+GFM. — **Брати** лише для індексації: заголовки, чекбокси, посилання `[[T-xxxx]]`. Тіло задачі зберігати байт-у-байт і не перегенерувати, щоб не шуміти в git diff.
- **comrak** 0.59.0 — BSD-2-Clause — AST із round-trip у Markdown. — Резерв, якщо колись знадобиться програмно правити тіло Markdown.

### JSON зі стабільним порядком
- **serde_json** 1.0.154 — MIT OR Apache-2.0. — **Брати.** Порядок полів задає порядок полів у struct. Для словників брати `BTreeMap` або фічу `preserve_order` (indexmap). Формат «один елемент на рядок» дасть власний `Formatter` або ручний вивід масиву елементів (~50 рядків).
- **fractional_index** 2.0.2 — MIT — реліз 2024-09, стабільний. — **Розглянути** для поля z-порядку `index`, як в Excalidraw 0.18. Перестановка одного елемента міняє один рядок, а не весь масив. На фронті є сумісний `fractional-indexing` 4.0.0 (CC0-1.0).

### Графи, layout, пошук, БД, git
- **petgraph** 0.8.3 — MIT OR Apache-2.0 — реліз 2025-09, ~138 млн завантажень, зрілий. Є `toposort`, `is_cyclic_directed`, `tarjan_scc` (повертає сам цикл для повідомлення агенту). — **Брати.**
- **rust-sugiyama** 0.4.0 — MIT — молодий (~43 тис. завантажень). — Як референс. Для roadmap досить власного шаруватого layout на petgraph (longest-path layering + barycenter, ~200 рядків). Тоді MCP-інструмент `layout` працює без фронтенду.
- **SQLite FTS5 через rusqlite** — у feature `bundled` FTS5 увімкнено (не перевірено в нашому CI). — **Брати.** Токенізатор `unicode61 remove_diacritics 2` для латиниці й кирилиці, `trigram` для пошуку підрядків. Українського стемінгу немає ніде, trigram компенсує.
- **tantivy** 0.27.0 — MIT — активний, потужний, але це окремий індекс на диску й важка залежність. Українського стемера теж немає (не перевірено). — Не брати для MVP. Проєкт на тисячі задач FTS5 тягне з запасом.
- **rusqlite** 0.41.1 — MIT — реліз 2026-10-28, синхронний. — **Брати** з `bundled`. Індекс — це кеш, міграції не потрібні: при зміні версії схеми файл видаляємо й перебудовуємо.
- **sqlx** 0.9.0 — MIT OR Apache-2.0 — асинхронний, compile-time перевірка запитів потребує БД під час збірки. — Надлишковий для локального кешу.
- **gix** 0.90.0 — MIT OR Apache-2.0 — чистий Rust, активний (2026-10-22). Status/diff/log стабільні, merge частковий (не перевірено обсяг). — **Брати**, якщо потрібен git без бінарки в PATH.
- **git2** 0.21.0 — MIT OR Apache-2.0 — обгортка libgit2 (C). Тягне OpenSSL/libssh2 на Linux. — Не брати.
- **Найлінивіший варіант для MVP:** викликати системний `git` через `std::process::Command` для рідкісних операцій (поточна гілка, `log`, `blame`). Git у користувача є, бо він працює через git. gix додати пізніше.
- **Ідея з високою віддачею:** власний git merge driver. У `.gitattributes`: `*.board.json merge=pathloom`. Команда `pathloom merge-driver %O %A %B` робить 3-way merge за `id` елементів. Конфлікти в задачах (Markdown) лишаються звичайними текстовими.

### ID, схеми, валідація, i18n
- **nanoid** 0.5.0 — MIT — реліз 2026-04. — **Брати** з алфавітом Crockford base32 (без I/L/O/U) і префіксом: `T-7K3Q9XMB` (8 символів ≈ 40 біт). На 10 000 задач ймовірність колізії ~5·10⁻⁵. Колізію ловить індекс і перегенеровує ID. Послідовні номери на кшталт `TASK-12` (як у Backlog.md) конфліктують між гілками.
- **ulid** 3.0.0 — MIT — 26 символів, сортується за часом. — Для подій, коментарів і логу агентів, не для ID задач, бо задовгі для людей.
- **uuid** 1.29.0 — UUIDv7 має ту саму роль, що ulid. — Альтернатива.
- **schemars** 1.2.3 — MIT — активний, генерує JSON Schema 2020-12 із типів Rust. rmcp сам використовує його для схем інструментів. — **Брати.** Віддавати схеми через `pathloom schema task|board` і як MCP resource, щоб агент писав файли без вгадування.
- **jsonschema** 0.60.2 — MIT — активний. — Опційно. Десеріалізація в типи вже валідує. jsonschema дає кращі повідомлення з JSON Pointer для `pathloom check`.
- **i18n у Rust** — CLI й MCP англійською, бо це інтерфейс для агентів. Нативні меню Tauri 2 можна будувати з JS через i18next, тоді Rust-i18n у MVP не потрібен. Якщо знадобиться: **rust-i18n** 4.2.4 (MIT, активний) простіший за **fluent** 0.17.0 (Apache-2.0 OR MIT, реліз 2025-05).

## 2. Tauri 2

Поточна версія: **tauri** 2.12.5 (2026-10-21), `@tauri-apps/cli` 2.12.4. Ліцензія: Apache-2.0 OR MIT. Офіційні плагіни мають ліцензію MIT OR Apache-2.0.

- **tauri-plugin-updater** 2.14.1 — **брати.** Оновлення підписуються власним ключем (`TAURI_SIGNING_PRIVATE_KEY`). `latest.json` можна віддавати з GitHub Releases. Ключ втратити не можна, інакше старі встановлення більше не оновляться.
- **tauri-plugin-dialog** 2.8.4 — **брати** (вибір папки проєкту, підтвердження).
- **tauri-plugin-window-state** 2.5.0 — **брати**, це один рядок.
- **tauri-plugin-single-instance** 2.5.5 — **брати.** Реєструвати першим плагіном. Друга копія передає argv першій, тож `Pathloom <папка>` відкриває вкладку в уже запущеному вікні. Потрібна feature `deep-link`.
- **tauri-plugin-deep-link** 2.6.3 — **брати**, але не в першу чергу. Посилання `pathloom://open?project=…&task=T-…` дає CLI й агенту змогу «показати задачу в застосунку». На Windows і Linux посилання приходить як argv нового процесу, тому без single-instance не працює.
- **tauri-plugin-fs** 2.7.1 — **не брати.** Увесь I/O іде через команди `pathloom-core`, тож scope-дозволи для WebView не потрібні, а це менша поверхня атаки.
- **tauri-plugin-store** 2.5.0 — опційно, для налаштувань застосунку й списку недавніх папок. Альтернатива — свій JSON у `app_config_dir` через serde.
- **tauri-plugin-cli** 2.5.0 — **не брати.** Парсить аргументи самого GUI-застосунку. Агентний CLI — окрема бінарка на clap, а `<папка>` з argv читається через `std::env::args`.
- **tauri-plugin-shell** — потрібен лише для запуску sidecar. Якщо GUI викликає core напряму як бібліотеку, sidecar запускати не треба: він лише встановлюється поруч.

### Sidecar CLI і PATH
- Бінарку вказати в `bundle.externalBin` у `tauri.conf.json` з назвою `pathloom-<target-triple>`. Triple дає `rustc --print host-tuple`.
- Виклик із GUI: `app.shell().sidecar("pathloom")` плюс `shell:allow-execute` із `"sidecar": true` у capabilities.
- Документація Tauri не описує додавання sidecar у PATH. Тож агентам потрібен окремий шлях установки:
  - пункт меню «Install command line tool», як `code` у VS Code: symlink у `/usr/local/bin` на macOS, запис у PATH користувача на Windows (або NSIS-hook інсталятора);
  - у `.deb` і `.rpm` покласти в `/usr/bin`;
  - паралельно публікувати CLI окремо: GitHub Releases, `cargo install pathloom-cli`, пізніше Homebrew або winget.
- Підключення до Claude Code: `claude mcp add pathloom -- pathloom mcp`.

### Інсталятори
- Windows: NSIS `-setup.exe` і MSI (WiX, збирається лише на Windows).
- macOS: `.app` і `.dmg`. Без Developer ID і нотаризації Gatekeeper блокує запуск (Apple Developer Program коштує $99 на рік).
- Linux: `.deb`, `.rpm`, `.AppImage`.
- CI: `tauri-apps/tauri-action` збирає матрицю ОС і створює draft-реліз разом із `latest.json`.
- Безкоштовний OSS-підпис для Windows через SignPath Foundation (не перевірено поточні умови).

### WebView і продуктивність
- Windows використовує WebView2 (Chromium) — найкращий варіант.
- macOS використовує WKWebView (Safari). Canvas2D там добрий.
- Linux використовує WebKitGTK, версія залежить від дистрибутива. Офіційна сторінка Tauri «Linux Graphics Issues» описує проблеми з NVIDIA та DMABUF і Wayland «Error 71». Обхідні шляхи: `WEBKIT_DISABLE_DMABUF_RENDERER=1`, `__NV_DISABLE_EXPLICIT_SYNC=1`.
- Головне застереження Tauri: WebGL на Linux може «тихо» працювати через програмний растеризатор, а `WEBGL_debug_renderer_info` цього не показує. Tauri радить мати не-WebGL fallback. Звідси висновок: **Canvas2D за замовчуванням**, WebGL лише як опція.
- **CEF/Chromium runtime:** офіційний crate `tauri-runtime-cef` 3.0.0-alpha.6 (2026-10-14, власник `tauri-bot`) і гілка `feat/cef` у репозиторії tauri (останній коміт 2026-10-07). Це трек Tauri 3. Стабільна лінія 2.x CEF не має. — **Не закладатися на MVP.** Рендерер тримати незалежним від Tauri API, щоб перехід на CEF був дешевим. Розмір бандла з CEF — не перевірено, очікувано +100 МБ і більше.
- **E2E-тестування:** `tauri-driver` (WebDriver) працює на Windows і Linux, але не на macOS (не перевірено зміни в 2026). Більшість UI-тестів запускати у звичайному браузері проти mock-шару команд.

## 3. Frontend (TypeScript + React)

### Рендер полотна
- **Сирий Canvas2D + власний scene graph** — підхід Excalidraw. — **Рекомендую.** Ключові прийоми:
  - віртуальна камера (pan/zoom);
  - viewport culling через spatial index;
  - кеш елементів у `OffscreenCanvas` або bitmap на рівні zoom;
  - два шари: статичний (усі елементи) та інтерактивний (виділення, ручки, drag-прев'ю);
  - перемальовування за dirty-прапором, а не щокадру.
  - Hit-test у дві фази: broad phase в rbush, narrow phase геометрією (`Path2D` з `isPointInStroke` або відстань до сегмента).
  - Редагування тексту — DOM-оверлей поверх canvas.
- **PixiJS** 8.22.0 — MIT — активний, WebGL і WebGPU. Найшвидший для 10 000+ спрайтів. Проте текст, rough-штрихи й вибір хуже лягають у його модель, а на WebKitGTK WebGL ризикований. — План Б, лише якщо профайлінг Canvas2D провалиться.
- **Konva** 10.9.1 — MIT — активний, Canvas2D зі scene graph. Hit-test через приховане «hit canvas» малює все вдруге, тож на тисячах об'єктів стає дорогим. Нам потрібен свій контроль над рендером. — Не брати.
- **Leafer UI** 2.3.3 — MIT — активний, швидкий, документація переважно китайською. — Не брати, хіба як джерело ідей.
- **Fabric.js** 7.4.0 — MIT. — Не для нескінченного полотна з тисячами об'єктів.
- **@xyflow/react** (React Flow) 12.12.1 — MIT — DOM-вузли. — Не для полотна, але варто вивчити UX ребер і портів для залежностей.

### Малювання та layout
- **roughjs** 4.6.6 — MIT — останній npm-реліз 2023-11, репозиторій без змін із 2024-07. Фактично заморожений, але стабільний, його досі використовує Excalidraw. — **Брати.** Детермінізм дає `seed` у кожному елементі. Якщо знадобиться — вендорити (~4 тис. рядків).
- **perfect-freehand** 1.2.3 — MIT — реліз 2026-02. — **Брати** для пера й маркера.
- **elkjs** 0.12.1 — **EPL-2.0** (npm вказує `EPL-2.0 OR GPL-3.0-or-later`) — активний. Найкращий авто-layout, але слабкий copyleft, ~1,5 МБ GWT-коду (не перевірено точний розмір), і він лише у JS. — Не брати. Layout у Rust-core (див. розд. 1), бо MCP теж має вміти layout.
- **@dagrejs/dagre** 3.1.3 — MIT — проєкт ожив, реліз 2026-10. Старий пакет `dagre` 0.8.5 мертвий. — Резерв для JS-прототипу.
- **d3-dag** 1.3.0 — MIT — активний, алгоритм Sugiyama. — Референс для власного Rust-layout.

### Редактор Markdown (тіло задачі)
Головна вимога — файл є джерелом правди і має бути git-friendly. WYSIWYG-редактори серіалізують Markdown наново: міняють маркери списків, екранування й переноси. Це дає шумні diff навіть без змін змісту.
- **CodeMirror 6** (`@codemirror/view` 6.43.15) — MIT — активний. Редагує сирий текст байт-у-байт. Live preview через декорації — підхід Obsidian. — **Рекомендую для MVP.**
- **Milkdown** 7.23.0 — MIT — активний, Markdown-first (ProseMirror + remark). — Найкращий WYSIWYG-варіант, якщо його вимагатимуть користувачі. Перевірити round-trip на корпусі файлів.
- **TipTap** 3.32.2 — ядро і `@tiptap/markdown` під MIT. Частина Pro-розширень і хмарна колаборація платні. — Альтернатива Milkdown. Markdown у нього — конвертація, а не рідний формат.
- **Lexical** 0.53.0 — MIT — версія до 1.0. Markdown через трансформери з втратами. — Не брати.

### Стан, i18n, UX
- **zustand** 5.0.16 — MIT — активний. — **Брати** для UI-стану: інструмент, виділення, камера. Документ живе в core, фронт отримує патчі через Tauri events. Undo — в core, бо D9 вимагає «один undo на сесію агента».
- **jotai** 3.0.1 — MIT. — Альтернатива, не потрібна.
- **i18next** 26.7.1 + **react-i18next** 17.1.12 — MIT — активні. — **Брати.** Файли `locales/en.json` і `locales/uk.json`. Плюралізація української працює через `Intl.PluralRules`.
- **cmdk** 1.1.1 — MIT — останній реліз 2025-08, стабільний, ~13 тис. зірок. — **Брати** для палітри команд.
- **rbush** 4.0.1 — MIT — реліз 2024-08, стабільний. Динамічне R-дерево з insert і remove. — **Брати** для полотна.
- **flatbush** 4.7.0 — ISC — лише статичний індекс. — Для імпорту або рендеру статичних великих сцен.

## 4. Продукти й специфікації, з яких варто вчитися

- **JSON Canvas** 1.0 (2024-03-11, Obsidian) — MIT.
  - Вузли `text|file|link|group` з `x,y,width,height`, ребра з `fromNode/toNode/fromSide/toSide/toEnd`. Кольори — hex або пресети `"1".."6"`.
  - **Позичити:** імпорт і експорт `.canvas`. Картка задачі → `file`-вузол на `tasks/<ID>.md`, залежність → ребро.
  - Нативним форматом не робити: немає фігур, штрихів, z-index і типів залежностей.
- **Excalidraw** — MIT.
  - Формат `.excalidraw`: `{type, version, source, elements[], appState, files}`. Елемент має `id`, `seed`, `version`, `versionNonce`, `isDeleted`, `groupIds`, `frameId`, `boundElements` і `index` (fractional).
  - **Позичити:** `seed` для детермінованого rough-рендеру, fractional `index` для порядку, `boundElements` для прив'язки стрілок до вузлів, бінарні файли окремо від елементів.
  - Імпорт `.excalidraw` дешевий і корисний.
  - `excalidraw/excalidraw-mcp` (MIT) — MCP App з потоковим малюванням. Корисний як приклад MCP-інструментів для полотна.
- **AFFiNE / BlockSuite** — BlockSuite під MPL-2.0. AFFiNE переважно MIT, але `packages/backend` і `packages/common/native` під окремою ліцензією.
  - Edgeless-режим: документ і полотно — два вигляди одних блоків, плюс frames, connectors і mindmap.
  - Сховище — Yjs CRDT, а не файли.
  - **Позичити:** UX (рамки-фрейми, «документ ↔ полотно», конектори з авто-маршрутом), а не формат.
- **Logseq** — AGPL-3.0 (код не копіювати). Whiteboards прибрано з DB-версії. Залишилися в «Logseq OG» на форку tldraw.
  - **Урок:** полотно на сторонньому рушії з чужою ліцензією легко втратити. Власний рендер — правильне рішення.
- **Drawnix** — MIT, ~15 тис. зірок, на фреймворку **Plait** (MIT). Mind map, flowchart, Mermaid → діаграма.
  - **Позичити:** плагінну архітектуру Plait й імпорт Mermaid як дешевий вхід для агентів (агент пише Mermaid, отримує дошку).
- **Penpot** — MPL-2.0. Відкритий SVG-формат, design tokens. Є офіційний `penpot/penpot-mcp` (MPL-2.0).
  - **Позичити:** підхід «MCP поверх плагінного API застосунку».
- **Backlog.md** — MIT, ~7,3 тис. зірок, активний. Найближчий аналог задачної частини: задачі як `.md` у git, CLI, `backlog mcp start`, канбан у терміналі й браузері, залежності, `--json` і `--watch`.
  - **Позичити:** MCP resources з інструкціями робочого процесу для агентів (`backlog://workflow/overview`), `--json` у всіх read-командах, пошук проєкту через MCP roots.
  - **Не повторювати:** послідовні ID (`TASK-1`), які конфліктують між гілками.
- **Vibe Kanban** (BloopAI) — Apache-2.0, активний. Канбан для оркестрації агентів. Цікавий UX статусів «агент працює».
- **Claude Task Master** — **MIT + Commons Clause**, тобто не OSI open source. Код не запозичувати.
- **tldraw** — source-available, відхилено. Зверніть увагу: `tldraw` 5.6.0 також має ліцензію «SEE LICENSE».

## 5. Інструменти для Claude Code

- **anthropics/skills** (Apache-2.0 для більшості скілів; document-скіли source-available). У каталозі є `mcp-builder`, `skill-creator`, `webapp-testing`, `frontend-design`, `web-artifacts-builder`. Встановлення:
  ```
  /plugin marketplace add anthropics/skills
  /plugin install example-skills@anthropic-agent-skills
  ```
  - `mcp-builder` — дизайн інструментів MCP (назви, описи, обробка помилок для агентів).
  - `skill-creator` — для власного скіла Pathloom (D10: Claude Code plugin = MCP + skill).
- **MCP Inspector** — `@modelcontextprotocol/inspector` 2.13.0 — у процесі переходу з MIT на Apache-2.0. Запуск: `npx @modelcontextprotocol/inspector pathloom mcp`. Ручна перевірка tools, resources і схем.
- **Підключення сервера до Claude Code:** `claude mcp add pathloom -- pathloom mcp`. Для дистрибуції — власний плагін-маркетплейс у репозиторії з `.mcp.json` і `skills/pathloom/SKILL.md`.
- **Tauri-скіли (спільнота):** `nodnarbnitram/claude-code-extensions` (tauri-v2) і `dchuk/claude-code-tauri-skills`. Офіційних скілів від Tauri немає. Вміст і безпеку не перевірено, переглянути перед встановленням.
- **MCPJam Inspector** — Apache-2.0, github.com/MCPJam/inspector (~2,3 тис. зірок). Запуск: `npx @mcpjam/inspector@latest` (Node 20+). Понад офіційний Inspector: playground з різними LLM, evals (тест-кейси «чи правильно агент викликає наші tools» на різних моделях), OAuth-дебаг, CLI для CI. Ядро безкоштовне; платні — хмарні матриці клієнтів і дашборди. — **Брати в M3** замість або разом з офіційним Inspector; evals корисні, щоб перевіряти якість описів наших MCP-інструментів.
- **rust-skills** (leonardomso/rust-skills) — MIT, ~670 зірок, стороння (не Anthropic). Набір правил для Claude: ownership, помилки (thiserror/anyhow), async/Tokio, unsafe, serde, тести, clippy, антипатерни. Встановлення: `git clone https://github.com/leonardomso/rust-skills.git .claude/skills/rust-skills` (на рівні проєкту). — **Брати на старті M1**, переглянувши вміст перед установкою.
- **Корисне в цій сесії:** скіли `api-and-interface-design` (контракт MCP і CLI), `documentation-and-adrs` (ADR для рішень D1–D15), `ci-cd-and-automation` (матриця tauri-action).

## 6. Топ-5 ризиків

1. **Продуктивність полотна на Linux (WebKitGTK) і частково macOS.**
   - Canvas2D за замовчуванням, без WebGL.
   - Culling через rbush і bitmap-кеш елементів.
   - Бенчмарк-сцена на 5 000 елементів у репозиторії. Ручний прогін на Windows, macOS і Linux з NVIDIA перед кожним релізом.
   - Налаштування «безпечний рендер» (вимикає DMABUF через env при перезапуску).
   - CEF — лише коли вийде стабільна версія.
2. **Git-конфлікти й шум у diff.**
   - Один елемент на рядок і стабільний порядок ключів.
   - Fractional `index` замість позиції в масиві.
   - Випадкові короткі ID замість послідовних.
   - Тіло Markdown не переписувати (CodeMirror, а не WYSIWYG).
   - Власний merge driver для `*.board.json`.
   - `pathloom check --fix` для ремонту битих посилань і дублікатів ID після merge.
3. **Одночасний запис агентом і застосунком.** Ризики: втрачені оновлення, читання напівзаписаного файлу, цикли watcher.
   - Тільки атомарний rename-запис.
   - Echo suppression за хешем вмісту.
   - Оптимістична конкуренція: MCP- і CLI-мутації приймають `expected_hash`, а при розбіжності повертають конфлікт, не перезапис.
   - У застосунку — банер «файл змінено зовні» з merge, якщо є незбережене редагування.
   - Шляхи в MCP-інструментах канонізувати й обмежувати коренем проєкту (path traversal).
4. **Нестабільність залежностей і ліцензій.**
   - rmcp міняв мажорні версії (1→3) за рік.
   - YAML-екосистема фрагментована.
   - roughjs заморожений, CEF в alpha.
   - elkjs (EPL), Task Master (Commons Clause), Logseq (AGPL) і tldraw несумісні з чистим MIT/Apache або небажані.
   - Пом'якшення: тонкі адаптери навколо rmcp і YAML у core, закріплені версії, `cargo-deny` (ліцензії та RustSec) і `license-checker` у CI, готовність вендорити roughjs.
5. **Дистрибуція та довіра ОС.**
   - Без підпису SmartScreen і Gatekeeper відлякують користувачів.
   - Втрата ключа updater ламає автооновлення.
   - CLI має опинитися в PATH, інакше агенти його не знайдуть.
   - Пом'якшення: tauri-action у CI з першого тижня, Apple Developer ID і SignPath для OSS (не перевірено), ключ updater у GitHub Secrets плюс офлайн-бекап, команда «Install command line tool» і окремі релізи CLI.

## Рекомендований стек

- MCP: `rmcp` 3.8 (stdio, `#[tool_router]`); схеми — `schemars` 1.2.
- CLI: `clap` 4.6 (derive), `--json` для агентів.
- Файли: `notify` 8.2 + `notify-debouncer-full` 0.7; `tempfile` для атомарного запису.
- Frontmatter: `serde-saphyr` 2.1 (запасний варіант — `yaml_serde` 0.10). Markdown-індексація — `pulldown-cmark` 0.13.
- JSON: `serde_json` зі struct-порядком і власним форматером «рядок на елемент»; `fractional_index` для z-порядку.
- Графи: `petgraph` 0.8 (цикли, topo) плюс власний шаруватий layout у core.
- Індекс і пошук: `rusqlite` 0.41 (`bundled`) + FTS5 (`unicode61` + `trigram`). Кеш одноразовий.
- Git: системний `git` у MVP, згодом `gix`; власний merge driver для `*.board.json`.
- ID: `nanoid` (Crockford base32, 8 символів, префікс `T-`/`B-`); `ulid` для подій.
- Tauri 2.12: плагіни updater, dialog, window-state, single-instance (+deep-link), shell (sidecar); без fs і cli.
- Полотно: власний Canvas2D-рендер + `rbush` + `roughjs` + `perfect-freehand`; PixiJS v8 як план Б.
- Редактор задачі: CodeMirror 6 (Milkdown як опційний WYSIWYG).
- UI: React, `zustand` 5, `i18next` + `react-i18next`, `cmdk`.
- Сумісність: імпорт і експорт JSON Canvas та `.excalidraw`; згодом імпорт Mermaid.
- Інструменти: `anthropics/skills` (`mcp-builder`, `skill-creator`), MCP Inspector, `cargo-deny`, tauri-action.

## Джерела

- https://crates.io/crates/rmcp
- https://github.com/modelcontextprotocol/rust-sdk
- https://github.com/modelcontextprotocol/modelcontextprotocol/tree/main/docs/specification
- https://crates.io/crates/clap
- https://crates.io/crates/notify-debouncer-full
- https://crates.io/crates/tempfile
- https://crates.io/crates/serde_yaml
- https://crates.io/crates/yaml_serde
- https://github.com/yaml/yaml-serde
- https://github.com/bourumir-wyngs/serde-saphyr
- https://docs.rs/crate/serde_yml/latest
- https://github.com/rustsec/advisory-db/pull/2915
- https://github.com/rubyatscale/pks/pull/46
- https://crates.io/crates/pulldown-cmark
- https://crates.io/crates/comrak
- https://crates.io/crates/petgraph
- https://crates.io/crates/rust-sugiyama
- https://crates.io/crates/tantivy
- https://crates.io/crates/rusqlite
- https://crates.io/crates/sqlx
- https://crates.io/crates/gix
- https://crates.io/crates/git2
- https://crates.io/crates/nanoid
- https://crates.io/crates/ulid
- https://crates.io/crates/schemars
- https://crates.io/crates/jsonschema
- https://crates.io/crates/fractional_index
- https://crates.io/crates/rust-i18n
- https://crates.io/crates/fluent
- https://crates.io/crates/tauri
- https://crates.io/crates/tauri-runtime-cef
- https://github.com/tauri-apps/tauri/tree/feat/cef
- https://v2.tauri.app/develop/sidecar/
- https://v2.tauri.app/develop/debug/linux-graphics/
- https://v2.tauri.app/plugin/updater/
- https://v2.tauri.app/plugin/single-instance/
- https://v2.tauri.app/plugin/deep-linking/
- https://v2.tauri.app/distribute/
- https://github.com/tauri-apps/tauri-action
- https://www.npmjs.com/package/pixi.js
- https://www.npmjs.com/package/konva
- https://www.npmjs.com/package/roughjs
- https://github.com/rough-stuff/rough
- https://www.npmjs.com/package/perfect-freehand
- https://www.npmjs.com/package/elkjs
- https://www.npmjs.com/package/@dagrejs/dagre
- https://www.npmjs.com/package/d3-dag
- https://www.npmjs.com/package/@tiptap/markdown
- https://www.npmjs.com/package/@milkdown/kit
- https://www.npmjs.com/package/lexical
- https://www.npmjs.com/package/@codemirror/view
- https://www.npmjs.com/package/zustand
- https://www.npmjs.com/package/i18next
- https://www.npmjs.com/package/cmdk
- https://www.npmjs.com/package/rbush
- https://www.npmjs.com/package/flatbush
- https://www.npmjs.com/package/leafer-ui
- https://jsoncanvas.org/spec/1.0/
- https://github.com/obsidianmd/jsoncanvas
- https://github.com/excalidraw/excalidraw
- https://github.com/excalidraw/excalidraw-mcp
- https://github.com/toeverything/AFFiNE
- https://github.com/toeverything/blocksuite
- https://raw.githubusercontent.com/logseq/docs/master/db-version-changes.md
- https://github.com/plait-board/drawnix
- https://github.com/worktile/plait
- https://github.com/penpot/penpot
- https://github.com/penpot/penpot-mcp
- https://github.com/MrLesk/Backlog.md
- https://github.com/BloopAI/vibe-kanban
- https://github.com/eyaltoledano/claude-task-master
- https://github.com/anthropics/skills
- https://github.com/modelcontextprotocol/inspector
- https://claudemarketplaces.com/skills/dchuk/claude-code-tauri-skills/integrating-tauri-rust-frontends
- https://agent-skills.md/skills/nodnarbnitram/claude-code-extensions/tauri-v2
