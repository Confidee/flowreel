# Writing flowreel flows

The contract between a plan and its flow. Read by `/flowreel:author`,
`/flowreel:narrate` and the `flow-author` agent. Paths are the layout
`/flowreel:init` scaffolds; a project may have moved them (check its
`playwright.config.ts` projects and the imports of an existing flow).

## Contents

- Files per module
- The round trip
- The tour: feature(), policies, ctx
- Fixtures: as, undo, pause, pace, inboundBudget
- Texts, facts, could-not-check, N/A
- Locators and waiting
- Narration
- Checklist before you hand back

## Files per module

| File                                    | What                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------- |
| `e2e/flowreel/plans/<module>.md`        | the human contract: steps, expectations, policy. Changes with the flow. |
| `e2e/flowreel/flows/<module>.spec.ts`   | the round trip: ONE test                                                |
| `e2e/flowreel/flows/tour/<l>-*.spec.ts` | tour area `<l>`: one test per catalogue feature                         |
| `e2e/flowreel/texts/<module>.json`      | every string a flow types or sends (tour areas: `tour-<l>.json`)        |
| `e2e/flowreel/narration/<module>.json`  | what the video says (tour areas: `tour-<l>.json`)                       |
| `e2e/flowreel/CATALOGUE.md` + `tour.ts` | the feature catalogue and its committed mirror (tours)                  |

Framework files (`adapter.ts`, `modules.ts`, `tour.ts` beyond the catalogue
mirror, `fixtures.ts`, `playwright.config.ts`, `pipeline.ts`, `global-*.ts`,
`reporter.ts`) are not a flow author's to change: report what is missing.

## The round trip

The release gate: one test in one Playwright project, its steps titled
with the plan's step ids exactly (`"S1 open"`). Every step id in the plan's
table appears in the summary, run or not; a step the flow never reaches
shows as not run.

```ts
import { expect, note, test, text } from "../fixtures"

test("smoke", async ({ page }) => {
  await test.step("S1 open", async () => {
    await page.goto("/")
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
  })
})
```

Verdict rule: PASS only when the gate test passed; N/A when it skipped with
an `N/A: <reason>` (`test.skip(true, "N/A: feature switched off on this target")`)
or did not run; FAIL on any failure anywhere in the run.

## The tour: feature(), policies, ctx

```ts
import { expect, feature, test } from "../../tour"

test("A1 home-page", async ({ page, pause, undo, as }) => {
  const ctx = feature(test, { id: "A1", policy: "both" }) // FIRST call

  await test.step("A1.1 The home page opens with its main heading", async () => {
    await page.goto("/")
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
    await pause() // after a KEY assertion only
  })
})
```

- Title `"<id> <slug>"` with the catalogue's id and slug; steps
  `"<id>.<n> <sentence>"`, numbered from 1 without gaps. The sentence is
  the video caption: write it for a viewer.
- `feature()` first: nothing (setup, `undo.change`, a hook, a skip) may run
  before it, because on staging a `dev` feature is skipped there. It checks
  id, slug and policy against the catalogue mirror and throws on a
  mismatch. A tour test that passes without calling it is reported failed.

| policy      | development  | staging                                                                     |
| ----------- | ------------ | --------------------------------------------------------------------------- |
| `both`      | runs         | runs, on QA-created objects only                                            |
| `both+undo` | runs         | runs; every shared-config change goes through `undo.change`                 |
| `dev`       | runs         | skipped as `development only: <devOnlyReason>` (required); a card, not FAIL |
| `view`      | runs in full | `ctx.mode === "view"`: render and assert, make NO write                     |

`ctx` = `{ id, policy, target, mode, runId }`. Write a `view` flow as
`if (ctx.mode === "full") { …writing steps… }`. The policy is the owner's
decision in the catalogue: never change it to reach staging.

## Fixtures

- `page`: the recorded page, signed in as the initial persona. One
  continuous recording per feature.
- `as(persona)`: that persona's API client (signed in by global setup;
  never sign in anywhere else). Use it for off-camera setup and facts.
- `undo.change({ what, before, manual, restore })`: call BEFORE changing
  shared configuration. It writes the entry to disk first; `restore(apis)`
  re-reads the state and puts it back using `apis.as(persona)` (never the
  test's `page`: restores run after it is gone). `(await undo.change(…)).restoreNow()`
  restores inside the test. A failed restore exits the run 4.
- `pause()`: the demo pace's hold after a key assertion; nothing at qa pace.
  Never `waitForTimeout`.
- `pace`: `"demo"` (slowMo, pauses; narrated when narration is on) or `"qa"` (fast, silent).
- `inboundBudget.consume(what)`: before every mail the flow sends INTO the
  app; at most 3 per staging run (write-ahead; refuses the 4th).

## Texts, facts, could-not-check, N/A

- Every string a flow types or sends lives in a texts file
  (`{ "subjects": {}, "bodies": {} }`, placeholders `{RUN_ID}` and `{NAME}`),
  so one guard can scan them all: the round trip's is
  `texts/<module>.json`, read with `text(key)` from `fixtures.ts`; a tour
  area's is `texts/tour-<letter>.json`, read with
  `areaText(letter, key, vars?, group?)` from `tour.ts` (`{RUN_ID}` filled
  in, any other `{NAME}` from `vars`; an unknown placeholder throws). Records a run creates carry
  `[QA <RUN_ID>]` (the `runSubject()` helper) so cleanup can find them.
- `note(step, key, value)`: a fact in `summary.json`; `latency.<key>` is a
  hop latency in milliseconds.
- `couldNotCheck(step, reason)`: something this target cannot verify. It is
  listed, never counted as pass or fail.

## Locators and waiting

- `getByRole` (with its accessible name) first, `getByLabel` /
  `getByText` next, `data-testid` last; re-verify every label in the app's
  source before using it. Exact matches where a substring could match
  another row (`{ exact: true }`, or the whole cell).
- Wait with web-first assertions (`await expect(locator).toBeVisible()`),
  `poll()` from `@confidee/flowreel/core` for off-camera API state. No
  fixed sleeps, no `retries`, never `try`/`catch` around an `expect`.
- Mail: through the project's `MailDriver` (`send`, `waitFor`, `reply`); a
  send off the configured domain is refused before any network call.

## Narration

Every recorded step and every feature's title card needs a line in
`narration/<module>.json` (`/flowreel:narrate` writes them):

- round trip keys: `intro`, `outro.pass` / `outro.fail` / `outro.n/a` /
  `outro`, step codes (`S1`), `<code>.email` for an email card;
- tour keys: `area`, `outro`, feature ids (`A1`, the title card), step
  codes (`A1.1`), a full step title only when it differs per target;
  `<code>.email` (`.email.2` for a second card of the same step);
- placeholders `{COUNT}`, `{PASSED}`, `{FAILED}`; keys starting with `_` are
  comments.

A step without a line is said as its caption sentence.

## Checklist before you hand back

- Plan and flow agree (ids, slugs, steps, policy); narration has a line per
  step and feature; every typed string is in the texts file.
- `npm run flowreel:unit` passes (narration keys against step titles; the
  catalogue against its mirror).
- The flow passes locally (`npm run flowreel -- --module <m> --local`, tour
  `--area <l> --pace qa` while iterating, the final run at demo pace).
- No assertion was weakened to get there; nothing was retried.
