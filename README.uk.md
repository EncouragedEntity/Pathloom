<div align="center">

<img src="apps/desktop/src-tauri/icons/128x128@2x.png" width="96" alt="Іконка Pathloom">

# Pathloom

**Локальна дошка й roadmap для проєктів, які ти будуєш з AI-агентами.**

Малюй вільно, плануй картками етапів і залежностями, а твій AI-агент (Claude Code, Codex, Cursor, Gemini CLI чи будь-який MCP-клієнт) будує й оновлює план, і ти бачиш зміни наживо.

[![CI](https://github.com/XxArDy/Pathloom/actions/workflows/ci.yml/badge.svg)](https://github.com/XxArDy/Pathloom/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/XxArDy/Pathloom?include_prereleases&label=release)](https://github.com/XxArDy/Pathloom/releases)
[![License: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)](#ліцензія)

[Завантажити](https://github.com/XxArDy/Pathloom/releases) · [English](README.md) · [Зміни](CHANGELOG.md) · [Документація](docs/README.md)

<img src="docs/images/uk/board.png" alt="Дошка Pathloom з фазами, картками етапів і залежностями" width="900">

</div>

## Навіщо

AI-агенти добре пишуть код, але погано тримають спільну картину того, *де зараз проєкт*. Трекери задач заважкі, TODO-файл заплаский. Pathloom — посередині:

- **Справжня дошка** — фігури, стрілки, олівець, стікери, зображення, рамки. Рівний або «від руки» стиль.
- **Справжній roadmap** — картки етапів зі списками задач, залежності стрілками, стани рахуються з графа (*можна починати*, *в роботі*, *заблоковано*, *готово*), фази, milestone.
- **Звичайні файли** — план лежить у твоєму репо як Markdown + JSON: його видно в diff, він мержиться й рев'юїться як код.
- **Зроблено для агентів** — CLI та MCP-сервер дають агенту читати план, додавати етапи, відмічати задачі й лишати нотатки. Застосунок одразу показує зміни, підсвічує їх і дає скасувати — або спершу переглянути.

Усе локально. Без акаунта й хмари.

## Можливості

| | |
|---|---|
| **Дошка** | Нескінченне полотно, рух і масштаб, прямокутники, еліпси, ромби, стрілки, що чіпляються до фігур, лінії, олівець, текст, стікери, зображення (вставити чи перетягнути), гумка, рамки, групи, вирівнювання й розподіл, прилипання до сітки, розумні напрямні, мінімапа. |
| **Roadmap** | Картки етапів з ID задач (`AUTH-03`) і підзадачами, залежності (жорсткі й м'які), захист від циклів, обчислювані стани, фази з прогресом, milestone. |
| **Зрозумілі плани** | Авторозкладка тримає дошку в порядку після кожної зміни агента: фази стають блоками колонок зліва направо, стрілки перетинаються якомога менше, а картки, які ти перетягнув сам, закріплюються. Наведи на картку, щоб бачити лише її ланцюг. Зайві стрілки сховані, а стрілки між фазами зібрані в одну з числом. Картка, що виросла, зсуває нижчі вниз. |
| **Режим «Фокус»** | `E` ховає зроблене й підсвічує те, що можна робити зараз. |
| **Перегляди** | Дошка, Список (усі задачі з фільтрами), Огляд (прогрес, що далі, що стоїть, дедлайни, останні нотатки). |
| **Агенти** | CLI `pathloom` і сервер `pathloom mcp`, живе оновлення, підсвітка змін, скасування змін агента одним кліком, режим перевірки з пропозиціями пунктирними картками. |
| **Зручність** | Палітра команд `Ctrl+K`, гарячі клавіші, які можна змінити і які працюють з українською розкладкою, теми Graphite / Light / Warm paper і власні файли тем, інтерфейс українською та англійською. |

<table>
<tr>
<td><img src="docs/images/uk/focus.png" alt="Режим «Фокус»"><br><sub>Режим «Фокус»</sub></td>
<td><img src="docs/images/uk/overview.png" alt="Огляд"><br><sub>Огляд</sub></td>
</tr>
<tr>
<td><img src="docs/images/uk/proposal.png" alt="Пропозиція агента в режимі перевірки"><br><sub>Пропозиція агента чекає на перевірку</sub></td>
<td><img src="docs/images/uk/paper.png" alt="Тема Warm paper у стилі від руки"><br><sub>Тема Warm paper, стиль «від руки»</sub></td>
</tr>
<tr>
<td><img src="docs/images/uk/list.png" alt="Усі задачі списком"><br><sub>Усі задачі списком</sub></td>
<td><img src="docs/images/uk/palette.png" alt="Палітра команд (Ctrl+K)"><br><sub>Палітра команд (Ctrl+K)</sub></td>
</tr>
</table>

## Встановлення

Завантаж інсталятор для своєї системи з [Releases](https://github.com/XxArDy/Pathloom/releases) (Windows `.exe` / `.msi`, macOS `.dmg`, Linux `.AppImage` / `.deb` / `.tar.gz`).

На Linux без встановлення: розпакуй `.tar.gz` (CLI `pathloom` і застосунок `pathloom-desktop`) і запускай із цієї папки:

```bash
tar -xzf pathloom-v0.1.0-x86_64-unknown-linux-gnu.tar.gz && ./pathloom --help
```

Архів не тягне залежностей. CLI `pathloom` потребує лише glibc 2.35 або новішої (зібрано на Ubuntu 22.04). `pathloom-desktop` з архіву потребує системних бібліотек WebKitGTK; на Debian/Ubuntu:

```bash
sudo apt install libwebkit2gtk-4.1-0 libgtk-3-0
```

Для десктоп-застосунку краще брати `.deb` або `.AppImage`. Перевір завантаження: `sha256sum -c pathloom-<tag>-x86_64-unknown-linux-gnu.tar.gz.sha256`.

Щоб оновити, запусти новий інсталятор поверх старого. На Windows краще брати `.exe`: сесії AI-агентів, що працюють із Pathloom, не обриваються під час оновлення й отримають нову версію після перезапуску.

> Збірки поки без цифрового підпису, тому Windows SmartScreen і macOS Gatekeeper попередять при першому запуску.

Інструмент командного рядка `pathloom` встановлюється поруч із застосунком. **Налаштування → AI-агенти** показують шлях до нього й готові команди для копіювання.

## Підключити AI-агента

Pathloom працює з **Claude Code, Codex, Gemini CLI, Cursor, VS Code Copilot, Claude Desktop** і будь-яким іншим агентом із підтримкою MCP. Над одним планом можуть працювати кілька агентів.

Усі агенти запускають той самий [MCP](https://modelcontextprotocol.io)-сервер: `pathloom mcp` у папці проєкту.

`pathloom` встановлюється поруч із застосунком і не додається в `PATH`. Візьми повний шлях із **Налаштування → AI-агенти**,
наприклад `C:\Users\ти\AppData\Local\Pathloom\pathloom.exe` у Windows, і підстав його замість `pathloom` у прикладах нижче.

### Claude Code

Один раз дай Claude Code інструменти Pathloom:

```bash
claude mcp add pathloom -- pathloom mcp
```

Або встанови плагін (MCP-сервер + skill, що вчить агента робочого процесу):

```
/plugin marketplace add XxArDy/Pathloom
/plugin install pathloom@pathloom
```

Далі просто проси у своєму проєкті:

> Сплануй MVP у Pathloom: етапи для бекенду, фронтенду й релізу, із залежностями.

> Що я можу робити далі?

> Познач задачі логіну виконаними й залиш нотатку, що змінилося.

### Codex, Gemini CLI, Cursor, Copilot та інші

**Codex CLI**

```bash
codex mcp add pathloom -- pathloom mcp
```

або в `~/.codex/config.toml`:

```toml
[mcp_servers.pathloom]
command = "pathloom"
args = ["mcp"]
```

**Gemini CLI** (`~/.gemini/settings.json` або `.gemini/settings.json` у проєкті)

```json
{ "mcpServers": { "pathloom": { "command": "pathloom", "args": ["mcp"] } } }
```

**Cursor** (`.cursor/mcp.json` у проєкті або `~/.cursor/mcp.json`)

```json
{ "mcpServers": { "pathloom": { "command": "pathloom", "args": ["mcp"] } } }
```

**VS Code з GitHub Copilot** (режим агента, `.vscode/mcp.json` у проєкті)

```json
{ "servers": { "pathloom": { "type": "stdio", "command": "pathloom", "args": ["mcp"] } } }
```

**Claude Desktop** (Settings → Developer → Edit Config): той самий блок `mcpServers`, що й для Cursor. Claude Desktop запускає
сервер не в папці проєкту, тож додай шлях: `"args": ["--project", "D:/code/my-app", "mcp"]`.

**Навчи агента працювати з планом.** Claude Code отримує це з плагіна. Для інших агентів один раз виконай у проєкті:

```bash
pathloom skill install
```

Команда створює `.agents/skills/pathloom/SKILL.md` (відкритий формат Agent Skills, його читають Codex, Gemini CLI, Cursor, Copilot
та інші). Можна також додати в `AGENTS.md`: *«Плануй і веди роботу через MCP-інструменти Pathloom; див. .agents/skills/pathloom/SKILL.md.»*

Над одним планом можуть працювати кілька агентів одночасно: кожен бере задачу перед роботою, а дошка показує, хто чим зайнятий.

### Що вміє агент

| Інструмент | |
|---|---|
| `project_info`, `list_stages`, `get_stage`, `search` | Читати план, не вивантажуючи цілі дошки. |
| `next` | Задачі, які можна робити зараз, за пріоритетом і дедлайном. |
| `apply` | Створити чи змінити багато етапів, задач, залежностей, рамок і коментарів одним транзакційним викликом. |
| `set_task`, `add_comment` | Відмічати прогрес і лишати тобі нотатки. |
| `claim_task`, `release_task` | Взяти задачу, щоб інші агенти не робили те саме (захоплення спливає через 30 хв, якщо не продовжити). |
| `activity` | Що нещодавно робили інші агенти й ти. |
| `heartbeat` | «Ще працюю» під час довгих кроків; після 10 хв тиші картка показує, що агент, можливо, завис. |
| `set_gate`, `report_usage` | Звіт про перевірку гейта; за бажанням — токени й вартість. |
| `import_tasks` | Перетворити `tasks.md` з GitHub Spec Kit на етапи, задачі й залежності. |
| `layout_board`, `validate` | Впорядкувати дошку, перевірити план на проблеми. |

**Щоб дошка лишалась зрозумілою.** Увімкни *Авторозкладку* (нижня панель), і дошка сама перебудовується щоразу, коли агент змінює план; кнопка з чарівною паличкою розкладає її один раз. Наведи або вибери картку, і підсвітиться те, на що вона чекає, і те, що чекає на неї. У налаштуваннях можна вимкнути приховування зайвих стрілок і групування стрілок між фазами. Агенти отримують правила для зрозумілих планів (фази за часом, опис етапу одним реченням, 3-8 задач, лише прямі залежності), а `validate` показує `hints`, коли план їх порушує.

**Готово — значить доведено.** Агент закриває задачу разом із перевіркою, яку запускав (`set_task` з `evidence` або `pathloom task done AUTH-02 --run "cargo test"`): задача позначається як перевірена, а невдала перевірка її не закриває. У налаштуваннях можна ввімкнути *Агенти мають довести, що задача готова*. Етапи-**гейти** (`kind: gate`, `check: npm test`) виконані лише тоді, коли перевірка пройшла. Етап може мати **артефакти** (spec, plan), а «Огляд» показує **витрати**, про які звітують агенти.

**Кілька агентів одночасно.** Етап можна призначити конкретному агенту (`who: ai:claude`, `ai:codex`) або людині (`human:olia`) — у кожного свій колір. Агент «бере» задачу перед роботою; на картці видно, хто нею зайнятий, а інші агенти її пропускають. В **«Огляді»** видно, хто працює зараз, і стрічку дій агентів (`.pathloom/log/agent.jsonl`).

Хочеш спершу переглядати зміни? Увімкни **Налаштування → AI-агенти → Спершу питати мене**. Тоді зміни агента приходять як пропозиції, які ти приймаєш або відхиляєш.

## Файли

```
my-project/
  .pathloom/project.toml          налаштування (напр. agent_changes = "review")
  plan/
    stages/AUTH.md                один етап: frontmatter + список задач + коментарі
    boards/roadmap.board.json     позиції карток, малюнки, рамки (один елемент на рядок)
    assets/                       вставлені зображення
```

```markdown
---
id: AUTH
title: Авторизація
kind: stage
who: ai
priority: high
depends: [CORE]
---
## Tasks
- [x] AUTH-01 Форма входу
- [ ] AUTH-02 Збереження сесії
  - [ ] AUTH-02a Оновлення токенів
```

Редагуй їх руками, агентом або в застосунку — усе тримається в синхроні.

## CLI

```bash
pathloom init
pathloom stage add AUTH "Авторизація" --after CORE
pathloom task add AUTH "Форма входу"
pathloom task done AUTH-01
pathloom next
pathloom apply plan.yaml --dry-run
pathloom validate --fix
```

Кожна команда має `--json`. Докладніше: [crates/pathloom-cli/README.md](crates/pathloom-cli/README.md).

## Зібрати з коду

Потрібні: Rust (stable), Node.js 20+ і [залежності Tauri](https://tauri.app/start/prerequisites/) для твоєї ОС.

```bash
npm install
npm run build:cli -w @pathloom/desktop
npm run tauri dev -w @pathloom/desktop
```

Інсталятори: `npm run tauri build -w @pathloom/desktop`.

| Частина | Шлях | Стек |
|---|---|---|
| Ядро (файли, граф, стани, apply, layout) | `crates/pathloom-core` | Rust |
| CLI + MCP-сервер | `crates/pathloom-cli` | Rust, `rmcp` |
| Редактор полотна | `packages/canvas` | TypeScript, Canvas2D |
| Застосунок | `apps/desktop` | Tauri 2, React |
| Плагін Claude Code | `plugin/` | MCP + skill |

Тести: `cargo test --workspace` і `npm run test -w @pathloom/canvas`.

## Стан

Рання, але робоча версія (0.1). Перевірено на Windows. Збірки для Linux і macOS робить workflow релізу, але на реальних машинах їх ще не запускали. Що далі — у [docs/ideas.md](docs/ideas.md).

## Підтримати проєкт

Pathloom безкоштовний і відкритий. Якщо він економить тобі час, можна підтримати розробку на [Patreon](https://www.patreon.com/XxArDy) або криптовалютою.

**USDT у мережі TRON (TRC20)**:

```text
TReYVcTGY9PRW9XCSFj95JJwJ6BSxsP74W
```

**Monero (XMR)**:

```text
4ADwo8HNhcCVxSjMRzau7j3PnyF5TzMd2aBaLKJTNkqa9CRLGh9AjqALWepe5Twoe3EVypeP2euBtUVxoJgpsQtBNdjAwoJ
```

Надсилай на першу адресу лише USDT через TRC20, а на другу лише XMR: інші токени чи мережі можуть загубитися. Ті самі адреси є в профілі автора на GitHub ([@XxArDy](https://github.com/XxArDy)), звір, що вони збігаються. Дякую!

## Як долучитися

Як зібрати проєкт, які перевірки пройти й яких правил дотримуватись — у [CONTRIBUTING.md](CONTRIBUTING.md) (англійською), будова коду — у [docs/architecture.md](docs/architecture.md). Про вразливості повідомляй за [SECURITY.md](SECURITY.md).

## Ліцензія

На вибір: [MIT](LICENSE-MIT) або [Apache-2.0](LICENSE-APACHE). Якщо не вказано інше, твій внесок у проєкт ліцензується так само.

Сторонні бібліотеки та їхні ліцензії: [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md) (також у застосунку: Налаштування → Ліцензії).
