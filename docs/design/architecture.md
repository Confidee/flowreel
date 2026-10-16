# flowreel architecture

This page describes how flowreel is built: what it is made of, the
principles every part keeps, the interfaces a project implements, and what
is deliberately out of scope. [decisions.md](decisions.md) records the
decisions behind it and why they were made. For how to _use_ flowreel,
start with the [README](../../README.md) and [Concepts](../concepts.md).

- [What flowreel is](#what-flowreel-is)
- [Design principles](#design-principles)
- [Who it is for](#who-it-is-for)
- [The parts](#the-parts)
- [Public interfaces](#public-interfaces)
- [Configuration and environment](#configuration-and-environment)
- [The plugin](#the-plugin)
- [Prerequisites](#prerequisites)
- [Security posture](#security-posture)
- [Repository layout](#repository-layout)
- [Out of scope](#out-of-scope)
- [Roadmap](#roadmap)
- [Risks and how they are handled](#risks-and-how-they-are-handled)

## What flowreel is

flowreel turns plain-English feature plans into **deterministic Playwright
flows that double as narrated, branded videos**. One command runs an app's
features on a development target first and, only if they pass, on staging.
A run produces a pass/fail report (the release gate), an evidence trail,
and demo or training videos with a spoken explanation of every step.

It ships as three things that work together:

| Part                                                             | What it is                                                                                                                                                          | Who uses it                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| **`@confidee/flowreel`** (npm runtime)                           | The engine: the run pipeline (development -> staging gate), the feature/policy wrapper, personas, the undo ledger, mail drivers, the reporter, videos and narration | A project's test code and CI      |
| **Adapters** (`@confidee/flowreel/rails-inertia`, `/mail-graph`) | Optional stack-specific pieces: the Inertia props reader and the test-seam client (plus a Rails seam kit as templates); a Microsoft 365 mailbox driver              | Projects on those stacks          |
| **`flowreel` Claude Code plugin**                                | Skills, agents and a read-only hook: check prerequisites, scaffold, inventory a module's features, author flows from plans, narrate, run and explain, publish demos | Developers working in Claude Code |

## Design principles

1. **The verdict is deterministic.** Only Playwright assertions decide PASS
   or FAIL. AI writes plans, flows and narration and explains results; it
   never decides a verdict and never edits an assertion to make a run pass.
2. **Safe by default.** Production hosts are refused; mail can only go to
   an explicitly configured domain; sign-ins and mail sends are never
   retried; every change to shared configuration goes through a
   write-ahead undo ledger with a non-zero exit when a restore fails;
   features that are unsafe on staging are skipped by policy, not by
   convention.
3. **Brand-neutral core.** Nothing product-specific lives in the runtime,
   the plugin, the docs or the examples. A project's names, hosts, colours
   and logos live in its own adapter; flowreel's first user plugs in like
   any other project.
4. **Local-first, no telemetry.** Runs, videos and voice synthesis happen
   on the developer's machine or in CI. Nothing is sent anywhere the
   project did not configure.
5. **Ask before installing.** The plugin detects missing tools and explains
   them; it installs nothing without the user's confirmation, and no hook
   ever does.

## Who it is for

- **A developer after a deploy**: "test checkout on staging" gives a gate
  verdict and what broke, with the video of the failing step.
- **QA and product**: a full narrated tour of a module for review,
  regression evidence for change management, or release notes.
- **Training and sales**: demo-pace narrated videos per feature area,
  regenerated after UI changes.
- **A project adopting it**: `/flowreel:doctor` -> `/flowreel:init` ->
  `/flowreel:inventory` (a feature catalogue) -> `/flowreel:author` (flows
  from plans) -> `/flowreel:run`.

## The parts

```text
your project
├── flowreel.config.ts         targets, allowlist, personas, modules, brand, mail, voice
├── e2e/flowreel/
│   ├── adapter.ts             AppAdapter: sign-in/out, health, app-specific waiters
│   ├── plans/<module>.md      the human contract (feature ids, steps, policy)
│   ├── flows/<module>/*.spec.ts
│   ├── texts/*.json, narration/*.json
│   └── brand/                 logos
└── flowreel-results/<RUN_ID>/, flowreel-demos/latest/   (git-ignored)

@confidee/flowreel (runtime; each line is a subpath; the root re-exports them all except
/reporter, /demos and the adapters /rails-inertia and /mail-graph)
├── core        errors, poll, env names and aliases, undo ledger, cross-run inbound ledger
├── config      defineConfig(), target allowlist (loopback-only local, production refused),
│               secrets file loader (owner-only check), createConfig() (the Playwright config)
├── app         AppAdapter, personas and the storageState handoff, global setup/teardown,
│               session revocation, bounded keepalive
├── run         run ids, texts (TextsSource), round-robin counter, off-camera cleanup
│               rules (CleanupAdapter; the per-test fixture stays project-side)
├── tour        TourManifest, catalogue and static tripwire, feature() policy wrapper
│               (both | dev | view | both+undo), pace, inbound budget, tourFixtures(),
│               tourModuleFrom() (the reporter's TourModule from the same constants)
├── pipeline    development -> staging stages, gate, exit codes (0/1/2/3/4/64/130), DbIsolation
├── mail        MailDriver contract, matcher, send-domain guard
├── reporter    summary.md/json, feature table, undo section, ModuleDescriptor
├── video       timeline, cards (Brand + CardCopy), ffmpeg composer, run/tour/pipeline reels
├── voice       VoiceEngine (macOS `say` | none), narration resolution, clip cache
├── demos       publish a run's videos to <demos>/latest with a README
└── cli         the commands a project calls from its own entry files
   adapters:  /rails-inertia (InertiaPropsReader, seamSignIn, HttpSeamMailDriver)
              /mail-graph (GraphMailDriver)

flowreel plugin (Claude Code)
├── skills:    doctor, init, inventory, author, narrate, run, explain, demos
├── agents:    flow-author, run-explainer, catalogue-scout
├── hook:      SessionStart, a read-only prerequisite check
└── templates: config, adapter, plan, texts, narration, env.example, Rails seam kit
```

The runtime has **no runtime dependencies**. `@playwright/test` is a peer
dependency the project chooses; anything else a feature needs (such as the
TypeScript compiler API for the tour's static tripwire) is passed in by the
project and typed structurally.

## Public interfaces

These are the contracts a project (or an adapter) implements. The
[Adapters guide](../adapters.md) documents each one in full.

| Interface            | Purpose                                                                                                                                                                                      | Shipped implementations                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `AppAdapter`         | `signIn(ctx, key, persona)`, `signOut`, `isSignedOut(response)` and `keepalivePath` (read by `tourFixtures`), `health()` (optional, reserved for a generic preflight), `prepareLocal()`      | the example's adapter; `seamSignIn()` for apps with the Rails seam kit            |
| `MailDriver`         | `send`, `waitFor`, `reply`, `health`, `saveEml`                                                                                                                                              | `GraphMailDriver` (Microsoft 365), `HttpSeamMailDriver` (the local seam protocol) |
| `DbIsolation`        | `create(key)`, `drop(key)` for a per-run database                                                                                                                                            | none: a project supplies its own (for example a Postgres template clone)          |
| `CleanupAdapter`     | find and close a run's leftover records off-camera. The runtime owns the rules (`cleanupCandidates` / `cleanUpRunRecords`); the per-test fixture that calls them stays in the project        | none: a project supplies the number shape and the `solve` functions               |
| `Brand` / `CardCopy` | logos, colours, product name, titles, latency labels                                                                                                                                         | `NEUTRAL_BRAND` (no logo) and the default copy                                    |
| `VoiceEngine`        | `available()`, `synthesize()`                                                                                                                                                                | macOS `say` with a Premium voice when one is installed; `none` (silent videos)    |
| `ModuleDescriptor`   | the flow project(s), plan file, verdict rule and demo names of a module (`RoundTripModule` \| `TourModule`), read by `SummaryReporter`                                                       | built by the project; `tourModuleFrom()` derives a tour's from its `TourManifest` |
| `DemoCatalogue`      | the latest/ folder, the run-id pattern and run folder, the development target, the modules whose demos it publishes, the README copy; `demoPublisher()` binds the planning and copying to it | built by the project                                                              |
| `TourManifest`       | areas, features and the per-feature staging policy (the catalogue)                                                                                                                           | built by the project; the example has one area with three features                |

Interfaces exist only where there is already more than one implementation
or a clear second user. Everything else stays concrete until a second user
needs it.

## Configuration and environment

- One `defineConfig()` file instead of scattered constants
  ([Configuration](../configuration.md)).
- Environment variables use the `FLOWREEL_` prefix (`FLOWREEL_TARGET`,
  `FLOWREEL_PACE`, `FLOWREEL_VOICE`, ...). A project can keep its own older
  names working with `registerEnvAliases()`; flowreel registers none
  itself.
- Secrets come from the process environment (recommended: a password
  manager injecting them for one run) or an owner-only (`0600`) file
  outside the repository. The target is never read from the secrets file,
  and a local run never reads it.
- The keys that decide what a run _is_ (`TARGET`, `RUN_ID`, `MODULE`) are
  refused when `FLOWREEL_<KEY>` and a project alias are set to different
  values. The Playwright config writes the settled run id and module under
  every name, so every reader sees one value.

## The plugin

| Skill                                                                | What it does                                                                                                                                      | Side effects                                                   |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `/flowreel:doctor`                                                   | checks every prerequisite, explains what each is for, offers the exact install command                                                            | installs only after the user confirms (user-invoked only)      |
| `/flowreel:init`                                                     | adds `@confidee/flowreel` as a dev dependency, scaffolds `flowreel.config.ts`, `e2e/flowreel/`, `.gitignore` entries and an env template          | edits `package.json` and creates files after showing the plan  |
| `/flowreel:inventory <module>`                                       | read-only exploration of the app -> a feature catalogue with entry points, setup, assertions, undo and a proposed staging policy                  | writes the catalogue only (user-invoked only)                  |
| `/flowreel:author <module> [features]`                               | writes plans and flows from the approved catalogue against the flow API; runs them on the development stage until green                           | creates and edits flow files, runs the app (user-invoked only) |
| `/flowreel:narrate <module>`                                         | writes the spoken narration for every step (teaching tone; never ids, tokens or addresses)                                                        | narration JSON only (user-invoked only)                        |
| `/flowreel:run <module> [--local\|--staging-only] [--pace demo\|qa]` | runs the pipeline and explains the result; never retries; reports undo failures first                                                             | runs tests (user-invoked only)                                 |
| `/flowreel:explain [run]`                                            | reads the summary and pipeline JSON, the failing step's `error-context.md` and screenshot (never the trace archives); proposes locator-only fixes | none                                                           |
| `/flowreel:demos <RUN_ID>`                                           | publishes a run's videos to `latest/` with a README                                                                                               | copies files after a yes (user-invoked only)                   |

Agents: `flow-author` (writes one area's flows against the API),
`run-explainer` (reads results, never edits assertions), `catalogue-scout`
(read-only inventory). The `SessionStart` hook runs a fast read-only check
and prints one line per missing prerequisite with its install command; it
never installs and never blocks. [The plugin page](../plugin.md) lists every
command the plugin may run.

## Prerequisites

| Tool                                                       | Why flowreel needs it                              | Required?         |
| ---------------------------------------------------------- | -------------------------------------------------- | ----------------- |
| Node.js >= 20 (20.19+ / 22.12+ for a CommonJS project)     | the runtime                                        | yes               |
| `@playwright/test` >= 1.56                                 | runs and records flows                             | yes               |
| Playwright Chromium                                        | the browser that is recorded                       | yes               |
| ffmpeg and ffprobe with `libx264` and AAC                  | composes MP4s, mixes audio, probes                 | for videos        |
| macOS `say` and a Premium voice                            | narration                                          | for voice (macOS) |
| A voice engine on Linux or CI                              | narration off macOS                                | not yet shipped   |
| `psql`                                                     | per-run database clones (a Postgres `DbIsolation`) | optional          |
| A Microsoft 365 app with mail access scoped to one mailbox | real email checks on staging (`mail-graph`)        | optional          |

[Getting started](../getting-started.md#1-prerequisites) has the install
commands for each OS. For the Microsoft 365 app, the
[mail-graph guide](../adapters.md#mail-graph-microsoft-365) documents
scoping with RBAC for Applications in Exchange Online (an existing
application access policy also works).

## Security posture

[SECURITY.md](../../SECURITY.md) is the full statement, and
[Safety](../safety.md) explains each rule. In short:

- Production hosts are refused; staging hosts are an exact allowlist; the
  local target is a loopback host on a fixed port range.
- The mail send guard allows one configured domain, exact match, checked
  before any network call.
- Test seams (the Rails kit) are routed only in test and development behind
  an explicit flag, and every seam ships a request spec proving both 404
  paths.
- Sign-ins and mail sends are never retried; sessions are signed out at
  teardown; the keepalive is bounded.
- A write-ahead undo ledger; exit code 4 on a failed restore.
- Videos redact email-card tokens and, on staging, blur table rows that do
  not belong to the run. Results folders are credential-bearing and
  documented with a retention rule.
- No telemetry; no network calls except to the configured targets, mail
  provider and voice provider.
- The plugin's hook installs and downloads nothing; every command the
  plugin may run is listed; `claude plugin validate --strict` runs in CI.

## Repository layout

```text
.
├── .claude-plugin/marketplace.json   the "flowreel" marketplace, listing ./plugin
├── .github/                          CI, the release workflow, issue and PR templates
├── runtime/                          @confidee/flowreel: src/, test/, scripts/, build -> dist/
├── plugin/                           .claude-plugin/plugin.json, skills/, agents/, hooks/,
│                                     scripts/, templates/, reference/
├── docs/                             the guides, and design/ (this page, decisions.md)
├── examples/minimal/                 a tiny static app and three flows, no Rails
└── scripts/                          check-leaks.mjs (brand-neutrality tripwire),
                                      check-version.mjs (release versions)
```

## Out of scope

Not built in 0.x: voice engines for Linux and CI (designed for: the
`VoiceEngine` interface and a silent fallback), mail drivers other than
Microsoft 365 and the HTTP seam (Mailpit or IMAP later), seam kits for
stacks other than Rails, parallel stage execution, hosted dashboards, cloud
recording, and an AI-driven exploratory mode (the deterministic core comes
first).

## Roadmap

Done: the runtime is published to npm from GitHub Actions with trusted
publishing and provenance (0.2.0, see [RELEASING.md](../../RELEASING.md)).

1. A `flowreel` command-line binary, so a project no longer wires the
   exported commands into its own entry files.
2. A voice engine off macOS (Piper or a cloud speech service).
3. A second proof outside the first user: the minimal example plus one
   external app.
4. Submission to Anthropic's plugin directory.

## Risks and how they are handled

| Risk                                                  | Mitigation                                                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Breaking a working harness while extracting it        | phased moves with a full run as the gate after every phase; no behaviour change in the same change as a move              |
| Over-generalising too early                           | interfaces only where there are already two implementations or a clear second user                                        |
| Plugin install limits (no postinstall, registry-only) | the runtime is a normal dev dependency, installed by `/flowreel:init` with consent, never by the plugin                   |
| macOS-only narration                                  | the engine interface and a `none` fallback; silent videos are still produced                                              |
| Product specifics leaking into the public core        | `scripts/check-leaks.mjs` scans the whole repository in CI and in `npm test`, with patterns the project supplies          |
| A compromised publish credential                      | no long-lived npm token exists: releases publish through npm trusted publishing (OIDC) from one workflow, with provenance |
