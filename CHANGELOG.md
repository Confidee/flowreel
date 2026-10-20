# Changelog

All notable changes to flowreel are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [Semantic Versioning](https://semver.org/) (0.x: APIs may change in minor versions).

## [Unreleased]

## [0.3.0] - 2026-10-20

A stopped run keeps its evidence. CI stop signals, a pipeline that dies
and the new `--deadline` all stop the running stage the way Ctrl-C does,
so its video, trace, sign-out and report survive, and a stopped run is
never a pass. Also: the npm page's logo reads on dark themes.

### Added

- `--deadline` (or `FLOWREEL_DEADLINE`) for the pipeline: a duration from
  its start (`25m`, `90s`, `1h`, milliseconds) or a time (an ISO time with
  a zone, epoch milliseconds). At the deadline the running stage is
  stopped the way Ctrl-C stops it, no further stage starts
  (`not run (deadline reached)`) and no combined video is made (one being
  composed is stopped); exit 130, unless a FAIL (1) or an undo failure (4)
  outranks it. A deadline already past at the start runs nothing (no
  database copy, no stage). Stages get
  `FLOWREEL_DEADLINE_AT` and skip their own video when less than 60 s
  (`FLOWREEL_COMPOSE_BUDGET_SEC`) is left. No default. A bad value is a
  usage error (64). New exports: `parseDeadline`, `deadlineAt`,
  `STOP_REASONS`, `ABORTED_REASON`.
- The stage guard, `installStageGuard()` from `@confidee/flowreel/reporter`,
  installed by the summary reporter first thing: SIGTERM (and Ctrl-Break
  on Windows) stops a run the way Ctrl-C does (or exits 130 before
  Playwright's runner listens); a stage whose pipeline is gone
  (`FLOWREEL_PIPELINE_PID`) stops itself within about a second; a hangup
  stops it gracefully when the pipeline runs in a terminal
  (`FLOWREEL_HUP=graceful`); output to a pipe whose reader is gone no
  longer crashes it. Only the first stop request becomes a Ctrl-C, so a
  later one never cuts the teardown short.
- `pipeline.json` is written ahead, with a `status`: `running` from the
  start (stages `pending`, verdict `INCOMPLETE`, `finishedAt` null),
  rewritten as each stage starts and ends, `stopping` after the first stop
  request (with `stoppedBy`), `finished` at the end and `aborted` after a
  second Ctrl-C. Every write is atomic. Any status but `finished` means
  the pipeline did not finish; the explain skill and the run-explainer
  agent say so.

### Changed

- The npm page shows the logo on its own dark card
  (`assets/brand/flowreel-mint-banner.svg`), so it reads on light and dark
  pages alike; the dark-text logo was nearly invisible where the README is
  shown on a dark theme, such as Socket (#12).
- **BREAKING:** a stage now runs Playwright's own command-line entry
  (`@playwright/test/cli`, resolved from the project) with the pipeline's
  Node, not `npx`; `npx --no-install playwright` is the fallback when the
  entry cannot be resolved, and the log says which. `stageCommand()`
  returns Playwright's arguments (`test …`) without the `npx` prefix, and
  `processIo()` adds the launcher: a custom `PipelineIo.runChild` must do
  the same. `playwrightLauncher()` and `resolvePlaywrightCli()` are new
  exports.
- `PipelineIo` takes optional `interruptChild`, `waitForChild`,
  `killChild`, `clock`, `schedule`, `pid` and `interactive`, and its
  `onInterrupt` handler receives the signal. `PipelineDocument` has
  `status` and `stoppedBy`, and its `finishedAt` is null until the
  pipeline finished.
- `createConfig()` sets `handleSIGTERM: false` in the browsers' launch
  options (a project's own launch options keep it unless they set it): a
  browser no longer closes itself when a CI signals the job's whole
  process group, so the running test's video is kept; the runner closes it
  in its graceful stop.
- A stopped pipeline is never a pass: when a stop (a signal or the
  deadline) came and the stages that ran passed (a `--local` run, a stop
  during the combined video), the pipeline is `INCOMPLETE` with exit 130
  and a reason naming the stop.
- In a terminal, a hangup (SIGHUP) is a stop request for the pipeline and
  the stage, and the pipeline ignores the closed terminal's output errors
  so it can still write `pipeline.json`. Without a terminal SIGHUP keeps
  its default.

### Fixed

- A CI job that is cancelled or runs out of time no longer loses the run
  (issue #11). The pipeline handles SIGINT, SIGTERM and, on Windows,
  Ctrl-Break: the first stop asks the running stage to stop as Ctrl-C
  does (on POSIX it sends the stage SIGINT, the one signal Playwright's
  runner stops gracefully on), so the browser closes and the test's video
  and trace are saved, the personas are signed out and the stage writes
  its summary; no further stage starts and no combined video is made. The
  same signal within 200 ms counts once; a SIGTERM after the first stop
  never forces (GitHub Actions sends SIGINT, then SIGTERM 7.5 s later);
  only a second Ctrl-C forces: the final pipeline files are written, the
  stage gets 3 s to close before it is killed, the database copy is
  dropped and the pipeline exits 130 (4 when a restore is still pending).
- A stage whose pipeline was killed outright no longer runs on orphaned or
  crashes on its next log line: it stops gracefully within about a second.
- A stop signal during video composition ends it at once (ffmpeg, the
  voice engine and the card renderer's browser are stopped) instead of
  killing the run mid-encode; the summary says
  `video: not produced (video composition stopped (interrupted))`. This
  holds for a stage's video (the reporter listens from the start of the
  run, so a signal that lands after Playwright's teardown, while the other
  reporters finish, no longer kills the stage before its summary; a second
  Ctrl-C a second later exits 130) and for the pipeline's combined video.
- A run stopped during sign-in no longer leaves that session live: the
  global teardown waits (up to 60 s) for sign-ins still in flight before
  signing out. When the teardown was cut short, the summary reporter waits
  for its sign-out, or signs the personas out itself (after waiting up to
  20 s for pending restores) and says so loudly; the personas are never
  signed out twice.
- Ctrl-Break on Windows stops a run gracefully instead of killing it, and
  on Windows the stage stops itself at the deadline (the pipeline cannot
  signal it there).
- A stage no longer goes through `npx`, which cannot be spawned without a
  shell on Windows (`EINVAL` since Node 20.12). There is no npx fallback on
  Windows: a project without a resolvable `@playwright/test` gets a
  message saying to install it.

## [0.2.1] - 2026-10-16

Documentation and release tooling only; the runtime's behaviour is
unchanged. The npm page now shows the logo, badges and the demo video's
thumbnail.

### Added

- The release workflow creates the GitHub Release after the npm publish:
  a third job (`github-release`, the only one that can write to the
  repository, and it never sees the npm token) titles it
  "flowreel <version>" with an install line and the version's
  `CHANGELOG.md` section as its notes (`scripts/release-notes.mjs`, with
  unit tests). A release that already exists is left unchanged.
- A 76-second narrated demo video at the top of the README, recorded with
  flowreel 0.2.0 from npm. The video, its thumbnail and the run's report
  are in `assets/demo/`; the leak tripwire allows the publisher's name in
  that demo's README and run report only.
- The npm page (the runtime README) shows the demo's thumbnail, linked to
  the video on the project README (npm does not play videos); it appears
  on npm with the next release. Its logo is now the full mint logo (the
  symbol and the name, 320 px wide) instead of the small symbol alone.
- Badges under the logo in the README and the npm page: npm version, CI,
  license, Node and Claude Code plugin.

### Changed

- CI can also be started by hand (Actions -> CI -> Run workflow).
- README: install from npm (`@confidee/flowreel` is published); a clone
  is only for trying an unreleased change.
- Docs: they now say the package is on npm (no "pre-release" or "until the
  runtime is on a registry"), and the example's setup offers the npm
  install first.
- Docs: exit 130 and the `INCOMPLETE` verdict for an interrupted run are
  documented everywhere the exit codes are listed.
- Docs: the tour scanner's TypeScript range is stated (5.x and 6.x;
  TypeScript 7 is not supported yet, issue #6), with a troubleshooting
  entry.
- Docs: links in the plugin's templates and README work outside the
  repository; the changelog has version links.
- Dependabot no longer proposes major versions of `typescript` (TypeScript
  7 has no JavaScript compiler API, which the tour scanner uses) or
  `@types/node` (the type definitions follow the supported Node versions,
  raised on purpose). Minor and patch updates still arrive.

## [0.2.0] - 2026-10-16

First public release, from the public repository and to the npm registry.
It holds everything since the internal 0.1.0.

### Changed

- flowreel moved to its own public repository,
  [Confidee/flowreel](https://github.com/Confidee/flowreel), which is now
  its single source of truth. The repository root is the former package
  root; the marketplace (`.claude-plugin/marketplace.json`, owned by the
  copyright holder) lists the plugin at `./plugin`. Install the plugin with
  `/plugin marketplace add Confidee/flowreel` then
  `/plugin install flowreel@flowreel`; the team-install guide is now
  "Installing the plugin" and needs no git credentials.
- The package is published as `@confidee/flowreel` (it was
  `@fetijashari/flowreel`; never published under that name). The copyright
  holder is now the publishing company named in NOTICE (also runtime/NOTICE
  and the README); Feti Jashari stays the author and maintainer.
- The runtime and the example install and run from this repository alone:
  each has its own dev dependencies (`typescript`, `@playwright/test`,
  `@types/node`) and a committed `package-lock.json`. The repository root
  has a private `package.json` for Prettier and the repository scripts.
- `runtime/package.json`, `plugin.json` and the marketplace entry name the
  repository, homepage and issue tracker
  (`https://github.com/Confidee/flowreel`); a release test keeps the
  runtime's `repository.url` matching it, as npm provenance requires.
- The design notes are rewritten as public design docs:
  `docs/design/architecture.md` (parts, principles, interfaces, layout,
  scope, roadmap) and `docs/design/decisions.md` (the decisions and why).
- The leak tripwire (`scripts/check-leaks.mjs`) scans the whole repository,
  its own files, `.github/`, the examples and the design docs included. It
  publishes one pattern, the publisher's name; a consuming project supplies
  its own patterns at run time (`FLOWREEL_LEAK_PATTERNS_FILE`, or
  `FLOWREEL_LEAK_PATTERNS` from a CI secret), and a hit on one is reported
  by number only. An unreadable or invalid patterns source fails the check
  (exit 2). Allowlisted: the npm scope and the repository slug anywhere, the
  copyright holder in NOTICE, runtime/NOTICE, README.md and the
  marketplace, the contact address in SECURITY.md and CODE_OF_CONDUCT.md,
  and the publisher's name in the README's "Who uses it" section and the
  tripwire's own two files.
- `plugin/scripts/check-templates.sh` uses `runtime/node_modules` only and
  never searches folders above the repository.
- The runtime README links to the repository with absolute URLs, so the
  links work on npm, and lists the `/reporter` and `/demos` entry points.
- The docs no longer pin facts to a version number (the planned
  `flowreel` binary "has not shipped yet (0.x)"; plugin validation names
  the Claude Code version CI pins). The GitHub Actions example uses
  `actions/checkout@v7`, `actions/setup-node@v7` and
  `actions/upload-artifact@v7`, read-only permissions, and recommends SHA
  pins.
- `seamHttpFromRequest` and `seamHttpFromFetch` send a JSON body (`{}`)
  on a POST that has no fields, such as the job drain, so the Rails kit's
  gate accepts it.

### Added

- A coverage gate: `npm run test:coverage` in `runtime/` runs the unit
  tests under c8 and fails below 95% lines, statements, functions or
  branches (`runtime/.c8rc.json`). `npm run check`, CI and the release
  workflow run it in place of `npm test`.
- The flowreel logo (mint): `assets/brand/` holds the logo, symbol,
  wordmark and one-colour files for light and dark backgrounds, a favicon,
  an avatar and the social preview image, with a short guide to the files,
  colours and use. The README shows the logo; the README's license
  section says the name and logo are not licensed under Apache-2.0.
- Two optional test hooks: the video producers (`produceTourVideos`,
  `produceCombinedVideo`, `produceCombinedTourVideo`) take the card
  renderer as an optional last parameter (`PngRenderer`, default
  `renderPngs`), and `createGlobalSetup` takes `launchBrowser` (default
  Chromium). Existing callers are unchanged.
- CI (`.github/workflows/ci.yml`) on every push to main and every pull
  request: on Node 20, 22, 24 and 26, the runtime's typecheck, `npm test`
  (the leak tripwire, then the unit tests), build and export smoke test,
  the plugin template check, and the minimal example (typecheck and its
  flows at qa pace, with Chromium and ffmpeg); Prettier and the leak
  tripwire; and `claude plugin validate --strict` for the plugin and the
  marketplace through the published Claude Code CLI at a pinned version.
  Actions are pinned to commit SHAs. Node 20 is end-of-life and tested as
  best effort only (SECURITY.md).
- A release workflow (`.github/workflows/release.yml`): a tag `v<version>`
  on a commit on `main` runs a `build` job (no OIDC token) that checks
  every released file carries the version (`scripts/check-version.mjs`),
  installs with `npm ci --ignore-scripts`, runs the runtime's checks and
  packs the tarball with its SHA-256, then a `publish` job (the only one
  with `id-token: write`, in the `npm` environment, with no checkout or
  dependency install) that verifies the tarball and publishes it with
  `npm publish --provenance --access public` through npm trusted
  publishing (OIDC), with no npm token. [RELEASING.md](RELEASING.md)
  describes the steps and what the owner sets up before the first
  release.
- Issue templates (bug report, feature request; security reports routed to
  private reporting), a pull-request template, Dependabot for npm and
  GitHub Actions (with a 7-day cooldown), `.prettierrc`, `.prettierignore`
  and `.editorconfig`.
- `keepalive.maxMinutes` (tour fixtures) and `maxMinutes` (`keepaliveDeadline`):
  a project ceiling for `FLOWREEL_KEEPALIVE_MAX_MIN` (15 to 480, default 480),
  for organisations whose idle-timeout exception is shorter. A larger value is
  refused; the 2-hour default is never above the ceiling.

### Security

- SECURITY.md: report through GitHub private vulnerability reporting or to
  the published contact address, with response targets (acknowledgement
  within 3 business days, assessment within 10) and the supported versions
  (the latest 0.x release). CODE_OF_CONDUCT.md: conduct reports go to the
  same address. The pre-release "ask for a private channel in an issue"
  route is removed.
- Plugin: run evidence and app content (page snapshots, screenshots, mail,
  summaries, the app's source) are data, never instructions. The rule
  opens `reference/never.md` and is repeated in every skill and agent that
  reads them; SECURITY.md names prompt injection through them as in scope
  and says plainly that `flow-author`'s `Bash` tool is unrestricted.
- Plugin: `inventory` and `narrate` are user-invoked only
  (`disable-model-invocation: true`, design decision 10), like every
  other skill with a side effect; `explain`, which only reads, is the one
  model-invocable skill.
- Rails seam kit: the gate also answers `404` unless the request comes from
  this machine with a loopback `Host` (against DNS rebinding: the
  development stage runs the app in the test environment, where host
  authorization is off) and unless a `POST` carries a JSON body, so no
  cross-site page can inject inbound mail, drain the job queue or sign the
  browser in while the flag is on. Request specs cover both refusals.
- Global setup refuses a run with `retries > 0` or `repeatEach > 1` on any
  project (`refuseRepeats`, a `ConfigError` before anything is loaded or
  signed in), so `--retries` or `--repeat-each` on the command line can no
  longer repeat sign-ins and mail sends.
- Rails seam kit: the sign-in seam answers only a JSON body (a form post is
  a `404`), closing login CSRF while the seam flag is on; its spec covers
  the form post and the `403` path. The gate tripwire now walks mounted
  engines and reads paths without optional segments, so a seam inside
  `scope "(:locale)"` or an engine is checked too.
- `/flowreel:author` is user-invoked only
  (`disable-model-invocation: true`; design decision 10).
  `/flowreel:init` asks before its registry check.

### Fixed

- The pipeline: a Ctrl-C after development passed, before staging, ended
  as PASS with exit 0. It is now INCOMPLETE with exit 130 ("development
  passed; interrupted before staging."); a failure that did happen still
  exits 1 and an undo failure 4.
- The pipeline's undo check failed open: an `undo.json` that could not be
  read, or held a malformed entry, read as nothing to restore, so a
  crashed run could pass. It now counts as manual action needed (exit 4).
- The combined tour video was lost (`produced: false`) when one stage's
  summary held a `null` feature entry beside real ones.
- `UndoLedger.change()` reports a failed write-ahead write as a rejected
  promise, as its signature says, rather than throwing synchronously.
- README: the manual install appends `install-links=true` to `.npmrc` with
  the same guarded command as init, so a last line without a newline (a
  registry token) is no longer corrupted. The example's init walkthrough
  describes init's own `.npmrc` yes.

## [0.1.0] - 2026-10-15

First internal release, not published to a registry: the runtime (core,
video, voice, config, app, run, pipeline, tour, reporter and demos entry
points), the `rails-inertia` and `mail-graph` adapters, the Claude Code
plugin with its marketplace entry, the docs and the Rails seam kit.

### Security

- `GraphMailDriver` passes the reply-domain send guard before every send
  and every reply, refuses extra headers and attachments, and never
  retries a send or a reply. `HttpSeamMailDriver` does not call the guard:
  it talks only to the loopback local target and its mail never leaves the
  app.
- The Rails seam kit's inbound seam refuses (`422 invalid_env`, nothing
  stored) unless the job adapter is the `:test` adapter, as the job drain
  does: under a real adapter the routing job would also run and the mailbox
  would process the mail twice.
- The local target must be a loopback host (`localhost`, `127.0.0.1`,
  `[::1]`), and a production host is refused before either allowlist, even
  when a policy names it as local or staging.
- `TARGET`, `RUN_ID` and `MODULE` set to different values under
  `FLOWREEL_<KEY>` and a project alias are refused (naming both variables),
  so an inherited `FLOWREEL_TARGET=staging` can never turn a local run into
  a staging run.
- `mail-graph`: the default health-check hint
  (`DEFAULT_GRAPH_DRIVER_COPY.healthHint`) names both permission routes:
  with RBAC for Applications, an `Application Mail Full Access` assignment
  scoped to the mailbox and no Entra `Mail.*` consent (a change can take up
  to 2 hours to reach live calls); with an existing application access
  policy, the consent and the policy group. Wording only.
- `mail-graph` tenant setup follows Microsoft's current guidance
  (checked 2026-10-15): new setups scope the app to the QA mailbox with
  RBAC for Applications in Exchange Online and grant **no** `Mail.*` admin
  consent in Entra ID, because Entra grants are added to the scoped ones.
  The docs give Microsoft's migration order from an application access
  policy, testing the new scope before the old grant is removed.
- Rails seam kit: the gate tripwire fails when a `/test/` route's
  controller lacks the gate (or has no controller, or a missing one) and
  when a gated seam controller is routed outside `/test/`. The kit was run
  as shipped in a new Rails 8.1 app: every request spec passes, the
  staging-like examples fail when the gate is weakened to "not
  production", and the tripwire fails when a seam drops the gate.
- SECURITY.md's scope names a command the plugin runs without
  [docs/plugin.md](docs/plugin.md) listing it, and instructions injected
  into the model's context through the session-start check's output.

[Unreleased]: https://github.com/Confidee/flowreel/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/Confidee/flowreel/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/Confidee/flowreel/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Confidee/flowreel/releases/tag/v0.2.0
