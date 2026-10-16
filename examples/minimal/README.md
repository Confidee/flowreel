# flowreel minimal example

The quickest way to see flowreel work. A tiny notes app (plain HTML and a
little JavaScript, served by a Node server with no dependencies), three
flows and one command. The command produces a pass/fail report and a
narrated, branded MP4 of every step.

It uses no Rails, no Inertia and no mail: only the flowreel core over a web
app. The same pieces drive larger projects.

## Run it

You need:

- Node.js 20 or later.
- ffmpeg and ffprobe, built with libx264 and AAC, for the video
  (`brew install ffmpeg` on macOS, `apt install ffmpeg` on Debian or
  Ubuntu; `ffmpeg -encoders | grep -E 'libx264|aac'` should list both).
  Without ffmpeg the run still gives its verdict, but makes no video.
- Chromium for Playwright (`npx playwright install chromium`, step 2 below).
  On Debian or Ubuntu, Chromium also needs system libraries (libnss3,
  libatk and others): run `npx playwright install --with-deps chromium`
  instead, which installs them with `sudo apt`, or run
  `sudo npx playwright install-deps chromium` after the plain install.
- Optional: a macOS Premium voice for the narration. Open System Settings,
  then Accessibility, then Read & Speak (Spoken Content on older macOS),
  then System Voice, then Manage Voices, and download an English Premium
  voice such as Ava. Without one the run falls back to Samantha; off macOS
  the video is silent.

In Claude Code, `/flowreel:doctor` checks all of these and offers the
install commands. Install the plugin first to get that command (see
[Install](../../docs/plugin.md#install)). The example itself does not need
the plugin: the steps below use only npm and Playwright.

The example installs the runtime from this repository
(`"@confidee/flowreel": "file:../../runtime"` in its `package.json`), so
it needs a clone of the whole repository, not just this folder. That way
it always runs against the runtime next to it, released or not.

Run the commands from the folder that holds this README:

```bash
# 1. Build the runtime once (the example installs it from ../../runtime).
cd ../../runtime
npm ci
npm run build

# 2. Install the example and the browser it records with.
cd ../examples/minimal
npm ci
npx playwright install chromium   # Debian or Ubuntu: add --with-deps (sudo)

# 3. Run it.
npx playwright test
```

The run starts the Notes server on `http://127.0.0.1:3179`, signs in two
people (an editor and an admin) and runs three features at demo pace. When
the tests finish, it composes the videos. On a recent Mac the whole run takes
under a minute (about 45 seconds the first time, when it also records the
voice clips) and makes a video of about a minute and a half. Off macOS it
makes the same tour as a silent, shorter video.

```text
[notes] local (notes-tour): signed in 2 persona(s) for run loc-20261015-1048-1e1f.

Running 4 tests using 1 worker

  ✓  1 [tour-setup] › e2e/flowreel/flows/setup.spec.ts:11:1 › tour setup (29ms)
  ✓  2 [tour-a] › e2e/flowreel/flows/a1-create-note.spec.ts:10:1 › A1 create-note (11.2s)
  ✓  3 [tour-a] › e2e/flowreel/flows/a2-workspace-greeting.spec.ts:10:1 › A2 workspace-greeting (9.9s)
  ✓  4 [tour-a] › e2e/flowreel/flows/a3-delete-note.spec.ts:11:1 › A3 delete-note (5.4s)
[notes] signed out the editor persona (DELETE /session -> 204).
[notes] signed out the admin persona (DELETE /session -> 204).

  4 passed (27.7s)
[notes] PASS: 3 tour feature(s) verified. Summary: flowreel-results/loc-…/summary.md
[notes] video: flowreel-results/loc-…/notes-tour-loc-….mp4 (88.3s)
[notes] pace: demo (slow factor 1.5); narration: Ava (Premium) (19 lines, 19 synthesized, 0 cached)
[notes] area A video: flowreel-results/loc-…/tour-a-loc-….mp4 (83.6s)
```

Open the video with `open flowreel-results/*/notes-tour-*.mp4` (macOS).

## What you get

Everything lands in `flowreel-results/<RUN_ID>/`, which git ignores:

| File                       | What it is                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------- |
| `summary.md`               | The verdict, the feature table, every step and the undo summary, written for people |
| `summary.json`             | The same information for tools                                                      |
| `summary.lines`            | One `file:line: error:` line per failed step, for an editor's problem matcher       |
| `notes-tour-<RUN_ID>.mp4`  | The whole tour: intro, each feature's title card and recording, scoreboard          |
| `tour-a-<RUN_ID>.mp4`      | Area A on its own                                                                   |
| `undo.md`, `undo.json`     | The undo ledger: what A2 changed and whether it was put back                        |
| `report/`, `test-results/` | Playwright's HTML report, traces, screenshots and raw recordings                    |

Treat the results folder as credential-bearing: traces record the session
cookies. Global teardown signs every persona out, so those cookies are dead
when the run ends. Even so, share only `summary.md`.

## Try a variation

| Command                                              | What changes                                                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `FLOWREEL_PACE=qa npx playwright test`               | As fast as the app allows; a shorter, silent video                                                            |
| `FLOWREEL_NARRATION=off npx playwright test`         | Demo pace, no voice                                                                                           |
| `FLOWREEL_VOICE_ENGINE=none npx playwright test`     | What a machine without macOS `say` makes: the same features, silent and shorter (no spoken lines to wait for) |
| `FLOWREEL_VOICE="Zoe (Premium)" npx playwright test` | Another installed voice (`say -v '?'` lists them)                                                             |
| `FLOWREEL_VIDEO=off npx playwright test`             | No recording and no video, only the report                                                                    |
| `FLOWREEL_LOCAL_PORT=3171 npx playwright test`       | Another port (3170 to 3199)                                                                                   |
| `FLOWREEL_TARGET=staging npx playwright test`        | Refused before any request: this example lists no staging origin                                              |

Narration clips are cached in `.flowreel/cache/voice/`, so a second run
reuses them ("19 cached"). Without a Premium or Enhanced English voice the
run falls back to Samantha and says so (see the prerequisites above to
install one).

## From scratch with the plugin

The steps above run the example as shipped. It is already scaffolded, so
`/flowreel:init` has nothing to do here: it finds `flowreel.config.ts` and
stops, because it never overwrites a file. To walk the path a new project
takes (doctor, then init, then a green run), start from the app alone.

You need the plugin installed ([Install](../../docs/plugin.md#install)).
The runtime built in your checkout (step 1 of [Run it](#run-it)) is needed
only if you install the runtime from your clone (step 3 below). Then, from
the folder that holds this README:

```bash
mkdir ~/notes-fresh && cp -R app ~/notes-fresh/
```

Open Claude Code in `~/notes-fresh` and run:

1. **`/flowreel:doctor`.** In a folder with no `package.json`, it reports
   `@playwright/test` missing and offers `npm i -D @playwright/test`. Say
   yes; that command also creates `package.json`.
2. **`/flowreel:init --tour`.** It proposes answers from the app. For Notes
   they are:

   | Question                     | Answer for Notes                                                                           |
   | ---------------------------- | ------------------------------------------------------------------------------------------ |
   | Staging origin               | None. Keep the placeholder and run with `--local` only                                     |
   | Production hosts             | `notes.example.com`                                                                        |
   | Local host and port range    | `127.0.0.1`, 3170 to 3199                                                                  |
   | Start command and ready path | `node app/server.mjs --port <port>`, ready at `/up`                                        |
   | Sign-in                      | `/sign-in`, labels `Email` and `Password`, button "Sign in", no test-only seam             |
   | Sign-out                     | `DELETE /session`, no CSRF header                                                          |
   | Personas                     | `user` is `editor@example.test`, `admin` is `admin@example.test`; password `flowreel-demo` |
   | Health check                 | `GET /up`                                                                                  |
   | Modules                      | `smoke` (the round trip) and `tour`                                                        |
   | Brand                        | `Notes` and any primary colour                                                             |

   The scaffolded smoke flow (open `/`, then search) and tour feature A1
   (the home page's heading) already fit Notes, so the flows need no edits.

3. **Install.** Init offers `npm view @confidee/flowreel version` (a
   request to the npm registry), then `npm i -D @confidee/flowreel tsx`.
   Say yes. To use the runtime in your clone instead, say no and name your
   clone's `runtime` folder when init asks where it comes from. Before the
   path install, init proposes appending `install-links=true` to
   `~/notes-fresh/.npmrc`, as its own yes. Without that line npm links the
   folder, and Playwright stops with "Requiring @playwright/test second
   time" ([Troubleshooting](../../docs/troubleshooting.md#module-loading)).
   Say no to that line and init offers an `npm pack` tarball of the runtime
   instead. Either way init also installs `tsx`.
4. **Check, then run.** Init's own checks list the flows and run the
   browser-free unit suite. Then run the round trip and the tour on the
   development stage:

   ```bash
   npx playwright test --config e2e/flowreel/playwright.config.ts --list
   npm run flowreel:unit
   npm run flowreel -- --local                  # the smoke round trip
   npm run flowreel -- --module tour --local    # the feature tour
   ```

Last checked on 2026-10-15 on macOS (Node.js 25.9.0, npm 11.12.1,
@playwright/test 1.64.1), from a copy of `app/` in an empty folder and a
fresh copy of the flowreel package. The doctor's check script and init's
templates were applied as the two skills describe, by hand rather than
through the slash commands. Results: the doctor reported one missing item
(`@playwright/test`), then none. `--list` showed three tests (smoke, tour
setup, A1 home-page). The unit suite passed 3 of 3. The smoke pipeline
ended `PASS: development passed. Exit 0.` and the tour pipeline ended the
same way, with "1 tour feature(s) verified" and a narrated video.

## The files

```text
minimal/
├── app/                         the app under test (not flowreel)
│   ├── server.mjs               Node http server: pages, a JSON API, sessions
│   └── public/                  style.css and app.js (the list's search)
├── flowreel.config.ts           targets, modules, personas, secrets, results
├── playwright.config.ts         flowreel's createConfig: projects and web server
└── e2e/flowreel/
    ├── adapter.ts               the run's settings, the AppAdapter, the API client
    ├── tour.ts                  the tour manifest, fixture options, video kit, reporter options
    ├── fixtures.ts              test = tour fixtures + the recorded page; feature(), text()
    ├── global-setup.ts          signs every persona in once
    ├── global-teardown.ts       signs every persona out
    ├── reporter.ts              the summary reporter
    ├── plans/tour-a.md          the plan: features, policies, steps
    ├── flows/                   setup.spec.ts and one spec per feature
    ├── texts/tour-a.json        every string a flow types
    ├── narration/tour-a.json    what the video says at each step
    └── brand/                   the logos on the video cards
```

## How the pieces fit

**The target allowlist** (`flowreel.config.ts`). A local run may use only
`127.0.0.1` on ports 3170 to 3199. A staging run may use only the exact
origins listed, and this example lists none. A production host
(`notes.example.com` here) is refused for every target. The target comes from
`FLOWREEL_TARGET` in the process environment, never from a file. Once you
list a staging origin, a staging run also needs each persona's account:
`FLOWREEL_EDITOR_EMAIL`, `FLOWREEL_EDITOR_PASSWORD`, `FLOWREEL_ADMIN_EMAIL`
and `FLOWREEL_ADMIN_PASSWORD`, from the process environment or the
owner-only secrets file `~/.config/flowreel-example/env`.

**The AppAdapter** (`adapter.ts`). It tells flowreel how to sign a persona in
(one `POST /session`, no browser, so no trace records the password), how to
sign out (`DELETE /session`) and what "signed out" looks like (a redirect to
`/sign-in`, or a 401). flowreel decides when to sign in: once per persona per
run, in global setup, never retried. Workers receive the sessions in
`FLOWREEL_STATE_EDITOR` and `FLOWREEL_STATE_ADMIN`, and nothing is written to
disk.

**The plan and the tour** (`plans/tour-a.md`, `tour.ts`). The plan's
catalogue table lists each feature as `<id> <slug>` with its staging policy.
`defineTourManifest` reads that table, so the plan is the single source of
the policies. Every feature test calls `feature()` first. It checks the test
title and the policy against the plan, then applies the policy on the run's
target:

| Feature               | Policy      | Shows                                                                                                                |
| --------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------- |
| A1 create-note        | `both`      | The list, the form and the detail page, on a note the run creates and marks `[QA <RUN_ID>]`                          |
| A2 workspace-greeting | `both+undo` | A shared setting changed through the undo ledger: recorded before the change, restored and read back in the test     |
| A3 delete-note        | `dev`       | Runs on the development stage. On staging it is skipped as "development only: …" (counted dev-only, never a failure) |

**The undo ledger** (A2). `undo.change()` writes the old greeting and the
manual instructions to `undo.json` and `undo.md` before the flow touches
anything. `restoreNow()` puts the greeting back through the admin's API
client, and the restore reads it again to confirm. An entry that is not
restored by the end of the test is restored then, whether the test passed or
failed. If a restore fails, the run exits non-zero and `undo.md` lists what
to do by hand.

**Personas on one recording** (A2). `asPersona(page, "admin")` swaps the
recorded page's cookies to the admin's session from global setup. It never
signs in again. The video's badge switches from "as editor" to "as admin".

**The videos** (`tour.ts`). `defineBrand` sets the colours and logos,
`defineCardCopy` the card wording and `defineNarrationCopy` the spoken
defaults. Curated lines come from `narration/tour-a.json`, keyed by area,
feature id and step code. A step without a line is spoken as its title.
Step titles `A1.2 The editor writes …` become the captions. The reporter
composes everything after the run. The verdict is fixed before composition
starts, and nothing in the video can change it.

**The reporter's gate module (a known 0.x limitation).** In 0.x,
`SummaryReporter` requires exactly one round-trip module (a release-gate
flow), even in a project that has only a tour. This example has only a
tour, so `tour.ts` declares `NOTES_GATE`, a gate whose project is never
defined. It never runs, and the run takes the tour's verdict: PASS when at
least one feature was verified and none failed. Once the reporter accepts
a tour on its own, `NOTES_GATE` and this paragraph go away.

## Adapt it to your app

1. Point `flowreel.config.ts` at your app: the local port range, your exact
   staging origins and your production host rule.
2. Write your AppAdapter. Locally, a test-only sign-in seam is fastest. On
   staging, use the real sign-in form in `ctx.browser`, which global setup
   launches outside any test.
3. Write a plan for an area, then one flow per feature. Call `feature()`
   first, and title each step `<id>.<n> <sentence>`.
4. Add your brand, your texts and your narration lines.

For the full guide, see the [flowreel docs](../../docs/README.md).

## After changing the runtime

`npm install` copies the runtime into `node_modules`. `.npmrc` sets
`install-links=true`, because a symlink would load a second copy of
`@playwright/test`. A plain `npm install` keeps the old copy, so rebuild and
reinstall:

```bash
(cd ../../runtime && npm run build) && npm ci
```

## License

Apache-2.0, like flowreel. See [LICENSE](../../LICENSE).
