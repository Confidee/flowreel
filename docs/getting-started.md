# Getting started

This guide takes a web app with no flowreel in it to a first green
development run with a video. Allow about 30 minutes, most of it installing
tools.

You can do it with the Claude Code plugin, where the doctor and init skills
do the checking and scaffolding for you, or by hand. Both paths are below.

- [1. Prerequisites](#1-prerequisites)
- [2. Install the plugin](#2-install-the-plugin)
- [3. Check your machine: `/flowreel:doctor`](#3-check-your-machine-flowreeldoctor)
- [4. Scaffold the project: `/flowreel:init`](#4-scaffold-the-project-flowreelinit)
- [5. Describe a module: inventory and plans](#5-describe-a-module-inventory-and-plans)
- [6. First run](#6-first-run)
- [7. Read the result](#7-read-the-result)
- [8. Wire it by hand (no plugin)](#8-wire-it-by-hand-no-plugin)
- [9. Next steps](#9-next-steps)

## 1. Prerequisites

flowreel runs on your machine (or a CI runner) and installs nothing on its
own. Please install the tools below before your first run. Each entry says
why flowreel needs it, whether it is required, and the exact commands for
each OS.

Supported platforms: **macOS** (every feature, including narration) and
**Linux** (everything except narration, so videos are silent). On
**Windows**, use WSL2 with Ubuntu and follow the Linux commands.
Native Windows has not been tested.

### 1.1 Node.js 20.19+ or 22.12+ (required)

**Why:** the runtime, Playwright and the pipeline all run on Node. The
runtime is an ES module package (ESM only), and which Node versions work
depends on how your project loads its test files:

| Your `package.json`                         | Node versions that work                       |
| ------------------------------------------- | --------------------------------------------- |
| has `"type": "module"`                      | any 20 or later                               |
| has no `"type"` (CommonJS, the npm default) | 20.19+ (20.x), 22.12+ (22.x), or 23 and later |

In a CommonJS project, Playwright compiles your flows to CommonJS and
loads the runtime with `require()`. Only the versions in the second row
can `require()` an ES module; older ones stop with `ERR_REQUIRE_ESM`.
Node 21 never can. If you are on an older Node, upgrade Node rather than
adding `"type": "module"`: that setting changes how every `.js` file in
your project loads. The plugin's doctor applies exactly this rule.

Node 20 reached end-of-life on 2026-04-30. flowreel still tests it, as
best effort only (see [SECURITY.md](../SECURITY.md#supported-versions)).

Please install the current LTS (22 or later):

| OS              | Command                                                                                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS           | `brew install node@22` (then follow brew's PATH hint), or [nvm](https://github.com/nvm-sh/nvm): `nvm install --lts`                                                              |
| Ubuntu / Debian | install [nvm](https://github.com/nvm-sh/nvm#installing-and-updating), then `nvm install --lts` (recommended; distro packages are often older than 20)                            |
| Fedora          | `sudo dnf install nodejs` (check that `node --version` meets the table above), or install [nvm](https://github.com/nvm-sh/nvm#installing-and-updating), then `nvm install --lts` |
| Windows (WSL2)  | inside Ubuntu: install [nvm](https://github.com/nvm-sh/nvm#installing-and-updating), then `nvm install --lts`                                                                    |

Check: `node --version` prints `v22.12` or later (or a version from the
table above that matches your project).

### 1.2 Playwright test runner, 1.56 or later (required)

**Why:** flowreel is a layer on Playwright Test. Your flows are Playwright
tests, and flowreel builds your Playwright config, global setup, teardown
and reporter. `@playwright/test` is a peer dependency, so your project
chooses the version.

Please add it to your project (same on every OS):

```bash
npm install --save-dev @playwright/test@latest
```

Check: `npx playwright --version` prints `Version 1.56` or later.

### 1.3 Playwright Chromium (required)

**Why:** the flows run, and are recorded, in Chromium. The video cards
(title, captions, email cards, scoreboards) are also drawn as HTML and
rendered to PNG in Chromium.

Please install the browser:

| OS           | Command                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------- |
| macOS        | `npx playwright install chromium`                                                             |
| Linux / WSL2 | `npx playwright install --with-deps chromium` (also installs system libraries; asks for sudo) |

### 1.4 ffmpeg and ffprobe with `libx264` and AAC (required for videos)

**Why:** ffmpeg cuts the recording, overlays the captions, inserts the cards,
mixes the narration and encodes the H.264 MP4 with AAC audio. ffprobe measures recordings
and voice clips. Playwright's bundled ffmpeg only writes `.webm` files and
is not enough. Without ffmpeg your runs still work and still have a verdict:
the summary just says `video: not produced (ffmpeg not found on PATH …)`.

Please install it:

| OS              | Command                                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| macOS           | `brew install ffmpeg`                                                                                                       |
| Ubuntu / Debian | `sudo apt update && sudo apt install ffmpeg`                                                                                |
| Fedora          | enable [RPM Fusion](https://rpmfusion.org/Configuration) (the Fedora build lacks `libx264`), then `sudo dnf install ffmpeg` |
| Windows (WSL2)  | inside Ubuntu: `sudo apt install ffmpeg`                                                                                    |

Check both tools and both encoders (the plugin's check reports ffmpeg as
`video-only`, not `missing`, when either encoder is absent: the verdict
never needs ffmpeg, only the videos do):

```bash
ffmpeg -hide_banner -version | head -1
ffprobe -hide_banner -version | head -1
ffmpeg -hide_banner -encoders | grep -E ' aac |libx264'
```

### 1.5 A voice (optional, macOS only for now)

**Why:** with narration turned on, a voice explains each step. On macOS
flowreel uses the built-in `say` command with a downloaded high-quality
voice. On other
platforms there is no voice engine yet, so the videos are silent and the
summary says why. Piper and Azure Speech engines are designed for but not
built.

**Optional, and for personal projects only.** Apple licenses its system
voices for personal, non-commercial use only. Narration is off unless you
turn it on; for a video you will use at work or share, read
[Voices and licensing](narration-and-videos.md#voices-and-licensing) first.

To narrate personal projects, download a Premium voice once per Mac:

1. Open **System Settings → Accessibility → Read & Speak** (**Spoken
   Content** on older macOS).
2. Next to **System voice**, choose **Manage Voices…**.
3. Under **English**, download **Ava (Premium)**. Zoe (Premium) and
   Jamie (Premium) also work.

Check: `say -v '?' | grep Premium` lists the voice. Without a Premium or
Enhanced voice, flowreel falls back to Samantha and says so in the summary.

### 1.6 `psql` (optional)

**Why:** only if you give each development run its own Postgres database
(see [DbIsolation](adapters.md#dbisolation)). Your clone script will
probably call `psql` or `createdb`. Skip this if your app uses another
database or none.

| OS              | Command                                         |
| --------------- | ----------------------------------------------- |
| macOS           | `brew install libpq && brew link --force libpq` |
| Ubuntu / Debian | `sudo apt install postgresql-client`            |
| Fedora          | `sudo dnf install postgresql`                   |

### 1.7 A Microsoft 365 mail app (optional, staging email checks)

**Why:** only if your flows check real email on staging through a
Microsoft 365 mailbox (the `mail-graph` driver). It needs an Entra app
registration that can reach exactly one QA mailbox. A tenant admin sets it
up. The steps are in [Adapters: mail-graph](adapters.md#mail-graph-microsoft-365).

### 1.8 Claude Code (optional, for the plugin)

**Why:** the plugin's doctor, init, inventory, author, narrate, run, explain
and demos commands run inside Claude Code. The runtime works without it.

Please install it as described in the
[Claude Code documentation](https://code.claude.com/docs/en/setup),
which gives the current install command for each OS. Any version with
`/plugin` (and `claude plugin` in a terminal) works; CI validates the
plugin with the Claude Code version pinned in `.github/workflows/ci.yml`.

## 2. Install the plugin

The plugin is distributed through a Claude Code marketplace named
`flowreel`. In Claude Code:

```text
/plugin marketplace add Confidee/flowreel
/plugin install flowreel@flowreel
```

[Installing the plugin](team-install.md) also covers installing from a
clone and enabling the plugin for a whole project. See
[plugin.md](plugin.md) for what the plugin contains and every command it
may run. Restart Claude Code (or start a new
session) after installing, so the plugin's skills load.

## 3. Check your machine: `/flowreel:doctor`

```text
/flowreel:doctor
```

The doctor runs the plugin's read-only check script in report mode, then
shows a table: each tool, whether it was found (with its version), what
flowreel uses it for, and the install command for your OS. For each missing
tool it proposes the command and asks you which ones to run. It runs only
the commands you confirmed, one at a time, and shows each one before
running it. It never uses `sudo`, a pipe-to-shell installer or a global
`npm i -g` unless you confirmed that exact command. The Premium voice
cannot be installed from a terminal, so the doctor gives you the System
Settings steps and waits.

The plugin also runs the same check, read-only, when a Claude Code session
starts in a project that uses flowreel. It prints one line per missing
tool, with its install command, and stays silent otherwise. It never
installs anything and never blocks the session. Set `FLOWREEL_PREREQS=off`
to silence it, or `=always` to run it in every project.

## 4. Scaffold the project: `/flowreel:init`

```text
/flowreel:init            # the round trip only
/flowreel:init --tour     # also scaffold a feature tour
```

init reads your project first (package.json, how the app starts, the
sign-in page, your production and staging hosts) and proposes answers to a
short round of questions: the staging origin, every production host, a
local port range and start command, how sign-in and sign-out work, the
personas and their seeded development accounts, the module names, and a
product name and colour for the videos.

It then shows the full plan: every file it will create, the
`package.json` and `.gitignore` edits, and for a runtime from a local
checkout the `install-links=true` line for `.npmrc`. **Nothing is written until you say
yes**, and a no to one part skips only that part. It never overwrites an
existing file. If flowreel files already exist, it stops and shows them.
If your Node version cannot load the runtime from a CommonJS project (see
[1.1](#11-nodejs-2019-or-2212-required)), the plan says so and leaves the
choice to you: upgrade Node, or add `"type": "module"` yourself.

What it creates, from the plugin's templates:

```text
your-project/
├── flowreel.config.ts               defineConfig(): targets, modules, personas, secrets, results
├── e2e/flowreel/
│   ├── adapter.ts                   AppAdapter: sign-in/out, health, prepareLocal; staging secrets
│   ├── playwright.config.ts         createConfig(): projects per module, the local web server
│   ├── global-setup.ts              signs each persona in once
│   ├── global-teardown.ts           signs every persona out
│   ├── brand.ts                     the video kit: brand, card copy, narration folder
│   ├── modules.ts                   module descriptors, demo catalogue, reporter options
│   ├── reporter.ts                  the SummaryReporter subclass
│   ├── pipeline.ts                  the development -> staging pipeline command
│   ├── demos.ts                     the publish-demos command
│   ├── fixtures.ts                  the round trip's test, note(), couldNotCheck(), text()
│   ├── flows/smoke.spec.ts          the round trip (the release gate)
│   ├── plans/smoke.md               its plan: the step table is the source of the step ids
│   ├── texts/smoke.json             every string it types or sends
│   ├── narration/smoke.json         what its video says
│   ├── env.example                  the shape of the staging secrets, never values
│   ├── unit.config.ts, unit/        the browser-free unit suite (narration keys vs step titles)
│   │   (with --tour)
│   ├── tour.ts                      tour manifest, catalogue mirror, feature(), the tour's test
│   ├── CATALOGUE.md                 the feature catalogue (owner-approved policies)
│   ├── flows/tour/setup.spec.ts     the tour's setup project
│   ├── flows/tour/a-<slug>.spec.ts  area A, one test per feature
│   ├── unit/tour.spec.ts            CATALOGUE.md vs its mirror; each area's narration keys
│   └── plans|texts|narration/tour-a.*
├── flowreel-results/                per-run evidence (git-ignored, credential-bearing)
├── flowreel-demos/latest/           published demo videos (git-ignored)
└── .flowreel/                       the voice clip cache (git-ignored)
```

Without `--tour`, init writes the round-trip-only versions of
`flowreel.config.ts`, `playwright.config.ts`, `modules.ts` and
`pipeline.ts`: one module, and `--area` / `--pace` refused with "This
project has no feature tour". To add the tour later, run
`/flowreel:init --tour` again: it finds your existing files, overwrites
none of them, and offers the missing pieces as diffs for you to accept.

<!-- TODO(verify): walk through adding the tour to an existing round-trip
scaffold with init (the four round-trip-only files need diffs, not new
files). -->

`package.json` gains dev dependencies (`@confidee/flowreel`, `tsx`, and
`@playwright/test` if missing) and three scripts:

```json
"flowreel": "tsx e2e/flowreel/pipeline.ts",
"flowreel:demos": "tsx e2e/flowreel/demos.ts",
"flowreel:unit": "playwright test --config e2e/flowreel/unit.config.ts"
```

Installing asks again, separately. Init first asks whether to check the
registry (`npm view @confidee/flowreel version`, its own yes). If the
runtime is there, it proposes `npm i -D @confidee/flowreel tsx`. If not (or
you say no), it asks where the runtime should come from (a local clone of
[Confidee/flowreel](https://github.com/Confidee/flowreel) or an `npm pack`
tarball) and never guesses a registry or URL. Building the runtime in that
clone (`npm run build`, or `npm pack`) is a separate yes.

For a local clone, init proposes `npm i -D <path to the clone>/runtime`. npm installs a path as a
**link** by default, and a linked runtime stops Playwright with "Requiring
@playwright/test second time". So before that install, init asks to add
`install-links=true` to your project's `.npmrc` (one appended line, its
own yes); if you say no, it offers the tarball instead. See
[Install commands](plugin.md#install-commands-only-after-your-yes-one-at-a-time).

Finally init checks the result without side effects:

- `npx playwright test --config e2e/flowreel/playwright.config.ts --list`
  loads the config and lists the flows, without signing in or starting a
  server;
- `npm run flowreel:unit` runs the browser-free unit suite;
- a type check, only if your project already has `typescript` (your own
  typecheck script, or `npx tsc -p <your tsconfig> --noEmit`). Without
  `typescript` installed, init never runs `npx tsc`: that would download
  an unrelated package named `tsc`.

It then lists every `TODO(flowreel)` marker you still need to fill in, by
file.

## 5. Describe a module: inventory and plans

A **module** is the slice of your app one run exercises, for example
`checkout` or `admin-settings`. See [Concepts](concepts.md) for modules,
features and plans.

```text
/flowreel:inventory tour
/flowreel:author tour
```

- **inventory** explores your app read-only and writes the feature
  catalogue, `e2e/flowreel/CATALOGUE.md`. For each feature it records the
  entry point, the setup needed, what to assert, what to undo, and a
  **proposed** staging policy. You review the catalogue and approve the
  policies, because the staging policy is your decision, not the tool's.
  Then the committed mirror in `e2e/flowreel/tour.ts` (`TOUR_AREAS`,
  `TOUR_CATALOGUE`) is updated to match.
- **author** writes a plan file per area and the flows, using the flowreel
  API, then runs them locally until they are green.

To write flows yourself, see [Writing flows](writing-flows.md).

## 6. First run

Development only, on your machine:

```text
/flowreel:run smoke --local
```

or, without the plugin, the pipeline script init added:

```bash
npm run flowreel -- --local                                  # the round trip, development only
npm run flowreel -- --module tour --area A --pace qa --local # one tour area, fast (scaffolded with --tour only)
npm run flowreel                                             # development, then staging on a pass
```

What happens:

1. A pipeline id is minted (`pipe-YYYYMMDD-HHMM-xxxx`) and, if configured,
   a fresh database copy is created for the development stage.
2. Playwright starts your app on a loopback port inside your configured
   range. Global setup calls your adapter's `prepareLocal()`, then signs
   each persona in once.
3. The flows run in one worker, never retried, with a trace, screenshots
   and a recording of everything.
4. The reporter writes `summary.md`, `summary.json` and `summary.lines`,
   then composes the video. The video can never change the verdict.
5. Teardown revokes every persona session. The database copy is dropped
   (unless you pass `--keep-db`).

Use `--pace qa` while writing flows (no slow motion, no pauses, silent),
and the default `--pace demo` for the recording you want to keep.

## 7. Read the result

```text
flowreel-results/
├── pipe-20261014-0930-1a2b/        one pipeline run
│   ├── pipeline.md                 start here: both stages side by side
│   ├── pipeline.json               the same, for tools and CI
│   └── smoke-pipe-….mp4            the combined video
└── loc-20261014-0930-3c4d/         one stage (loc- development, stg- staging)
    ├── summary.md                  verdict, per-step table, timings
    ├── summary.json
    ├── summary.lines               failures as file:line for your editor
    ├── undo.md / undo.json         only if the run changed shared configuration
    ├── report/                     the Playwright HTML report
    ├── test-results/               traces, screenshots, raw recordings
    ├── video/                      cards, timeline.json, reel.json
    └── smoke-loc-….mp4             this stage's video
```

- `npx playwright show-report flowreel-results/<RUN_ID>/report` opens the
  HTML report.
- `npx playwright show-trace <trace.zip>` opens one trace.
- `/flowreel:explain` reads the latest run and explains it.

**Treat the results folder as credential-bearing.** Traces and reports
record request headers, which include session cookies. flowreel revokes
those sessions at teardown, but share only `summary.md` and `pipeline.md`,
and delete run folders once you no longer need them. See [Safety](safety.md).

## 8. Wire it by hand (no plugin)

These are the files `/flowreel:init` generates, in the order to write them.
The plugin's templates (`plugin/templates/` in this repository) are the
reference copies: every one typechecks against the runtime. The
`examples/minimal/` app shows the core wiring (config, adapter, fixtures,
tour, reporter) for a tiny static app with no Rails, without the pipeline
entry: it runs with `npx playwright test`.

1. **Install:** `npm install --save-dev @confidee/flowreel @playwright/test tsx`,
   then `npx playwright install chromium`. To try an unreleased change,
   install the runtime from a clone as a copy, never a plain link (see the
   [README](../README.md#without-the-plugin)).
2. **`flowreel.config.ts`:** `defineConfig()` with your targets, modules,
   personas, secrets and results folder
   ([Configuration](configuration.md#defineconfig-reference)).
3. **`adapter.ts`:** your `AppAdapter` (sign in once, sign out, what a
   signed-out answer looks like) and a loader for this run's personas and
   staging secrets ([Adapters](adapters.md#appadapter)).
4. **`global-setup.ts` and `global-teardown.ts`:** `createGlobalSetup()`
   and `createGlobalTeardown()` from `@confidee/flowreel/app`, over your
   adapter.
5. **`playwright.config.ts`:** `createConfig()` from
   `@confidee/flowreel/config`, with your projects, the base URL from
   `resolveBaseUrl()`, and `localWebServer()` for the development stage
   ([Configuration](configuration.md#the-playwright-config-createconfig)).
6. **`brand.ts`, `modules.ts` and `reporter.ts`:** your video kit (brand,
   card copy, narration folder) in `brand.ts`; your `ModuleDescriptor`s,
   demo catalogue and reporter options in `modules.ts`; and a
   `SummaryReporter` subclass
   ([Adapters](adapters.md#moduledescriptor),
   [Narration and videos](narration-and-videos.md#your-video-kit)).
7. **`fixtures.ts` (and `tour.ts`):** the `test` your flows import, and for
   a tour `tourFixtures()` and `feature()`
   ([Writing flows](writing-flows.md#project-fixtures)).
8. **`pipeline.ts` and `demos.ts`:** a `PipelineSpec` passed to
   `runPipelineCli()`, and `demosCli()` over your demo publisher, run with
   `tsx` from the two npm scripts above
   ([Pipeline and gates](pipeline-and-gates.md#the-pipeline-entry-point)).

The design plans a `flowreel` command-line binary
(`flowreel run | pipeline | demos | doctor | voices | init`); it has not
shipped yet (0.x). The runtime exports the command implementations (`runPipelineCli`,
`demosCli`) and your project calls them from its own entry files.

## 9. Next steps

- [Concepts](concepts.md): the mental model in one page.
- [Writing flows](writing-flows.md): `feature()`, steps, personas, undo,
  texts.
- [Narration and videos](narration-and-videos.md): your brand, your words,
  your voice.
- [Pipeline and gates](pipeline-and-gates.md): staging, CI and exit codes.
