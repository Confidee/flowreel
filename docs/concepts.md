# Concepts

flowreel has a small vocabulary. This page defines each term once. The other
guides use them without explaining them again.

- [Targets](#targets)
- [Modules](#modules)
- [Plans](#plans)
- [Features, areas and the catalogue](#features-areas-and-the-catalogue)
- [Policies](#policies)
- [Steps](#steps)
- [Personas](#personas)
- [Runs, stages and the pipeline gate](#runs-stages-and-the-pipeline-gate)
- [Verdicts](#verdicts)
- [The undo ledger](#the-undo-ledger)
- [Cleanup of run records](#cleanup-of-run-records)
- [Texts](#texts)
- [Pace](#pace)
- [Narration](#narration)
- [Videos and demos](#videos-and-demos)
- [Adapters](#adapters)

## Targets

A **target** is where a run points. There are exactly two:

| Target    | What it is                                                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local`   | The **development** stage: your app on a loopback host (`localhost`, `127.0.0.1` or `[::1]`) on a port inside a fixed range, usually with test-only seams for sign-in and mail. |
| `staging` | The **staging** stage: one of an exact list of `https://` origins, with real sign-in and, optionally, real mail.                                                                |

A production host is refused for every target, even if you list it by
mistake. The target comes only from the process environment
(`FLOWREEL_TARGET`), never from a secrets file, so a run is a staging run
only when someone explicitly asked for one. See [Safety](safety.md).

## Modules

A **module** is what one run exercises. It is named in your config
(`modules.names`) and selected with `--module`. Modules come in two kinds:

- **Round trip** (`kind: "round-trip"`): one gate test with a sequence of
  steps, for example "a customer emails support, an agent replies, the
  customer receives the reply". It is the release gate. A project has
  exactly one.
- **Tour** (`kind: "tour"`): many feature tests, grouped into areas, each
  with its own staging policy. It is the regression and demo surface. A
  project has at most one.

Both are described to the reporter by a
[`ModuleDescriptor`](adapters.md#moduledescriptor).

## Plans

A **plan** is the human contract for a module or a tour area: a Markdown
file in `e2e/flowreel/plans/` that lists every feature (or step), what the
flow does, what it expects, its staging policy and any undo it needs. Plans
are written in plain English, for reviewers who do not read TypeScript.

The plan and the flow change together. For a round trip, the reporter reads
the plan's step table (`planFile` and `planStepPattern` on the module), so
every step id appears in `summary.md` even if the run stopped before
reaching it.

## Features, areas and the catalogue

In a tour, a **feature** is one user-visible capability with one Playwright
test, for example `A4 list-search`.

- A feature **id** is an area letter plus a number (`A4`).
- An **area** is a group of related features with a letter and a title
  (`A`, "Listing and creation"). Each area is its own Playwright project,
  `tour-a` by default, behind one setup project.
- The **catalogue** is the list of every feature with its slug and its
  owner-approved staging policy. You keep it as a Markdown document (the
  inventory). A committed copy in your `TourManifest` is checked against it
  by `parseCatalogue()` in a unit test.

The test title is `"<id> <slug>"`. `feature()` refuses a title, slug or
policy that does not match the catalogue.

## Policies

A **policy** says what a feature may do on staging. The project owner sets
it in the catalogue, and only `feature()` applies it:

| Policy      | Development | Staging                                                                                 |
| ----------- | ----------- | --------------------------------------------------------------------------------------- |
| `both`      | runs        | runs, on objects the run created itself                                                 |
| `both+undo` | runs        | runs; every change to shared configuration goes through the undo ledger                 |
| `dev`       | runs        | skipped as `development only: <reason>`; counted as development-only, never FAIL        |
| `view`      | runs        | renders the page read-only (`ctx.mode === "view"`): assert what is shown, write nothing |

A flow cannot pick its own target or skip itself. A static tripwire
(`scanAreaSpec`, `checkDeclaredFeatures`) fails your unit tests if a test
does not start with `feature()`, uses a hook, or calls `test.skip`,
`test.only`, `test.fixme`, `test.fail` or `test.slow` anywhere.

## Steps

A **step** is one `test.step()` in a flow, titled `"<id>.<n> <sentence>"`
(for example `"A4.1 Search finds the order by its number"`). The step title
has three jobs:

- the **caption** in the video shows the code and the sentence;
- the **narration** speaks the sentence when there is no curated line;
- the **summary** lists the step with its status and duration.

So write each sentence for a viewer, in the present tense.

## Personas

A **persona** is a named account a flow acts as, for example `agent`,
`admin` or `customer`. Personas are listed in your config in sign-in order.

- Global setup signs each persona in **once per run**, through your
  `AppAdapter`. A failed sign-in is never retried, because an app's lockout
  counter counts every attempt.
- Each session is handed to the workers as JSON in an environment variable
  (`FLOWREEL_STATE_<PERSONA>`). It is never written to disk.
- Personas that share an email address and a session kind share one
  session.
- The recorded page can **swap** persona by swapping cookies, without
  signing in. The video shows an "as <persona>" badge.
- `as(persona)` gives a flow an API client for that persona, for setup and
  checks off camera.
- Global teardown revokes every session, on pass and on fail, and proves
  each one is dead.

A persona that is not configured on a target (for example, a second admin
that only exists locally) makes the features that need it `dev` features.

## Runs, stages and the pipeline gate

- A **run** is one `playwright test` invocation against one target. Its id
  is `loc-YYYYMMDD-HHMM-xxxx` (local) or `stg-…` (staging), in UTC with four
  random hex digits. Its evidence goes to `<results>/<RUN_ID>/`.
- A **pipeline** runs up to two **stages** in order: `development` (a local
  run) and then `staging` (a staging run). Its id is `pipe-…`.
- **The gate:** staging runs only after a development PASS, unless you pass
  `--staging-only`. `--local` runs development only.

Each stage is a separate child process with a clean environment. Staging
secrets reach only the staging stage, and the variables that say what a
run _is_ (target, run id, module) are set fresh for each stage, never
inherited from your shell. See [Pipeline and gates](pipeline-and-gates.md).

## Verdicts

A run's **verdict** is decided only by Playwright assertions:

| Verdict      | Meaning                                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PASS`       | every step that ran passed (tour: at least one feature verified, none failed)                                                                          |
| `FAIL`       | at least one step or feature failed, or the run died before writing a summary                                                                          |
| `N/A`        | nothing was verified: the gate test skipped with an `N/A:` reason, or every feature was dev-only                                                       |
| `INCOMPLETE` | pipeline only: development passed but staging is not configured (exit 2), or Ctrl-C stopped the pipeline before a stage that would have run (exit 130) |

N/A is not a pass. The video, the narration and the demos are produced
after the verdict is fixed and can never change it. The plugin explains
verdicts. It never decides one.

## The undo ledger

Some features must change shared configuration on staging: a default
setting, a feature flag, a team membership. The **undo ledger** makes that
safe:

1. **Write-ahead.** Before the flow makes the change, `undo.change()`
   writes what will change, the before-state and manual restore
   instructions to `<RUN_ID>/undo.json` and `undo.md`.
2. **Restore.** After the test (pass, fail or timeout), the feature's
   changes are restored newest first by your `restore` function. It must
   re-read the state to confirm the restore took effect. Anything left over
   is restored again at the end of the worker.
3. **Report.** Each entry ends up `restored` or `FAILED`. A failed restore
   never changes a feature's verdict, but the run exits non-zero and the
   pipeline exits **4**, "undo failed: manual action needed". `undo.md`
   lists the manual steps first.

An entry still `pending` after a crash also counts, so a run that died
mid-change still exits 4.

## Cleanup of run records

Flows create records (orders, messages, cases) on a shared target. After
every feature, outside the recording, the **off-camera cleanup** closes the
records the run created. It finds them by the numbers the flow tracked, plus
any open record whose subject carries the run marker `[QA <RUN_ID>]`. It
only ever touches records that match your `CleanupAdapter`'s number shape
**and** are this run's. A record it cannot close becomes a FAILED undo
entry, which means exit 4. See [CleanupAdapter](adapters.md#cleanupadapter).

## Texts

Every string a flow types or sends (subjects, message bodies, names) lives
in a **texts file**, `e2e/flowreel/texts/<module>.json`, with `subjects`
and `bodies` groups and `{NAME}` placeholders. Keeping them in one place
means one guard can check them all before anything reaches the app, for
example for forbidden vocabulary or personal data. An unknown placeholder
is an error, so a typo never reaches the app.

## Pace

**Pace** sets how fast a tour runs and how its video plays:

| Pace             | Browser                                                    | Video                                                                               |
| ---------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `demo` (default) | slowMo 650 ms; `pause()` holds 1.8 s after a key assertion | plays at 1/1.5 speed; long waits play in real time with a "waiting" badge; narrated |
| `qa`             | no slowMo, no pauses                                       | real time; long waits fast-forwarded (up to 20x); silent                            |

Use `qa` while writing and debugging, and `demo` for evidence and demos.
A round trip has no browser pace. Its video is composed at demo pace when
narrated, otherwise at qa pace.

## Narration

**Narration** is the spoken track of a video. Every step is spoken from its
title by default. Curated lines in `e2e/flowreel/narration/<module>.json`
override it per step, per feature card, per email card and for the intro
and outro. Addresses, links, run ids, QA subject prefixes, long opaque
tokens and your own patterns (record numbers, internal ids) are removed
before anything is spoken. Narration is on at demo pace for tours, off at
qa pace, and off for the round trip unless you turn it on. See
[Narration and videos](narration-and-videos.md).

## Videos and demos

- Every run makes a **run video**: for the round trip, one MP4; for a tour,
  one MP4 per area plus the full tour.
- Every pipeline makes a **combined video** with both stages and a
  comparison card.
- A demo-pace **development** run that produced videos publishes them to
  the **demos folder**, `<demos>/latest/`, under fixed names, with a
  README. An automatic publish never replaces a passing video with a
  failing one. A staging run reaches `latest/` only when you publish it on
  purpose. A qa-pace run never touches it.

## Adapters

flowreel's core knows nothing about your app. **Adapters** are the small
interfaces you implement (or take from a subpath) to connect it:
`AppAdapter` (sign-in), `MailDriver` (mail), `DbIsolation` (a database per
run), `CleanupAdapter` (closing run records), `Brand` and `CardCopy` (how
videos look and read), `VoiceEngine` (speech), `ModuleDescriptor`
(modules for the reporter), `TourManifest` (the tour) and `DemoCatalogue`
(the demos folder). See [Adapters](adapters.md).
