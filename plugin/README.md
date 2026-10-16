# flowreel Claude Code plugin

Skills, agents and a prerequisite check around the
[`@confidee/flowreel`](../runtime/) runtime: set a project up, inventory
its features, author flows from plans, narrate them, run the
development -> staging gate and explain the result.

The plugin never installs anything without asking, and no hook downloads
or installs anything. The verdict always belongs to Playwright: no skill or
agent decides it or edits an assertion.

## Install

The marketplace (named `flowreel`) is the `.claude-plugin/marketplace.json`
at the root of [Confidee/flowreel](https://github.com/Confidee/flowreel); it
lists this plugin with `source: ./plugin`. Add the marketplace, then install
the plugin from it:

```text
/plugin marketplace add Confidee/flowreel   # or a local clone's path
/plugin install flowreel@flowreel
```

To try it from a clone without installing: `claude --plugin-dir plugin`
(from the clone's root).

## What it adds

| Skill                 | Invoked by    | What it does                                                                            | Side effects                                                                                                                                        |
| --------------------- | ------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/flowreel:doctor`    | you only      | checks every prerequisite, explains it, offers the install command                      | installs only what you confirm, one at a time                                                                                                       |
| `/flowreel:init`      | you only      | scaffolds `flowreel.config.ts` and `e2e/flowreel/` from [templates/](templates/)        | creates files, edits package.json / .gitignore (and appends `install-links=true` to .npmrc for a local-checkout runtime) after you approve the plan |
| `/flowreel:inventory` | you only      | read-only exploration of a module -> a feature catalogue with proposed staging policies | writes the catalogue only                                                                                                                           |
| `/flowreel:author`    | you only      | plans + flows from the approved catalogue, run locally until green                      | creates/edits flow files, runs the development stage                                                                                                |
| `/flowreel:narrate`   | you only      | the spoken narration for every step                                                     | narration JSON only                                                                                                                                 |
| `/flowreel:run`       | you only      | runs the pipeline once and explains it; never retries; undo failures first              | runs tests                                                                                                                                          |
| `/flowreel:explain`   | you or Claude | reads a finished run, classifies each failure, proposes locator-only fixes              | none                                                                                                                                                |
| `/flowreel:demos`     | you only      | publishes a demo-pace run's videos to `latest/`                                         | copies files after you confirm                                                                                                                      |

| Agent             | Tools                                              | Model  | Used by               |
| ----------------- | -------------------------------------------------- | ------ | --------------------- |
| `flow-author`     | Read, Glob, Grep, Edit, Write, Bash (unrestricted) | sonnet | `/flowreel:author`    |
| `run-explainer`   | Read, Glob, Grep (read-only)                       | sonnet | `/flowreel:explain`   |
| `catalogue-scout` | Read, Glob, Grep (read-only)                       | sonnet | `/flowreel:inventory` |

Hook: `SessionStart` (on startup) runs
[scripts/check-prereqs.sh](scripts/check-prereqs.sh): read-only, about half
a second, silent unless the project uses flowreel (a `flowreel.config.ts`,
an `e2e/flowreel/` folder or the `@confidee/flowreel` dependency), then
one line per missing item with its install command: required (Node.js,
`@playwright/test`, Chromium), `video-only` (ffmpeg, ffprobe) or
`voice-only` (macOS `say`, a Premium voice), and a last line pointing at
`/flowreel:doctor`. Each `Install:` value is a command on its own, safe to
paste (an item with no single command says `Steps:` instead). It never installs, never blocks and always exits 0.
`FLOWREEL_PREREQS=off` silences it; `FLOWREEL_PREREQS=always` runs it in
any project.

It runs every tool from `/`, never from the project. It does not run a
tool at all when the tool resolves to a version manager's shim (Volta,
mise, asdf, nodenv, proto) or to a path inside the project. Those shims
read project files: Volta's `.volta/hooks.json`, for example, can set a
download URL or run a command, so a cloned repository could otherwise make
a session-start check download and run code. Such a tool is reported as
`unchecked` by the doctor and skipped at session start; the doctor asks
you to check it in the project yourself.

Shared rules and references: [reference/never.md](reference/never.md) (the
rules every skill and agent follows), [reference/results.md](reference/results.md)
(exit codes, `pipeline.json` / `summary.json`, the report order),
[reference/flow-api.md](reference/flow-api.md) (writing flows).

## Every command the plugin may run

Read-only, without asking (pre-approved for the doctor only):

- `bash ${CLAUDE_PLUGIN_ROOT}/scripts/check-prereqs.sh [--report]`. From
  `/`, never from the project, it runs `uname`, `node --version`,
  `ffmpeg -hide_banner -encoders`, `say -v '?'` (macOS) and `command -v`,
  and skips any of those programs that resolves to a version-manager shim
  or into the project (reported as `unchecked`). It reads the project's
  `package.json` (`"type"`, the flowreel dependency),
  `node_modules/@playwright/test/package.json` and the Playwright browser
  cache folder (`node_modules/playwright-core/.local-browsers` when
  `PLAYWRIGHT_BROWSERS_PATH=0`), and otherwise uses only standard
  read-only shell utilities (`ls`, `readlink`, `sed`, `grep`, `head`, `tr`,
  `cut`, `basename`, `printf`, `echo`). It writes nothing.

Every other command goes through Claude Code's normal permission prompt,
and the skills ask in the conversation first:

| Command                                                                                                                          | Skill                                        |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `brew install node` / `ffmpeg`; `brew install libpq && brew link --force libpq`; `sudo apt install ffmpeg` / `postgresql-client` | doctor (each after a yes)                    |
| `npm i -D @playwright/test`; `npm i -D @playwright/test@latest` (upgrading a version older than 1.56)                            | doctor, init (after a yes)                   |
| `node --version`, `ffmpeg -hide_banner -encoders`, `say -v '?'` in the project, for an `unchecked` item                          | doctor (through the permission prompt)       |
| `npx playwright install chromium` (macOS); `npx playwright install --with-deps chromium` (Linux: runs `apt` with sudo)           | doctor, init (after a yes)                   |
| `npm view @confidee/flowreel version`                                                                                            | init (registry lookup, after a yes)          |
| `npm i -D @confidee/flowreel tsx` (or a local path / tarball you name)                                                           | init (after a yes)                           |
| `npm run build`, `npm pack` in a flowreel runtime checkout you name                                                              | init (each after a yes)                      |
| `npx playwright test --config e2e/flowreel/playwright.config.ts --list`                                                          | init (lists, runs nothing)                   |
| the project's unit suite, e.g. `npm run flowreel:unit` (browser-free)                                                            | init, narrate, author (flow-author)          |
| the project's own typecheck, or `npx tsc -p <its tsconfig> --noEmit`, only when the project already has `typescript`             | init                                         |
| the project's pipeline script, e.g. `npm run flowreel -- --module <m> [--local] …`                                               | run, author (flow-author), narrate (offered) |
| the project's demos script, e.g. `npm run flowreel:demos -- <RUN_ID>`                                                            | demos (after a yes)                          |
| `open <video or folder>` (macOS), `npx playwright show-report <dir>`, `npx playwright show-trace <zip>`                          | run, explain (when you ask)                  |

The plugin never runs `git commit`, push, branch, stash or reset, never
reads `.env*` files or the project's secrets file, and never sends anything
anywhere: there is no telemetry.

## Requirements

Node.js 20.19+ (20.x), 22.12+ (22.x) or 23+. The runtime is ESM-only: a
project without `"type": "module"` loads its flowreel files as CommonJS
and `require()`s the runtime, which older Node versions cannot do
(`ERR_REQUIRE_ESM`). An ESM project runs on any Node 20+. The doctor and
the SessionStart check apply exactly this rule.

## Validate

From the repository root:

```bash
claude plugin validate --strict ./plugin
claude plugin validate --strict .   # the marketplace
bash plugin/scripts/check-templates.sh   # both scaffold shapes: tsc + unit suite
```

The leak tripwire (`scripts/check-leaks.mjs`, run first by `npm test` in
`runtime/`) scans the whole repository, this plugin included, for the
publisher's name outside its allowlisted tokens and for the patterns a
consuming project supplies (`FLOWREEL_LEAK_PATTERNS_FILE`). CI runs all of these on every
push and pull request (`.github/workflows/ci.yml`).
