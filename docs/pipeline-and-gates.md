# Pipeline and gates

The pipeline runs a module on development first, then, only if development
passed, on staging. It writes one report for both stages and exits with a
code that a CI job or a release checklist can gate on.

- [Stages and the gate](#stages-and-the-gate)
- [Command-line flags](#command-line-flags)
- [Exit codes](#exit-codes)
- [What each stage gets in its environment](#what-each-stage-gets-in-its-environment)
- [Results: pipeline.md and pipeline.json](#results-pipelinemd-and-pipelinejson)
- [The pipeline entry point](#the-pipeline-entry-point)
- [CI usage](#ci-usage)
  - [Time limits on CI](#time-limits-on-ci)
- [Interrupting a run](#interrupting-a-run)

## Stages and the gate

```text
            ┌──────────────────────────┐   PASS   ┌──────────────────────────┐
 pipeline ─▶│ development (local)      │─────────▶│ staging                   │─▶ pipeline.md / .json
            │ loopback server, seams,  │          │ allowlisted host, real    │   combined video
            │ optional fresh database  │          │ sign-in, real mail        │   exit code
            └──────────────────────────┘          └──────────────────────────┘
                       │ FAIL / N/A
                       └──────────────▶ staging "not run (development FAIL)"
```

- Each stage is one `playwright test` child process, with its own run
  id, a clean environment and its output prefixed `[development]` or
  `[staging]`. A stage is never retried. The pipeline starts Playwright's
  own command-line entry (`@playwright/test/cli`, resolved from your
  project) with the Node that runs the pipeline, without `npx` in between;
  only when that entry cannot be resolved does it fall back to
  `npx --no-install playwright` (macOS and Linux only: on Windows the stage
  fails with a message saying to install `@playwright/test` in the
  project). The log says which.
- **Staging runs only after a development PASS.** `--staging-only` skips
  development (and with it the gate). `--local` stops after development.
- The staging configuration is checked **once, up front**, using the
  environment staging would get. If something is missing, the log says so
  before development spends minutes running, and staging is recorded as
  "not configured" with the missing key names (never values).
- The combined video is composed after both stages and can never change
  the verdict.

## Command-line flags

| Flag                  | Meaning                                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `--module <name>`     | One of your config's `modules.names`. Default: `modules.default`.                                                |
| `--local`             | Development only.                                                                                                |
| `--staging-only`      | Staging only, without the gate. Use it when development is known to be green. Cannot be combined with `--local`. |
| `--headed`            | Both stages headed. Sets a 300 ms slowMo unless one is already set.                                              |
| `--no-video`          | No videos, neither per stage nor combined.                                                                       |
| `--narration on\|off` | Forces narration on or off for every video in the run.                                                           |
| `--area A,C`          | Tours only: run only these areas.                                                                                |
| `--pace demo\|qa`     | Tours only: the pace (default `demo`).                                                                           |
| `--keep-db`           | Tours only, with DbIsolation: keep the development database copy and print how to drop it.                       |
| `--deadline <when>`   | Stop at this time. See [Time limits on CI](#time-limits-on-ci). Default: none (`FLOWREEL_DEADLINE`).             |
| `--help`, `-h`        | Print the usage text and exit 0.                                                                                 |

Flags take values as `--flag value` or `--flag=value`. An unknown flag, a
missing or unknown value, a value on a flag that takes none, or a tour-only
flag on a non-tour module is a usage error: exit 64, with the message and
the usage text.

## Exit codes

The exit code reflects **only the stages that ran**:

| Code  | Verdict    | Meaning                                                                                                                                                             |
| ----- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`   | PASS       | every stage that ran passed                                                                                                                                         |
| `1`   | FAIL       | a stage failed, a stage died before writing its summary, a stage exited non-zero after a PASS summary, or the runner itself crashed                                 |
| `2`   | INCOMPLETE | development passed, but staging is not configured in this environment (`missing …` names the keys). Not a failure: inject the secrets and run again                 |
| `3`   | N/A        | a stage that ran verified nothing (the gate test skipped with `N/A:`, or every tour feature was development-only)                                                   |
| `4`   | (any)      | **undo failed, manual action needed**: a shared-config change or a run record could not be put back. Outranks every other code. Read the stage's `undo.md` first    |
| `64`  |            | bad arguments                                                                                                                                                       |
| `130` | INCOMPLETE | stopped: Ctrl-C, a CI's stop signal or the `--deadline` came before a stage that would have run, or a second Ctrl-C (see [Interrupting a run](#interrupting-a-run)) |

Exit 4 also covers a stage that crashed mid-change: the pipeline reads each
run's write-ahead `undo.json` itself, so an entry left `pending` still
counts. An `undo.json` that cannot be read (damaged, or without an entries
list) counts as one change needing manual action, never as nothing to
restore.

The demos command has its own codes: 0 published, 1 nothing published,
64 bad argument.

## What each stage gets in its environment

The pipeline builds each child's environment from your shell, then:

1. **Removes** every name (`FLOWREEL_<KEY>` and your aliases) of the keys
   it controls (target, run id, module, database key, plus pace, narration
   and video when a flag sets them) and every persona-session handoff
   variable (`FLOWREEL_STATE_*`, plus your `statePrefixes`).
2. For the **development** stage only, removes the staging secrets:
   `FLOWREEL_BASE_URL` and `FLOWREEL_ENV_FILE` (and their aliases), plus
   anything your `PipelineSpec.isSecret(name)` matches. A custom
   `secrets.baseUrlKey` is removed only if `isSecret` matches it. With a
   complete `isSecret`, a password injected for staging never reaches the
   local run.
3. **Writes** the stage's own values under each key's preferred name (your
   first alias, otherwise `FLOWREEL_<KEY>`): the target, a fresh run id,
   the module and, when set, the pace and narration. `--no-video` writes
   `VIDEO=off`, so a `FLOWREEL_VIDEO=on` in your shell cannot override it.
4. For development with DbIsolation, adds the database copy's environment
   and its key (`FLOWREEL_DB_KEY`).
5. Tells the stage about the pipeline, for the stage guard (see
   [Interrupting a run](#interrupting-a-run)): `FLOWREEL_PIPELINE_PID` (the
   pipeline's process id), `FLOWREEL_HUP=graceful` when the pipeline runs
   in a terminal, and `FLOWREEL_DEADLINE_AT` (epoch milliseconds) when a
   deadline is set. These, and `FLOWREEL_DEADLINE`, are never inherited.

## Results: pipeline.md and pipeline.json

`<results>/<PIPELINE_ID>/`:

- **`pipeline.md`**: for people. Both stages side by side, each with its
  verdict, reason, run folder, summary and video, plus anything your
  report hooks add (a feature-by-feature comparison for tours, for
  example).
- **`pipeline.json`**: for tools. The plugin's explain skill and CI read
  this:

```json
{
  "pipelineId": "pipe-20261014-0930-1a2b",
  "module": "smoke",
  "status": "finished",
  "stoppedBy": null,
  "verdict": "PASS",
  "verdictReason": "development, staging passed.",
  "exitCode": 0,
  "options": {
    "local": false,
    "stagingOnly": false,
    "headed": false,
    "video": true,
    "areas": null,
    "pace": null,
    "keepDb": false,
    "narration": null,
    "deadline": null
  },
  "startedAt": "…",
  "finishedAt": "…",
  "resultsDir": "flowreel-results/pipe-20261014-0930-1a2b",
  "stages": [
    {
      "stage": "development",
      "target": "local",
      "verdict": "PASS",
      "reason": "…",
      "runId": "loc-…",
      "resultsDir": "…",
      "summary": "…/summary.md",
      "summaryJson": "…/summary.json",
      "video": "…",
      "videoNote": null,
      "undoChanges": 0,
      "undoFailed": 0,
      "undoFile": null,
      "startedAt": "…",
      "durationMs": 81234,
      "exitCode": 0
    },
    { "stage": "staging", "…": "…" }
  ],
  "video": {
    "produced": true,
    "path": "…",
    "file": "smoke-pipe-….mp4",
    "durationSec": 74.2
  },
  "narration": { "produced": false, "reason": "…" }
}
```

`pipeline.json` is written ahead: as soon as the pipeline's folder exists,
with `"status": "running"`, verdict `INCOMPLETE`, exit code 130,
`finishedAt: null` and every stage `pending`; again as each stage starts
(its `runId` and `resultsDir` filled, reason `running`) and ends; on the
first stop request (`"status": "stopping"`, with `stoppedBy` naming the
signal or the deadline); and at the end (`"status": "finished"`). A second
Ctrl-C writes `"status": "aborted"`. Any status but `finished` means the
pipeline did not finish: the stage folders hold what the stages wrote.
Every write replaces the file atomically (a temporary file, then a rename).

`pipeline.md` and the final `pipeline.json` are written before the combined
video starts and again after it, so a composition that is killed still
leaves both. A disk error writing one file is logged and does not change
the exit code.

Each stage's own folder (`<results>/<RUN_ID>/`) has `summary.md`,
`summary.json`, `summary.lines` (failures as `<file>:<line>: error: [<step>]
<message>`, which an editor's problem matcher can read), the HTML report,
traces, `undo.md` and `undo.json` when relevant, and the stage video.

## The pipeline entry point

The project owns a small entry file, `e2e/flowreel/pipeline.ts`, that
describes itself to the runner. `/flowreel:init` generates it, and
`npm run flowreel` runs it with `tsx`. Abridged:

```ts
// e2e/flowreel/pipeline.ts (abridged)
import { resultsDir } from "@confidee/flowreel/config"
import {
  type PipelineSpec,
  configProblemOf,
  runPipelineCli,
} from "@confidee/flowreel/pipeline"
import { makePipelineId, makeRunId } from "@confidee/flowreel/run"
import { parsePace } from "@confidee/flowreel/tour"
import type { StageSummary } from "@confidee/flowreel/video"

import { type Module, flowreel } from "../../flowreel.config"
import { isStagingSecret, loadRun } from "./adapter"
import { TOUR } from "./tour"

const spec: PipelineSpec<Module, StageSummary> = {
  modules: flowreel.modules.names,
  defaultModule: flowreel.modules.default,
  tourModules: ["tour"],
  parseAreas: TOUR.parseAreas,
  parsePace: (raw) => parsePace(raw, "--pace"),
  isSecret: isStagingSecret, // which inherited variables are staging secrets
  repoRoot: process.cwd(),
  playwrightConfig: "e2e/flowreel/playwright.config.ts",
  usage:
    "Usage: npm run flowreel -- [--module smoke|tour] [--local | --staging-only] …",
  resultsDir: (id) => resultsDir(flowreel, id),
  makeRunId: (target) => makeRunId(target),
  makePipelineId: () => makePipelineId(),
  stageInfo: {
    development: {
      title: "Development",
      detail: "Local test server",
      target: "local",
    },
    staging: { title: "Staging", detail: "Staging server", target: "staging" },
  },
  projects: (options) =>
    options.module === "tour"
      ? [TOUR.setupProject, ...(options.areas ?? ["A"]).map(TOUR.projectOfArea)]
      : ["smoke"],
  stagingConfigProblem: (env) => {
    try {
      loadRun(env) // throws a ConfigError naming missing keys
      return null
    } catch (error) {
      return configProblemOf(error)
    }
  },
  // db: { modules: ["tour"], isolation, keyPrefix: "tour" }, // optional DbIsolation
  report: { markdown, compose }, // pipeline.md and the combined video
}

runPipelineCli(spec)
```

- `stagingConfigProblem(env)` loads your staging settings with the
  environment the staging stage would get, and returns `null` or the
  problem. `configProblemOf(error)` turns a `requireKeys` error into
  "missing A, B".
- `report.markdown(doc, request, dir)` writes `pipeline.md`.
  `report.compose(request, env)` makes the combined video (with
  `produceCombinedVideo` or `produceCombinedTourVideo` and your video kit)
  and must never throw. `report.extras` and `report.closingLines` are
  optional.
- `runPipeline(argv, spec, io)` is the same without exiting the process.
  `io` is injectable, which is how the runtime's own tests drive it.

The design plans a `flowreel pipeline` binary that builds this spec from
`flowreel.config.ts`; it has not shipped yet (0.x), so the entry file above
is the supported way. Check the signature of `loadRun` against your
`adapter.ts`: it is project code, not runtime API.

## CI usage

Development only, on every pull request (no secrets needed):

```yaml
# .github/workflows/flowreel.yml (GitHub Actions example)
name: flowreel
on: [pull_request]
permissions:
  contents: read
jobs:
  development:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with: { persist-credentials: false }
      - uses: actions/setup-node@v7
        with: { node-version: 24, cache: npm }
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: sudo apt-get update && sudo apt-get install -y ffmpeg
      # exec: the pipeline becomes the step's own process, so a cancel
      # reaches it; --deadline ends it before the job's time limit.
      - run: exec npm run flowreel -- --local --deadline 25m
      # Only if you scaffolded with --tour (otherwise `tour` is not a module and this exits 64):
      # - run: exec npm run flowreel -- --module tour --local --pace qa --deadline 25m
      - if: always()
        uses: actions/upload-artifact@v7
        with:
          name: flowreel-summary
          path: |
            flowreel-results/**/summary.md
            flowreel-results/**/pipeline.md
          retention-days: 30
```

The job has no `timeout-minutes`, so GitHub's default of 360 minutes
applies; set one and size `--deadline` from it (see
[Time limits on CI](#time-limits-on-ci)).

In a real workflow, pin each action to a full commit SHA with the release
in a comment (`actions/checkout@<sha> # v7.0.1`), as this repository's own
`.github/workflows/ci.yml` does, and let Dependabot keep the pins current.

The release gate against staging, with secrets from your CI's secret
store. The names are the scaffold's (`FLOWREEL_BASE_URL`, then
`FLOWREEL_<PERSONA>_EMAIL` and `FLOWREEL_<PERSONA>_PASSWORD` for every
persona in your config); use whatever your `adapter.ts` requires:

```yaml
- run: exec npm run flowreel -- --deadline 50m
  env:
    FLOWREEL_BASE_URL: ${{ secrets.FLOWREEL_BASE_URL }}
    FLOWREEL_USER_EMAIL: ${{ secrets.FLOWREEL_USER_EMAIL }}
    FLOWREEL_USER_PASSWORD: ${{ secrets.FLOWREEL_USER_PASSWORD }}
    FLOWREEL_ADMIN_EMAIL: ${{ secrets.FLOWREEL_ADMIN_EMAIL }}
    FLOWREEL_ADMIN_PASSWORD: ${{ secrets.FLOWREEL_ADMIN_PASSWORD }}
```

A missing one is not a failure: development still runs, staging is
recorded as "not configured (missing …)" with the key names, and the
pipeline exits 2. Make your CI job fail on 2 for a release gate, so a
lost secret cannot pass silently.

<!-- TODO(verify): the GitHub Actions examples on this page have not been
run in a real workflow; check them (and the action versions). This
repository's own .github/workflows/ci.yml runs the minimal example the
same way. -->

Guidance:

- **Gate on the exit code.** Treat 0 as pass. Treat 2 as "staging not
  configured" (a setup problem, not a regression) and 3 as "nothing
  verified". Neither is a pass. Treat 4 as a page to a person: someone must
  follow `undo.md` by hand.
- **Upload only `summary.md` and `pipeline.md`** as artifacts. Traces,
  HTML reports, `.eml` files and staging videos can contain session
  cookies, reply tokens or staging data. If you must keep them, use a
  private, short retention (30 days or less). See
  [Safety](safety.md#results-and-retention).
- **No voice on Linux runners.** Videos there are silent unless you plug in
  a `VoiceEngine`. Use `--pace qa` (and `--no-video` if you do not need
  the MP4) to keep CI fast.
- **One run at a time per staging sender.** The inbound-mail budgets
  protect your staging app's rate limits. Do not fan the gate out in
  parallel against one staging host.
- `CI` set means `test.only` is refused, and a local web server is never
  reused.
- **Set a deadline.** See [Time limits on CI](#time-limits-on-ci).

### Time limits on CI

A CI job that runs out of time, or is cancelled, is stopped from outside,
and how depends on the CI. Do not rely on its signal: give the pipeline a
**deadline** below the job's limit, so it stops itself first. The CI's
cancel signal is a best effort on top.

`--deadline` (or `FLOWREEL_DEADLINE`, read when the flag is not given) takes
a duration from the pipeline's start (`90s`, `25m`, `1h`, or plain
milliseconds such as `90000`) or a time: an ISO time with a zone
(`2026-10-19T12:30:00Z`, `…+02:00`) or epoch milliseconds. There is no
default and nothing is derived from the CI. A value that is none of these,
a zero duration or an ISO time without a zone is a usage error (exit 64).

At the deadline, the pipeline:

- stops the running stage the way a first Ctrl-C does (the log says
  `deadline reached (--deadline 25m): stopping development`), so the test's
  video and trace are saved, the personas are signed out and the stage
  writes its summary;
- starts no further stage: it is recorded as `not run (deadline reached)`;
- makes no combined video, and stops one that is being composed.

A deadline already past when the pipeline starts stops it before anything
runs: no database copy is made, no stage starts, and every stage is
`not run (deadline reached)` (exit 130).

A stage is told the deadline (`FLOWREEL_DEADLINE_AT`) and skips its own
video when less than its compose budget is left (60 seconds by default,
`FLOWREEL_COMPOSE_BUDGET_SEC`): `video: not produced (skipped: not enough
time before the deadline)`. The pipeline skips the combined video the same
way. A stage stopped mid-test is a FAIL, so the pipeline exits 1; any other
run the deadline stopped is `INCOMPLETE`, exit 130, even when every stage
that ran passed; exit 4 outranks both.

**Pick the deadline** from the job's limit:

```text
deadline = job time limit − setup time (checkout, npm ci, browsers) − stop margin
```

Keep the stop margin at 2 to 5 minutes: the stage's teardown, sign-out and
summary, and the upload step after it. For `timeout-minutes: 30` with
about 5 minutes of setup, `--deadline 20m`. The duration counts from the
pipeline's start, not the job's, so setup time is already behind it; a
time (ISO or epoch milliseconds) does not need that subtraction.

GitLab gives the job's start and limit to the script, so the deadline can
be a time:

```yaml
# .gitlab-ci.yml (sketch): 5 minutes before the job's own limit
flowreel:
  script:
    - npm ci
    - npx playwright install --with-deps chromium
    - export FLOWREEL_DEADLINE=$(( ($(date -d "$CI_JOB_STARTED_AT" +%s) + CI_JOB_TIMEOUT - 300) * 1000 ))
    - npm run flowreel -- --local
```

How each CI stops a job (from its documentation and source):

| CI                         | On cancel or time-out                                                                                                                   | What reaches flowreel                                                                                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub Actions (1)         | SIGINT to the step's entry process, SIGTERM 7.5 s later, SIGKILL 2.5 s after that. Processes left over are killed at the end of the job | Only the entry process. For `run: npm run flowreel` that is bash, which passes neither signal on: write `run: exec npm run flowreel …`. In a container job, `docker exec` passes no signal on |
| GitLab, shell executor (2) | SIGTERM to the job's process group, SIGKILL after the graceful timeout                                                                  | Every process: the pipeline and the stage                                                                                                                                                     |
| GitLab, docker executor    | SIGTERM to every process in the container, newest first, then the container is stopped                                                  | Every process                                                                                                                                                                                 |
| Buildkite (3)              | `cancel-signal` (default SIGTERM) to the process group, SIGKILL after `cancel-signal-timeout` (about 10 s)                              | Every process                                                                                                                                                                                 |
| Jenkins (4)                | SIGTERM to every process of the build, the leaves of the process tree first; a SIGKILL is not guaranteed                                | Every process                                                                                                                                                                                 |
| CircleCI                   | not documented                                                                                                                          | Treat it as an immediate kill: only the deadline helps                                                                                                                                        |

Sources:
(1) [GitHub: workflow cancellation](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-cancellation),
[ProcessInvoker.cs](https://github.com/actions/runner/blob/main/src/Runner.Sdk/ProcessInvoker.cs)
and JobExtension.cs in actions/runner;
(2) [GitLab Runner: the shell executor](https://docs.gitlab.com/runner/executors/shell/);
(3) [Buildkite agent lifecycle](https://buildkite.com/docs/agent/lifecycle);
(4) Jenkins' `ProcessTree.java`.

When the signal reaches every process, the stage gets it too: the stage
guard turns its SIGTERM into a Ctrl-C, and its browsers leave SIGTERM to
the runner, so the running test's video is kept. GitHub's SIGINT then
SIGTERM is handled as one stop: the SIGTERM never forces it (see
[Interrupting a run](#interrupting-a-run)). `npm run` passes SIGINT and
SIGTERM on to the command it runs, once each.

Whatever the CI, upload the results with `if: always()` (or your CI's
equivalent), so a stopped run's `pipeline.md`, `summary.md` and
`pipeline.json` status still reach you.

<!-- TODO(verify): a live GitHub Actions cancel (and time-out) of a
pipeline run with `exec` has not been observed yet; the table above is
from the documentation and the runner's source. -->

## Interrupting a run

A stopped run is never a pass. On Ctrl-C, a CI's stop signal or the
`--deadline`, flowreel asks the running stage to stop the way Ctrl-C does:
the browser closes, so the test's video and trace are saved, the personas
are signed out, and the stage writes its summary; no further stage starts.
On a hard kill nothing can save the video, but the verdict stays FAIL and
the undo ledger still names anything left to put back.

Why "the way Ctrl-C does": Playwright's test runner stops gracefully only
on SIGINT. It has no SIGTERM handler, so a SIGTERM ends it at once: no
teardown, no summary, and the web server left running. A second SIGINT a
second or more after the first cuts its teardown short. flowreel therefore
turns every other way of being told to stop into that one SIGINT.

| What arrives                                                                                     | What flowreel does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The first stop request**: Ctrl-C (SIGINT), SIGTERM, Ctrl-Break on Windows, or the `--deadline` | The pipeline asks the running stage to stop (on macOS and Linux it sends it SIGINT; on Windows the console's Ctrl-C already reached it). It starts no further stage, records the next one as `not run (interrupted)` or `not run (deadline reached)`, makes no combined video, and rewrites `pipeline.json` with `"status": "stopping"`. After a Ctrl-C the log adds `press Ctrl-C again to stop now without waiting`.                                                                                                                                                      |
| The same signal again within 200 ms                                                              | Ignored: a terminal and `npm run` deliver one Ctrl-C twice.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **A SIGTERM after the first stop request**                                                       | Never forces. The log says `SIGTERM after the stop request: still finishing the stage's report; a kill may follow`. GitHub Actions sends SIGINT, then SIGTERM 7.5 s later: the stage keeps finishing its report.                                                                                                                                                                                                                                                                                                                                                            |
| **A second Ctrl-C** (SIGINT or Ctrl-Break), 200 ms or more after the first stop request          | Stops now: writes the final `pipeline.json` (`"status": "aborted"`, reason `aborted by a second Ctrl-C`) and `pipeline.md`, gives the stage 3 s to close, then kills it (SIGKILL), drops the development database copy (unless `--keep-db`) and exits 130. A stage that closes within the 3 s keeps its own verdict (a FAIL outranks the abort), and a restore its undo ledger still lists as pending makes the exit 4. A Ctrl-C after the deadline counts as this second one.                                                                                              |
| **The pipeline itself is killed** (SIGKILL, say)                                                 | The stage checks every second that the pipeline (`FLOWREEL_PIPELINE_PID`) still exists, and stops as on a Ctrl-C when it is gone: video, trace, sign-out and summary are still written. `pipeline.json` keeps the status it had (`running` or `stopping`).                                                                                                                                                                                                                                                                                                                  |
| **SIGTERM to the stage itself** (a CI that signals the whole process group)                      | The stage turns it into a Ctrl-C (the stage guard, below), and its browsers do not close themselves on it (`createConfig()` sets `handleSIGTERM: false`), so the running test's video is kept.                                                                                                                                                                                                                                                                                                                                                                              |
| **A stop signal while a video is composed**                                                      | A stage's video, or the pipeline's combined video: the composition ends within moments (ffmpeg, the voice engine and the card browser are stopped), and the summary or `pipeline.json` says `video: not produced (video composition stopped (interrupted))`. A second Ctrl-C waits up to 3 s for the stopped encode to end, then exits. The stage's summary reporter listens from the start of the run, so a signal that lands after Playwright's teardown, while the other reporters finish, is caught too; a second Ctrl-C a second or more later then exits 130 at once. |
| **The terminal closes** (SIGHUP)                                                                 | Only when the pipeline runs in a terminal: the pipeline and the stage treat the hangup as a first stop request that never forces (`FLOWREEL_HUP=graceful`), and the pipeline ignores the closed terminal's output errors so it can still write `pipeline.json`. The browsers keep Playwright's own SIGHUP handling and close at once, so the running test's video may be lost. Without a terminal, SIGHUP keeps its default, so `nohup` works as usual.                                                                                                                     |

Verdicts: a stage stopped mid-test is a FAIL (the stopped test counts as
failed), so the pipeline exits 1. Any other stopped run is `INCOMPLETE`
with exit 130, even when every stage that ran passed (a stop between
stages, before the first, or during the combined video, and a `--local`
run whose stage passed although it was stopped): a stopped run is never a
PASS, and the reason names the stop. Exit 4 outranks both.

**The stage guard.** The summary reporter installs it first thing
(`installStageGuard()` from `@confidee/flowreel/reporter`), so the web
server's start and the sign-ins are covered too, and it works for a plain
`playwright test` as well as for a pipeline stage. It turns SIGTERM (and
Ctrl-Break on Windows) into a Ctrl-C, or exits 130 when Playwright's runner
is not listening yet. Only the first stop request becomes a Ctrl-C: once
the run is stopping, a later SIGTERM, a vanished pipeline or a hangup is
only logged, so the teardown is never cut short. It also ignores output
errors from a pipe whose reader is gone, so a stage whose pipeline died
does not crash on its next log line.

**Sign-out, even when stopped early.** A stop during sign-in no longer
leaves a session live: the global teardown waits (up to 60 s) for sign-ins
still in flight, then signs out. If the teardown was cut short (a second
SIGINT to the stage itself, for example), the summary reporter finishes the
job before it writes the summary: it waits for a teardown sign-out that is
still under way (never signing out twice), or else waits up to 20 s for
restores still pending in the undo ledger and signs the personas out
itself, and says so in the log. A second Ctrl-C to the pipeline gives the
stage only 3 s before it is killed, which may be too short for either.

**What cannot be caught.** Nothing can catch SIGKILL. A stage killed
outright writes no summary and may lose the running test's video: the
pipeline records it FAIL (`no summary written (playwright exited by
signal)`), or exit 4 when its write-ahead undo ledger still lists a change
that was not put back. A pipeline killed outright leaves `pipeline.json`
with `"status": "running"` or `"stopping"`. The undo ledger (`undo.json`
and `undo.md` in the stage's run folder) is written before each change, so
it is on disk either way: check it and put back by hand anything it lists
as not restored.

**Windows.** Ctrl-C and Ctrl-Break are handled; the console delivers them
to the stage too, so the pipeline never signals it. The pipeline cannot
stop a stage on Windows, so the stage stops itself at the deadline
(`FLOWREEL_DEADLINE_AT`), once Playwright's runner listens for Ctrl-C; a
deadline already past when the stage starts is only logged. A stage needs
`@playwright/test` resolvable from the project (there is no npx fallback).
Running flowreel in CI on Windows has not been verified.
