# Changelog

All notable changes to flowreel are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [Semantic Versioning](https://semver.org/) (0.x: APIs may change in minor versions).

## [Unreleased]

### Added

- `skills/flowreel/`: flowreel as a standard
  [Agent Skill](https://agentskills.io), for Cursor, GitHub Copilot in
  VS Code and any other agent that reads the format, besides Claude Code.
  It is one `SKILL.md`, written to the specification (only its six
  frontmatter fields; checked against its reference validator at commit
  `69ef37e`), that routes to the plugin's workflows. Its `references/` and
  `scripts/` are generated from `plugin/` by
  `npm run sync:agent-skill`, and a runtime test fails when they are stale
  or `SKILL.md` breaks the specification. The plugin and its `/flowreel:*`
  commands are unchanged, and nothing changes in the npm package. The
  README's "Use with any Agent Skills agent" says where each agent looks
  for it.

## [0.4.1] - 2026-10-23

A fix for the Claude Code plugin only: its prerequisite check failed with a
syntax error in 0.4.0. The npm package's code is unchanged from 0.4.0; its
version moves with the plugin's, which is what makes plugin users get the
fix. Update the plugin with `/plugin marketplace update flowreel`.

### Fixed

- The plugin's prerequisite check (`plugin/scripts/check-prereqs.sh`) ran
  into a syntax error in 0.4.0 and exited with 2 (#29): the session-start
  hook showed a bash error in every session of a flowreel project, and
  `/flowreel:doctor` lost its summary line. An apostrophe inside a
  single-quoted string, in the `advice` line added in 0.4.0, ended the
  string early. A test now parses every plugin shell script and runs the
  check in both modes, under the shell on `PATH` and macOS's bash 3.2.
  The npm package was not affected.

## [0.4.0] - 2026-10-22

Every request flowreel makes is bounded, and a failure says what it
means. The Microsoft 365 driver never follows a redirect and says whether
a failed send may have gone out; a mail wait rides out throttling and
brief network drops; the sign-in, session and persona requests have a time
limit; and the shared summary no longer carries Playwright's call log,
which could hold a live session cookie. Two security fixes: upgrade if
you use the Microsoft 365 driver or share `summary.md`.

### Security

- **`GraphMailDriver` no longer follows redirects (#22).** Affects 0.3.0
  and earlier. The driver's requests used `fetch`'s default
  `redirect: "follow"`, and the fetch standard keeps the body on a 307 or
  308: a 307 on `sendMail` sent the mail a second time (and reported the
  send as successful), a redirect loop sent it up to 21 times, and a 307
  on the token request re-sent the form body, `client_secret` included,
  to the redirect target. Every Graph and token request now uses
  `redirect: "manual"`: a 3xx is a `GraphHttpError` that sent nothing
  (`mayHaveSent: false`), never followed and never retried. A project
  that passes its own `fetch` must make one attempt per call and never
  follow redirects.
- **`summary.md`, `summary.json` and `summary.lines` no longer carry
  Playwright's call log (#26).** Affects 0.3.0 and earlier. The summary
  reporter copied up to 4000 characters of every error, and a failed
  Playwright request's error goes on, after its first line, with a
  "Call log" that names the full URL with its query string, every
  request header (the persona's session cookie, a CSRF token) and a
  response's `set-cookie` (on a stalled sign-in, the fresh session
  cookie): the file flowreel tells you to share could carry a live
  session. The summary now keeps an error up to its call log and drops
  every `http(s)://` URL's query string and fragment; the HTML report
  (where a `toHaveURL` failure that differs only in its query still shows
  the difference) and traces keep
  the whole error and stay credential-bearing. flowreel's own sign-in
  seam and session probes rethrow the first line of Playwright's error
  only, without a cause, and so do the template and example adapters. If
  you shared a `summary.md` from a run that failed on a request, check it
  for a `Call log:` block and revoke the sessions it names (a completed
  teardown already revoked them).

### Added

- `requestTimeoutMs` for `GraphMailDriver` (`@confidee/flowreel/mail-graph`):
  every Graph and token request, from the connection to the last byte of
  the body, gets at most this long (default 30 s), and inside `waitFor` no
  more than the wait has left. A whole number of milliseconds from 1 to
  2147483647; anything else is a `ConfigError`.
- `GraphRequestTimeoutError` from `@confidee/flowreel/mail-graph`
  (`timeoutMs`, plus `operation`, `mayHaveSent` and `clientRequestId` from
  `GraphRequestError`): what a request that got no answer throws. A
  `sendMail` or a reply's `send` sets `mayHaveSent`, says the mail may have
  been sent and names its `client-request-id`; it is never retried.
- `GraphRequestError` from `@confidee/flowreel/mail-graph`: the base of
  every error a Graph or token request ends in (`operation`,
  `mayHaveSent`, always a boolean, and `clientRequestId`), with a
  one-line message. A bad 2xx answer (a body that is not JSON, a token
  answer without `access_token`) throws it as is, with `mayHaveSent`
  false. `GraphHttpError`, `GraphRequestTimeoutError` and the new
  `GraphTransportError` extend it (#17).
- `GraphTransportError` from `@confidee/flowreel/mail-graph` (`code`, such
  as `ECONNRESET` or `UND_ERR_SOCKET`; no `cause`): what a failure below
  HTTP throws, instead of a plain `Error`. The message is unchanged:
  `Graph <operation> failed: fetch failed (ECONNREFUSED)` (#17).
- `GraphHttpError` takes an optional fifth argument, a details object
  (`mayHaveSent`, `clientRequestId`, `requestId`, `date`, `traceId`,
  `correlationId`, `code`), and exposes those fields; its four positional
  arguments are unchanged (#17, #19).
- Request ids for `GraphMailDriver`: every Graph and token request carries
  a fresh random `client-request-id`, and the token request sends
  `return-client-request-id: true`. Every error keeps it; a
  `GraphHttpError` also keeps Graph's `request-id` and `date`, and a token
  error Entra's `trace_id` and `correlation_id`, when GUID-shaped. A token
  error's message always names its `trace_id` and `correlation_id` on the
  detail line; a Graph request's message names its ids only when the mail
  may have been sent (`For Microsoft support: client-request-id …`) (#19).
- `requestTimeoutMs` for both seam HTTP clients
  (`@confidee/flowreel/rails-inertia`), 30 s by default:
  `seamHttpFromRequest(request, { requestTimeoutMs })` passes it as
  Playwright's per-call `timeout` (inside `@playwright/test` a request
  context otherwise has none), and `seamHttpFromFetch(baseURL, options)`
  now also takes `{ fetch, requestTimeoutMs, setTimeout, clearTimeout }`
  besides the `fetch` function it took before. A seam request that runs
  out is aborted and throws
  `Seam <METHOD> <path> got no answer within 30 s; raise requestTimeoutMs if a job drain legitimately takes longer`
  (#20).

- `requestTimeoutMs` for flowreel's session requests (#24), 30 s by
  default, validated like every flowreel request bound (a whole number of
  milliseconds from 1 to 2147483647, else a `ConfigError` naming the
  option): on `seamSignIn`'s options (`@confidee/flowreel/rails-inertia`),
  on `SessionProtocol` (`isSessionSignedOut`; `revokeSession`, which never
  throws, returns `revoked: false` naming the option, so teardown warns
  loudly), and on
  `createPersonaApis` and `tourFixtures()` for every persona request. It
  is the `timeout` of each request context they open.
- `requestFailure(error)` from `@confidee/flowreel/core`: what may be
  said of a failed Playwright request, the first line of its message
  without a URL's query string, at most 300 characters. For a project's
  own adapter (#26).
- `/flowreel:doctor` advises when `e2e/flowreel/adapter.ts` opens request
  contexts without a timeout (an adapter scaffolded before 0.4.0). It
  only reads the file, with grep.

### Changed

- `GraphMailDriver.waitFor`: a temporary network failure on a mail read
  or the token request is now re-polled instead of ending the wait (#23):
  `ECONNRESET`, `UND_ERR_SOCKET`, `EPIPE`, `ECONNABORTED`, `ETIMEDOUT`,
  `EAI_AGAIN` and undici's connect, headers and body timeouts (an
  `AggregateError` only when every inner code is listed), with the
  token's back-off (5 s, then 10 s, 20 s … up to 60 s, never past the
  wait's end, on top of the wait's own poll interval), counted apart for the token request and the reads. Only
  once that endpoint has answered the driver: at first contact the same
  error still ends the wait, so a firewall or broken DNS fails fast. Any
  other code, or none, stays fatal (`ECONNREFUSED`, `ENOTFOUND`, TLS, a
  custom `fetch` that throws a plain error), nothing that may have sent
  mail is ever re-polled, and nothing is retried outside `waitFor`. A
  wait that times out reports the step, the code and the count only
  (`Last observed: Graph read failed (ECONNRESET), 3 in a row, no mailbox read completed in this wait, retrying`).
- `GraphMailDriver.waitFor` re-polls a `429`, `503` or `504` only on a
  GET read; a write's never was reachable there, and now cannot be.
- The persona request contexts (`createPersonaApis`, the tour's `as()`
  and `personaApis`) now have a 30 s `timeout` of their own, which
  overrides the project's `actionTimeout` for them (15 s under flowreel's
  `createConfig`); a request's own `timeout` still wins. Set
  `requestTimeoutMs` on `tourFixtures()` for a longer one.
- Global teardown (`signOutAll`) now survives an `AppAdapter.signOut`
  that throws, against its contract: that persona gets the loud "could
  not sign out" warning (with the first line of the error) and the other
  personas are still signed out. Before, one throw skipped every later
  persona.
- `seamSignIn` and `isSessionSignedOut` throw
  `Test sign-in (POST <path>) failed: …` and
  `Session probe GET <path> failed: …` with the first line of
  Playwright's error, instead of Playwright's error itself (#26).
- The template adapter (`/flowreel:init`) and the example's set a
  `REQUEST_TIMEOUT_MS` (30 s) on every request context and on `SESSION`,
  describe a failed request with `requestFailure()`, and `health()`
  returns a failed request's first line instead of throwing; the
  template ships `unit/adapter.spec.ts`, which checks both. `/flowreel:init`
  never rewrites an existing adapter: copy these lines into one you
  scaffolded before (the doctor points it out).
- `GraphMailDriver`: a failed `sendMail` or reply `send` now says whether
  the mail may have been sent from everything observed, not only a
  timeout. Any 5xx but 509 (503 included) and any transport failure that
  does not prove the request never left (a reset or closed socket,
  `terminated`, `EPIPE`, any code on a `read` or `write`, an unknown or
  missing code) set `mayHaveSent`; a 3xx, a 4xx (429 included), 509 and
  a DNS, connect or TLS failure (a `getaddrinfo` or `connect` syscall, or
  a listed code on an error without a syscall) do not. An error status
  whose body does not arrive within the bound stays a may-have-sent
  timeout. A 2xx status now resolves the send at once, even when its empty
  body then fails or never ends. Nothing is retried (#17).
- `GraphMailDriver.waitFor`: a token request that is throttled or meets a
  server error (HTTP 429, 500, 502, 503, 504, or OAuth error
  `temporarily_unavailable`) is now re-polled instead of ending the wait,
  after the response's Retry-After exactly, else 5 s, then 10 s, 20 s …
  up to 60 s, never past the wait's end. A token request that got no
  answer gets the same back-off. Credentials failures stay fatal (token
  transport errors: see #23 above), and nothing is retried outside
  `waitFor` (#18). Only consecutive failures double the back-off: a token
  obtained resets it.
- `GraphMailDriver.health()`: a request that could not connect (a DNS,
  connect or TLS failure) now points at the network path, not the
  credentials.
- `GraphMailDriver`: an error code from a response body (Graph's
  `error.code`, Entra's `error`) is shown only when code-shaped, else as
  `UnknownError`; and the client secret is redacted before the message is
  joined into one line, so a secret split across a line break is not
  reassembled.

### Fixed

- flowreel's session requests could hang (#24). The sign-in seam, the
  session probes and sign-out, the persona API contexts and the template
  adapter opened request contexts without a `timeout`, so they got
  Playwright's default: 30 s in global setup and teardown, the project's
  `actionTimeout` in a test (15 s under `createConfig`), and none at all
  with `actionTimeout: 0` or without flowreel's config, where a server
  that never answered, or a body that never ended, hung the run until
  the test or fixture timeout. Every one of them is now bounded by
  `requestTimeoutMs` (30 s by default), body included.
- A Microsoft Graph request that never answered could stall a run (#16).
  A hung request ended only at Node's `fetch` limit of 300 s, a body that
  trickled in never ended, a hung token request held up every later call
  until it ended, and `waitFor`'s own `timeoutMs` could not end a request
  in flight. Now every request is bounded, a wait ends at its `timeoutMs`
  (a read that got no answer is re-polled, and after the first attempt
  none starts once no time is left), a timed-out token request is dropped
  so the next call asks again, `health()` points at the network instead
  of the credentials when a request got no answer, and a transport error
  keeps its cause's error code (`fetch failed (ECONNREFUSED)`) and nothing
  else of it.
- `GraphMailDriver`: a 2xx answer whose body cannot be read now throws the
  named, redacted transport error (`Graph <operation> failed: …`) instead of
  the raw stream error, which could echo the access token.
- `GraphMailDriver`: a token answer whose body is JSON `null` now fails with
  "no access_token returned" instead of a bare `TypeError`.
- `GraphMailDriver` redacts the client secret and the access token in their
  URI-encoded and form-encoded forms too, so a transport error that echoes
  the token request's body no longer carries the secret.

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
