# Contributing to Pathloom

Thanks for helping! This guide gets you from a fresh clone to a merged change. For how the code is organised, read
[docs/architecture.md](docs/architecture.md); the full list of documents is in [docs/README.md](docs/README.md).

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Rust | stable, 1.85+ (edition 2024) | `rustup` recommended; `clippy` component |
| Node.js | 22+ | npm workspaces |
| Windows | WebView2 runtime | preinstalled on Windows 10/11 |
| macOS | Xcode Command Line Tools | |
| Linux | `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf` | Debian/Ubuntu package names |

More detail for each OS: [Tauri prerequisites](https://tauri.app/start/prerequisites/).

## First run

```bash
git clone https://github.com/XxArDy/Pathloom.git
cd Pathloom
npm install
npm run build:cli -w @pathloom/desktop   # builds the `pathloom` CLI the app bundles (needed once before tauri dev)
npm run tauri dev -w @pathloom/desktop   # the desktop app with hot reload
```

Other entry points:

```bash
cargo run -p pathloom-cli -- --help      # the CLI
cargo run -p pathloom-cli -- mcp         # the MCP server (stdio), run inside a project folder
npm run dev -w @pathloom/canvas          # the canvas alone in a browser test bench
```

## Checks before a pull request

All of these must pass (CI runs the same):

```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
npm run test -w @pathloom/canvas
npm run typecheck -w @pathloom/canvas
npm run typecheck -w @pathloom/desktop
npm run licenses                         # dependency license check, regenerates THIRD-PARTY-LICENSES.md
```

For UI changes, also try the change in the running app (`npm run tauri dev`), in both the Graphite and Light themes and in
both languages.

## Ground rules

These keep the project safe for users and maintainable:

- **User files are the source of truth.** The plan lives in `plan/` and `.pathloom/` inside the user's project. Every write goes
  through the atomic writer in `pathloom-core` (`write_atomic`), and Pathloom never rewrites text it does not manage
  (unknown frontmatter keys and free Markdown are kept byte for byte).
- **Stage status is computed, never stored.** `done / active / ready / blocked` comes from tasks and dependencies.
- **One core, three doors.** Plan logic belongs in `crates/pathloom-core`; the CLI, the MCP server and the app call it. Do not
  re-implement rules in TypeScript or in a single front end.
- **Rust:** errors with `thiserror`, no `unwrap()`/`expect()` outside tests, clippy clean. The project follows the
  [`rust-skills`](.claude/skills/rust-skills) guidelines.
- **UI strings** go through i18n only: add every key to both `apps/desktop/src/locales/en.json` and `uk.json`.
- **File formats and MCP tools are public contracts** (`pathloom/1`). Additive changes only; document them in the matching
  `docs/m*-contracts.md` file. A breaking change needs a new protocol version.
- **Tests come with the change**: new logic in core gets a Rust test, canvas logic a Vitest test.

## Dependencies and licenses

Pathloom is MIT OR Apache-2.0, so everything it ships must be compatible:

- Allowed: MIT, MIT-0, Apache-2.0, BSD-2/3-Clause, ISC, 0BSD, Zlib, CC0-1.0, Unlicense, Unicode-3.0, BSL-1.0.
- Allowed with conditions: **MPL-2.0** only for unmodified third-party code; **OFL-1.1** only for fonts.
- Not allowed: GPL, LGPL, AGPL, SSPL, "source-available" / custom licenses, packages without a license.

Before adding a dependency, check its license, prefer small well-maintained packages, and run `npm run licenses`. It fails on a
license outside the list and regenerates [`THIRD-PARTY-LICENSES.md`](THIRD-PARTY-LICENSES.md) (commit the updated file; the app
installer ships it). Background and rejected alternatives: [docs/research.md](docs/research.md).

## Commits and pull requests

- Small, focused pull requests; one topic each.
- Commit messages: a short imperative summary line, then what changed and why.
- Describe user-visible changes in the pull request; screenshots for UI changes.
- By contributing you agree that your contribution is licensed under MIT OR Apache-2.0, like the rest of the project.

## Releases

CI and releases are manual GitHub Actions workflows (`Actions → CI / Release → Run workflow`). The release workflow builds
Windows, macOS and Linux installers into a draft release. Installers are not code-signed yet, so Windows SmartScreen and macOS
Gatekeeper show a warning.

## Reporting problems

Bugs and ideas: GitHub issues. Security problems: see [SECURITY.md](SECURITY.md), please do not open a public issue.
