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

- Each stage is one `npx playwright test` child process, with its own run
  id, a clean environment and its output prefixed `[development]` or
  `[staging]`. A stage is never retried.
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
| `--help`, `-h`        | Print the usage text and exit 0.                                                                                 |

Flags take values as `--flag value` or `--flag=value`. An unknown flag, a
missing or unknown value, a value on a flag that takes none, or a tour-only
flag on a non-tour module is a usage error: exit 64, with the message and
the usage text.

## Exit codes

The exit code reflects **only the stages that ran**:

| Code  | Verdict    | Meaning                                                                                                                                                          |
| ----- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`   | PASS       | every stage that ran passed                                                                                                                                      |
| `1`   | FAIL       | a stage failed, a stage died before writing its summary, a stage exited non-zero after a PASS summary, or the runner itself crashed                              |
| `2`   | INCOMPLETE | development passed, but staging is not configured in this environment (`missing …` names the keys). Not a failure: inject the secrets and run again              |
| `3`   | N/A        | a stage that ran verified nothing (the gate test skipped with `N/A:`, or every tour feature was development-only)                                                |
| `4`   | (any)      | **undo failed, manual action needed**: a shared-config change or a run record could not be put back. Outranks every other code. Read the stage's `undo.md` first |
| `64`  |            | bad arguments                                                                                                                                                    |
| `130` | INCOMPLETE | interrupted: Ctrl-C stopped the pipeline before a stage that would have run, or a second Ctrl-C (see [Interrupting a run](#interrupting-a-run))                  |

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
    "narration": null
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

Both files are written before the combined video starts and again after
it, so a composition that is killed still leaves both. A disk error writing
one file is logged and does not change the exit code.

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
      - run: npm run flowreel -- --local
      # Only if you scaffolded with --tour (otherwise `tour` is not a module and this exits 64):
      # - run: npm run flowreel -- --module tour --local --pace qa
      - if: always()
        uses: actions/upload-artifact@v7
        with:
          name: flowreel-summary
          path: |
            flowreel-results/**/summary.md
            flowreel-results/**/pipeline.md
          retention-days: 30
```

In a real workflow, pin each action to a full commit SHA with the release
in a comment (`actions/checkout@<sha> # v7.0.1`), as this repository's own
`.github/workflows/ci.yml` does, and let Dependabot keep the pins current.

The release gate against staging, with secrets from your CI's secret
store. The names are the scaffold's (`FLOWREEL_BASE_URL`, then
`FLOWREEL_<PERSONA>_EMAIL` and `FLOWREEL_<PERSONA>_PASSWORD` for every
persona in your config); use whatever your `adapter.ts` requires:

```yaml
- run: npm run flowreel
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

## Interrupting a run

- **First Ctrl-C:** reaches the running child too. The pipeline lets the
  current stage write its report, starts no further stage, records staging
  as `not run (interrupted)`, and still writes `pipeline.md` and
  `pipeline.json`. The verdict is `INCOMPLETE` and the exit code 130, even
  when development passed: a stage that would have run did not, so it is
  never a PASS. A failure that did happen still exits 1, and an undo
  failure 4.
- **Second Ctrl-C:** drops the development database copy (unless
  `--keep-db`) and exits with 130 at once.
