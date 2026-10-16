# Troubleshooting

Start with the run's `summary.md`, or `pipeline.md` for a pipeline. In
Claude Code, `/flowreel:explain` reads them for you. For a failed step, open
the trace:

```bash
npx playwright show-report flowreel-results/<RUN_ID>/report
npx playwright show-trace flowreel-results/<RUN_ID>/test-results/<test>/trace.zip
```

Each section below starts with the message you see, as the runtime prints
it.

- [Configuration and targets](#configuration-and-targets)
- [Sign-in and sessions](#sign-in-and-sessions)
- [Mail](#mail)
- [Tours and features](#tours-and-features)
- [Pipeline](#pipeline)
- [Undo and cleanup](#undo-and-cleanup)
- [Videos and narration](#videos-and-narration)
- [Local server and database](#local-server-and-database)
- [Module loading](#module-loading)
- [The Claude Code plugin](#the-claude-code-plugin)

## Configuration and targets

**`Refusing https://… : production hosts are never a QA target.`**
The base URL is a production host by your `isProductionHost` rule. Point
`FLOWREEL_BASE_URL` (or your alias) at staging. Do not loosen the rule.

**`Refusing base URL … for target "staging". Allowed: …`**
The URL is not exactly one of `targets.staging`. Check for a trailing path,
`http` instead of `https`, or a different subdomain. For `local`, the
message shows the allowed `http://localhost:<min>-<max>` range.

**`FLOWREEL_TARGET and MYAPP_E2E_TARGET are both set, to different values; unset one (they name the same setting).`**
Your shell (or CI) has the target, run id or module set under two names
with different values. Unset the stale one. flowreel refuses rather than
guessing.

**`FLOWREEL_LOCAL_PORT must be a port from 3100 to 3199 (got "…").`**
Pick a port inside `targets.local.portMin..portMax`. Use a different port
for each person or agent running in parallel.

**`Missing required staging config: A, B. Pass them in the environment (…) or set them in <file> (template: …, chmod 600).`**
The staging secrets are not in this shell. Inject them for one command
(see [Configuration: secrets](configuration.md#secrets)). In a pipeline,
this shows up as exit 2, "staging not configured (missing A, B)". That is
not a failure.

**`Template placeholder values in staging config: A, B. Replace them with the real values (… only shows the shape).`**
You copied the env template without filling it in. No request was made.

**`<file> is accessible to other users (mode 644); run: chmod 600 <file>`**
Do what it says. The secrets file must be private to you.

**`<file> is not owned by the current user; refusing to read QA secrets from it.`**
Recreate the file as yourself.

**`modules.default "…" is not one of …` / `personas repeats a name` / `targets.local.host must be a loopback host …`**
`defineConfig()` names the first problem in `flowreel.config.ts`. Fix that
line.

## Sign-in and sessions

**`LoginError: …`**
Wrong password, a locked account, or a changed sign-in form. **Do not
retry in a loop**: lockout counters count every attempt. Wait out the
lockout window (often 15 minutes), check the password in your password
manager, then run once. If the form changed, fix your `AppAdapter.signIn`.

**`The <persona> persona is not signed in for this run (FLOWREEL_STATE_<PERSONA> unset): run through the flowreel Playwright config …`**
You ran a spec outside the flowreel Playwright config, so global setup did
not sign anyone in, or the persona is not configured on this target. Run
through the config or the pipeline. A feature that needs a persona missing
on staging must be a `dev` feature.

**A persona is redirected to the sign-in page late in a long run.**
The app's idle timeout signed the session out. The keepalive normally
prevents this. In the log:

- `keepalive: … request failed` says why a ping failed;
- `keepalive: stopped at its deadline` means the run outlasted
  `FLOWREEL_KEEPALIVE_MAX_MIN` (default 120). Raise it (up to 480) for a
  long demo-pace tour;
- under `PWDEBUG` the keepalive is off on purpose.

**`WARNING: could not sign out the <persona> persona (…). Its session cookie is in this run's traces and HTML report …`**
Sign that account out on the target (or wait for its idle timeout) before
sharing anything but `summary.md`. Then check your `AppAdapter.signOut`
(sign-out path, method, CSRF cookie and header).

**A persona swap shows the previous persona on the next page.**
A request still in flight on the old page returned with the old session's
cookie after the swap. Wait for the page to settle
(`waitForLoadState("networkidle")`, bounded) before calling `swapPersona`.

## Mail

**`SendRefusedError: Refusing to send to "…": on staging the harness only mails a single bare address on the reply domain …`**
The send guard stopped a mail to an address outside the reply domain.
**Nothing was sent.** Check your support address and reply domain
settings. Never widen the guard. On a reply step, this can mean the app's
mail arrived without the expected `reply+` Reply-To.

**`Timed out after <n>s waiting for <query>. Last observed: …`**
The mail did not arrive in time. The "last observed" part lists the
messages that were there. On staging, check in order: did the app capture
the inbound mail (look for a dropped or quarantined message in its admin
view)? Is a rate limit parking new records from this sender? Are the
background workers running? Never re-send by hand within the same run.

**`InboundBudgetError: Refusing inbound mail "…": this staging tour already sent 3 of at most 3 …`**
The tour's per-run budget refused the send before it happened. Create the
record through the app's API instead, or make the feature development-only.

**`InboundBudgetError … already sent 8 … in the last 60 minutes`** (cross-run ledger)
Another run used this sender's hourly allowance. Wait until the time the
message names, or spread runs over more QA senders.

**A mail matched the wrong message.**
Two hops share a mailbox, or a development mail sandbox rewrites
recipients. Pass `excludeIds` with the earlier hop's message id, and match
on the run marker in the subject.

## Tours and features

**`feature(): the test title "…" must be "A4 <slug>"`** or **`… must be "A4 list-search" (the catalogue's slug).`**
The test title does not match the catalogue. Fix the title, not the
catalogue.

**`feature(): A4 declares policy "both" but the catalogue says "dev" (owner-approved; change … first, never the flow alone).`**
The staging policy is the owner's decision. Get the catalogue changed
first.

**`Feature B9: a "dev" feature needs devOnlyReason (shown on staging).`**
Add `devOnlyReason`: one sentence on why it cannot run on staging.

**`test("…") does not start with feature(test, { id, policy })` / `test.skip(…) runs outside feature()`** (unit tripwire)
Move `feature()` to the first line, and remove hooks and skips. Only
`feature()` skips.

**A tour test passed but is reported failed.**
It never called `feature()`. Every tour test must.

**`Unknown area X; the tour has areas A, B, C.`**
`--area` takes the letters in your `TourManifest`.

**A feature fails on `page.goto: Timeout 30000ms exceeded` with the page fully drawn.**
Something on the page never finished loading, so the load event never
fired. Third-party avatars and trackers are typical. Find the request with
no response in the trace's network tab. Then either abort that host in
your recorded-page fixture (`context.route(pattern, (r) => r.abort())`), or
navigate with `waitUntil: "domcontentloaded"` and wait for what you assert.

**A feature fails only at `--pace qa`.**
At demo pace, the slower clicks can hide a timing bug in the app or the
flow (a dropdown that only closes because the next click happened later).
If a feature passes at demo pace and fails at qa pace, the qa result is the
real one. Fix the flow's waits, or report the app bug.

## Pipeline

**Exit 2, `staging not configured (missing …)`**
Development passed and this shell has no staging secrets. Inject them and
run again, or use `--staging-only` once development is known to be green.

**Exit 3, N/A**
A stage ran but verified nothing: the gate test skipped with `N/A:` (for
example, the feature is switched off on that target), or every tour
feature was development-only. N/A is not a pass.

**Exit 4, `UNDO FAILED, manual action needed`**
See [Undo and cleanup](#undo-and-cleanup). This outranks every other code.

**Exit 130, `INCOMPLETE` (interrupted)**
Ctrl-C stopped the pipeline before a stage that would have run. It is never
a pass. Run again. See
[Interrupting a run](pipeline-and-gates.md#interrupting-a-run).

**`no summary written (playwright exited 1)`**
The stage died before its reporter ran: a crash in global setup (a sign-in,
`prepareLocal`), a config error, or the process was killed. Read the
`[development]` or `[staging]` lines above it in the log.

**`playwright exited 1 after a PASS summary`**
Something failed outside the flow projects, such as a setup project or
another tabulated project. The summary lists it.

**Exit 64**
A usage error. The message and the usage text say which flag was wrong.

## Undo and cleanup

**`<stage>: UNDO FAILED, n shared-config change(s) not put back: …/undo.md`**
Open that `undo.md`. Its **MANUAL ACTION NEEDED** list gives each change,
newest first, with its before-state and exact restore steps. Do them, then
check the app. Common causes: the restore did not re-read the state, the
persona lacks permission to restore, or the worker crashed (the entry stays
`pending`).

**`<feature>: QA records off camera: COULD NOT SOLVE ORD-123 (…)`**
The off-camera cleanup could not close a record. It is a FAILED undo entry
(exit 4) with the instructions in `undo.md`. Close it by hand, then fix the
persona or status mapping in your `CleanupAdapter` or `CleanupDeps`.

## Videos and narration

**`video: not produced (ffmpeg not found on PATH (install it, e.g. brew install ffmpeg))`** / **`ffmpeg has no libx264 encoder`**
Install ffmpeg with libx264 (see
[Getting started](getting-started.md#14-ffmpeg-and-ffprobe-with-libx264-and-aac-required-for-videos)).
On Fedora, enable RPM Fusion first.

**`video: not produced (FLOWREEL_VIDEO=off)`**
Videos are switched off, by `--no-video` or the variable.

**`video: not produced (no video timing log)` / `(no page recording was attached)`**
Your recorded-page fixture did not call `videoLog.markVideoStart()`, or the
video log was not attached at teardown. See
[Writing flows: project fixtures](writing-flows.md#project-fixtures).

**Captions run ahead of the picture by the first step's length.**
The standby card did not paint, so the recording's clock started late.
Check the standby fixture (a missing logo file, for example). The cut
points are in `<RUN_ID>/video/timeline.json`.

**`narration: not produced (no voice engine on this platform)`**
Expected on Linux and CI. The video is silent.

**`FLOWREEL_VOICE "…" is not installed (say -v '?' lists the installed voices)`**
Use the exact name from `say -v '?'`, for example `Zoe (Premium)`.

**`using fallback voice Samantha: install a Premium voice …`**
Download a Premium voice (see
[Getting started](getting-started.md#15-a-voice-optional-macos-only-for-now)).

**A line is spoken oddly, or a word is missing.**
The never-speak rules removed an address, link, id or token (or one of
your own `speakablePatterns`). Rewrite the line without it.
`narration.unspeakableParts(line)` tells you which rule matched.

## Local server and database

**`Port … in use` / the app shows old behaviour locally**
A stale local server from an earlier run is still listening. Find it
(`lsof -i :<port>` on macOS and Linux), stop it, and run again. A web
server is reused only when you allowed it and nothing per-run (such as a
fresh database) is in play.

**`<clone command> <key> failed: …`**
`DbIsolation.create` failed, so development did not run and is recorded
FAIL. Run the clone script by hand with the same key to see the full
error.

**`WARNING: could not drop the DB clone <key> (run: … <key> drop)`**
The stage's server still held connections. Run the printed command once the
server has stopped.

## Module loading

**`ERR_REQUIRE_ESM` or "Cannot use import statement outside a module" when loading flowreel**
The runtime is ESM only. Playwright compiles your test files to CommonJS
unless your `package.json` has `"type": "module"`, and CommonJS can load
an ES module only on Node 20.19+ (20.x), 22.12+ (22.x) or 23 and later
(never on 21). Upgrade Node (preferred), or set `"type": "module"` if you
accept that it changes how every `.js` file in your project loads.
`/flowreel:doctor` reports which case you are in.

**`TypeError: ts.createSourceFile is not a function` (or similar) from the tour scanner**
Your project has TypeScript 7, which has no JavaScript compiler API. The
scanner supports TypeScript 5.x and 6.x. Use TypeScript 6 for the project,
or wait for [issue #6](https://github.com/Confidee/flowreel/issues/6).

**`Requiring @playwright/test second time`**
Two copies of `@playwright/test` are loaded. The usual cause is a runtime
installed from a local folder as a symlink (npm's default for a path), so
it resolves `@playwright/test` from its own folder. Reinstall it as a copy
(`install-links=true` in your `.npmrc`, or an `npm pack` tarball; see the
[README](../README.md#without-the-plugin)) and keep exactly one
`@playwright/test`, in your project.

**The runtime changed in the clone, but runs still use the old code**
A runtime installed as a copy does not follow the clone. Rebuild it
there (`npm run build`), then reinstall it in your project (`npm ci`, or
`npm install <path>` again).

## The Claude Code plugin

**`/flowreel:doctor` or another `/flowreel:` command is unknown after
installing.**
Plugins load when a session starts. Start a new Claude Code session, then
check `/plugin`: `flowreel@flowreel` should be listed and enabled.

**The session-start check prints nothing.**
That is expected outside a flowreel project: it stays silent unless the
project has a `flowreel.config.ts`, an `e2e/flowreel/` folder or the
runtime in `package.json`, and inside one it prints only what is missing.
Run `/flowreel:doctor` for the full report, and check that
`FLOWREEL_PREREQS` is not set to `off`.

**`/plugin marketplace add Confidee/flowreel` fails.**
Claude Code clones the repository with your own git. Check
`git ls-remote https://github.com/Confidee/flowreel.git HEAD` in a
terminal: it prints one commit id. If git is not installed, or a proxy
blocks GitHub, install from a clone you downloaded some other way; see
[Installing the plugin](team-install.md#install-from-a-clone).

**A skill refuses to retry a run, read a secrets file or change an
assertion.**
That is by design: the rules in the plugin's `reference/never.md` bind
every skill and agent. Run the command yourself if you really mean to,
and see [Safety](safety.md) for why each rule exists.
