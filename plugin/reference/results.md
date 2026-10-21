# flowreel results: where they are and how to read them

Read by `/flowreel:run`, `/flowreel:explain` and the `run-explainer` agent.
Everything here is what flowreel WRITES; you report it, you never decide it.

## Contents

- Exit codes
- Folders
- pipeline.json
- summary.json
- How to report (order matters)

## Exit codes (the pipeline command)

| Code | Meaning                                                                                                                                                                                                           |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | every stage that ran passed                                                                                                                                                                                       |
| 1    | a stage FAILED (development FAIL means staging did not run: the gate working)                                                                                                                                     |
| 2    | development passed, staging is **not configured** (its secrets are not in this shell)                                                                                                                             |
| 3    | a stage that ran was N/A: nothing was verified                                                                                                                                                                    |
| 4    | **undo failed: manual action needed.** Outranks every other code. Also when a stage died before writing its summary but its `undo.json` still holds unrestored entries                                            |
| 64   | bad arguments (the usage line is printed)                                                                                                                                                                         |
| 130  | **stopped** (Ctrl-C, a CI's stop signal or the `--deadline`): before a stage that would have run, while every stage that ran passed, or aborted by a second Ctrl-C. INCOMPLETE, never a pass; report what did run |

## Folders

`<results>` is `results` in `flowreel.config.ts` (the template's default:
`flowreel-results/`). The log's last `[pipeline] Summary:` line names the
pipeline's own `pipeline.md`.

```
<results>/<PIPELINE_ID>/pipeline.md, pipeline.json, <module>-<PIPELINE_ID>.mp4
<results>/<RUN_ID>/            one per stage that ran (loc-… development, stg-… staging)
    summary.md                 for people: the only file that may leave the machine
    summary.json               for tools (below)
    summary.lines              <file>:<line>: error: [<step>] <message>
    undo.json, undo.md         the undo ledger (tours that changed shared config)
    report/                    Playwright HTML report        (credential-bearing)
    test-results/              traces, screenshots, videos   (credential-bearing)
    <module>-<RUN_ID>.mp4      the branded run video (tour: one per area + the full tour)
<demos dir>/latest/            published demo videos + README.md + demos.json
```

## pipeline.json

`status`: `running`, `stopping`, `finished` or `aborted`. The file is
written ahead and rewritten as the pipeline goes: **a status other than
`finished` means the pipeline did not finish; report what the stage
folders hold** (each stage's `summary.json`, or its `undo.md` when there
is none) and never a pipeline verdict of your own. `stoppedBy` names what
stopped it early (`Ctrl-C (SIGINT)`, `SIGTERM`, `the deadline (--deadline
25m)`, `…, then a second Ctrl-C`), or is null. `finishedAt` is null until
it finished.

`verdict` (`PASS` | `FAIL` | `N/A` | `INCOMPLETE` = development passed
but staging is not configured (exit 2), or a stop (Ctrl-C, a CI's stop
signal, the deadline) stopped the pipeline and no stage failed: a stopped
run is never a pass (exit 130)), `verdictReason`, `exitCode`, `options`, and
`stages[]`, each with: `stage` (development | staging), `verdict` (`PASS`,
`FAIL`, `N/A`, `not run`, `not configured`, `skipped`; while the
pipeline runs, a stage not finished yet is `not run` with reason
`pending`, `running` or `stopping`, and one cut off by a second Ctrl-C has
reason `aborted by a second Ctrl-C`), `reason`, `runId`,
`resultsDir`, `summary` / `summaryJson` (paths, or null when the stage
never wrote one), `video`, `undoChanges`, `undoFailed`, `undoFile`,
`durationMs`, `exitCode`. Plus `video` (the combined video: `produced`,
`path` or `reason`) and `narration`; a project may add fields (a tour's
side-by-side `features`, say).

## summary.json

| Field                                 | What                                                                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `verdict`, `verdictReason`            | `PASS`, `FAIL` or `N/A` and why                                                                                        |
| `target`, `module`, `runId`, `gitSha` | what ran where                                                                                                         |
| `tests[]`                             | per test: `project`, `title`, `status`, `steps[]` (`id`, `status`, `durationMs`, error message and location if failed) |
| `latenciesMs`                         | hop latencies (`latency.<key>` facts)                                                                                  |
| `couldNotCheck`                       | what the run could not verify (never a failure, never a pass)                                                          |
| `errors`                              | runner errors outside a test (setup, config)                                                                           |
| `features[]` (tours)                  | `id`, `title`, `area`, `policy`, `status` (`passed`, `failed`, `dev-only`, `view-only`, `N/A`), `reason`, `videoAtSec` |
| `undo`                                | `total`, `restored`, `failed`, `pending`, `file`, `manual[]` (`feature`, `what`, `status`, `error`, `manual`)          |
| `video`                               | `produced` + `path`, or `produced: false` + `reason` (never affects the verdict)                                       |
| `tourVideo` (tours)                   | the per-area MP4s and the full tour MP4                                                                                |
| `pace`                                | `pace` (`demo` / `qa`) and `slowFactor`                                                                                |
| `narration`                           | produced (voice, line counts, cached) or `reason`                                                                      |
| `demos`                               | what was copied to `latest/`, or why not                                                                               |
| `htmlReport`, `resultsDir`            | paths (credential-bearing)                                                                                             |

## How to report (order matters)

1. **Undo first.** Exit 4, any stage with `undoFailed > 0`, or any
   `summary.json` with `undo.manual` entries: say so BEFORE anything else:
   which shared changes on which target were not put back, each entry's
   manual instructions (from `undo.manual` or the stage's `undo.md`), and
   that a person must do them now. Read `undo.md` even when `summaryJson`
   is null. Never restore anything yourself.
2. **Pipeline verdict**, then each stage with its verdict. A staging
   `not run (development FAIL)` is the gate working, not a staging failure.
   `INCOMPLETE` / exit 2: report development's result and ask the user to
   run staging themselves with the secrets injected (`--staging-only` skips
   repeating development).
3. **Per stage that ran:** the verdict; **N/A distinctly** from PASS and
   FAIL, with its reason (N/A means nothing was verified). For each failed
   step: its id, the message, and what the step checks (from the plan
   file). Hop latencies and the "could not check" list.
4. **Tours:** the feature table (id, title, status, `videoAtSec`), failed
   features with their failing step (`<id>.<n> …`) and message. `dev-only`
   on staging is the policy working (a card in the video), never a failure.
5. **Videos:** `video.path` (offer to open it: `open <path>` on macOS; a
   failed step's caption is red), or `video.reason` when not produced
   (e.g. "ffmpeg not found on PATH": the doctor fixes that). For a
   pipeline, offer the combined video first. Pace and the narration line
   as printed; a "using fallback voice" warning means no Premium voice is
   installed (the doctor explains). After a development demo-pace run,
   `demos` lists what reached `latest/`; offer to open that folder.
6. **Evidence and retention:** the run folders, the HTML report
   (`npx playwright show-report <results>/<RUN_ID>/report`), and that they
   are credential-bearing: only `summary.md` / `pipeline.md` may be
   shared. Check the teardown's `signed out` / `WARNING` lines. Suggest
   deleting a run folder once its `summary.md` is filed (at most 30 days);
   never delete it yourself unless asked.

Common messages:

- `Refusing base URL …` / `production hosts are never a QA target`: the
  allowlist worked; nothing ran against that host.
- `Refusing to send to …` (`SendRefusedError`): the send guard stopped a
  recipient off the configured domain; nothing was sent. Never propose
  widening the guard.
- `InboundBudgetError … in the last 60 minutes`: the cross-run sender
  ledger refused a mail before sending; report the time it names, never
  re-run sooner.
- `LoginError`: a persona could not sign in. Check its configured account;
  do not retry before the app's lockout window has passed.
- `… are both set, to different values`: `FLOWREEL_<KEY>` and a project
  alias disagree; the user unsets one.
- `The mail may have been sent; it is not retried …`, followed by
  `For Microsoft support: client-request-id …` (`mayHaveSent`): a FAIL that needs a check in the app before any re-run.
  The mail may have arrived: the user searches the app for the run id or
  the record, or runs an Exchange message trace by sender and subject.
  Quote the `client-request-id` (and `request-id` and `date`, when named)
  for Microsoft support. Never propose re-sending the mail, by hand or by
  re-running, before that check.
