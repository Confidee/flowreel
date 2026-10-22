# Writing flows

A flowreel flow is an ordinary Playwright test with three extra rules:

1. Its **title and step titles** follow a fixed shape, because the reporter,
   the video and the narration read them.
2. In a tour, its **first line is `feature()`**, which applies the
   owner-approved staging policy. The flow never chooses its target and
   never skips itself.
3. **The verdict is the assertions.** No retries, no `try/catch` around an
   `expect`, no fixed sleeps.

This guide covers the project fixtures (written once), then the round trip,
then tour features, then the building blocks: steps, assertions, facts,
personas, undo, texts, mail and pacing.

- [Project fixtures](#project-fixtures)
- [The round trip](#the-round-trip)
- [Tour features](#tour-features)
- [Steps and captions](#steps-and-captions)
- [Assertions and the verdict](#assertions-and-the-verdict)
- [Facts and "could not check"](#facts-and-could-not-check)
- [Personas](#personas)
- [The undo ledger](#the-undo-ledger)
- [Texts](#texts)
- [Mail](#mail)
- [Pacing](#pacing)
- [The static tripwire](#the-static-tripwire)
- [Checklist before you hand a flow back](#checklist-before-you-hand-a-flow-back)

## Project fixtures

Flows never import `test` from `@playwright/test`. They import it from two
project files that `/flowreel:init` generates:

- **`e2e/flowreel/fixtures.ts`**: the round trip's `test`, with the
  recorded page signed in as the first persona, plus `note()`,
  `couldNotCheck()` and `text()`.
- **`e2e/flowreel/tour.ts`**: the tour's manifest and catalogue mirror,
  its `test` (flowreel's `tourFixtures()`), and `feature()`.

The plugin's templates (`plugin/templates/e2e/flowreel/`) are the reference
copies. The essentials of `tour.ts`, abridged from the template. The tour's
`test` extends the one in `fixtures.ts`, so tour features get the same
signed-in recorded page and [video log](#the-video-log-needed-for-videos)
as the round trip. Extend `@playwright/test` directly instead and every
tour feature reports `video: not produced (no video timing log)`.

```ts
// e2e/flowreel/tour.ts (abridged)
import { join } from "node:path"

import { requireStorageState } from "@confidee/flowreel/app"
import { resultsDir } from "@confidee/flowreel/config"
import { envName, envValue, fileUndoStore } from "@confidee/flowreel/core"
import { currentRunId } from "@confidee/flowreel/run"
import {
  type FeatureContext,
  type FeatureOptions,
  type FeatureTest,
  InboundMailBudget,
  declareFeature,
  defineTourManifest,
  fileBudgetStore,
  parsePace,
  tourFixtures,
} from "@confidee/flowreel/tour"
import type { APIRequestContext } from "@playwright/test"

import { type PersonaKey, flowreel } from "../../flowreel.config"
import { appAdapter, loadRun } from "./adapter"
// The shared flow fixtures: the signed-in recorded page and the video log.
import { test as base } from "./fixtures"

export const TOUR = defineTourManifest({
  areas: [{ letter: "A", slug: "listing", title: "Listing and creation" }],
  setupProject: "tour-setup",
  catalogue: { A4: { slug: "list-search", policy: "both" } },
})

const run = () => loadRun() // target, baseURL, personas (your adapter)

export const test = base.extend(
  tourFixtures<PersonaKey, APIRequestContext>({
    personas: flowreel.personas,
    baseURL: () => run().baseURL,
    runId: () => currentRunId(),
    pace: () =>
      parsePace(envValue(process.env, "PACE"), envName(process.env, "PACE")),
    stateFor: (persona) => requireStorageState(persona),
    client: (context) => context, // or wrap it in your own API client
    undoStore: (runId) => fileUndoStore(resultsDir(flowreel, runId), runId),
    inboundBudget: (runId) =>
      new InboundMailBudget(
        fileBudgetStore(join(resultsDir(flowreel, runId), "inbound-mail.json")),
        run().target,
      ),
    featureKey: (info) => TOUR.parseFeatureTitle(info.title)?.id ?? info.title,
    app: appAdapter, // isSignedOut + keepalivePath for the session keepalive
  }),
)

export { expect } from "@playwright/test"

/** The FIRST call of every tour test: see "Tour features". */
export function feature(
  t: FeatureTest,
  options: FeatureOptions,
): FeatureContext {
  return declareFeature(t, options, {
    target: run().target,
    runId: () => currentRunId(),
    manifest: TOUR,
  })
}
```

What `tourFixtures()` gives every test:

| Fixture         | Scope  | What it is                                                                                               |
| --------------- | ------ | -------------------------------------------------------------------------------------------------------- |
| `pace`          | worker | `"demo"` or `"qa"`                                                                                       |
| `as(persona)`   | test   | the persona's API client (your `client`), opened lazily over the session from global setup               |
| `undo`          | test   | `undo.change({ what, before, manual, restore })`; restored newest first at the test's end                |
| `pause()`       | test   | holds 1.8 s at demo pace after a key assertion, nothing at qa pace                                       |
| `personaApis`   | worker | the same clients, worker-scoped (used by restores)                                                       |
| `undoLedger`    | worker | the ledger; flushed again at the worker's end                                                            |
| `inboundBudget` | worker | the per-run inbound-mail budget (at most 3 on staging by default)                                        |
| (keepalive)     | worker | automatic: one request per signed-in session every 4 minutes, bounded (see [Safety](safety.md#sessions)) |

No fixture ever signs in. Every session comes from global setup, and asking
for a persona that is not configured on this target fails at once with a
message naming it.

Every request through `as(persona)` and `personaApis` gets at most
`requestTimeoutMs` (a `tourFixtures()` option, 30 s by default), from the
connection to the last byte of the body: it is the `timeout` of each
persona's request context, so it overrides the project's `actionTimeout`
for them, and a request's own `timeout` still wins. A request that runs
out fails with Playwright's error, whose call log names the session
cookie: `summary.md`, `summary.json` and `summary.lines` keep only what
comes before it.

### The video log (needed for videos)

The run video is cut from the page recording using a timing log: when the
recording started, when each email card was recorded, and when the recorded
page switched persona. Add a `videoLog` fixture, mark the start once the
recorded page exists, and attach the log at teardown (on failure too,
because that is when the video helps most):

```ts
import {
  VIDEO_LOG_ATTACHMENT,
  VideoLog,
  videoEnabled,
} from "@confidee/flowreel/video"

export const test = base.extend<{ videoLog: VideoLog }>({
  // eslint-disable-next-line no-empty-pattern
  videoLog: async ({}, use, testInfo) => {
    const log = new VideoLog()
    await use(log)
    if (videoEnabled()) {
      await testInfo.attach(VIDEO_LOG_ATTACHMENT, {
        body: JSON.stringify(log.toJSON()),
        contentType: "application/json",
      })
    }
  },
  page: async ({ page, videoLog }, use) => {
    videoLog.markVideoStart() // see the standby card below
    await use(page)
  },
})
```

Without it, the summary says `video: not produced (no video timing log)`.
The init template `e2e/flowreel/fixtures.ts` already includes this fixture
(and the tour template's `test` extends it), as does
`examples/minimal/e2e/flowreel/fixtures.ts`.

### The standby card (recommended for videos)

The page recording's clock starts at its first **painted** frame, and
`about:blank` paints nothing. To keep captions in sync with the picture,
paint a standby card before marking the start:

```ts
page: async ({ page, videoLog }, use) => {
  if (videoEnabled()) {
    try {
      await page.setContent(kit.cards.standbyHtml(kit.brand.logos(), currentRunId()))
      await page.evaluate(
        () => new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done()))),
      )
    } catch {
      // Video only: never fail a test over the standby card.
    }
  }
  videoLog.markVideoStart()
  await use(page)
},
```

`kit` is your [video kit](narration-and-videos.md#your-video-kit).

## The round trip

The round trip is one test in one Playwright project, the gate. Its steps
are the rows of its plan:

```md
<!-- e2e/flowreel/plans/smoke.md -->

| Step                 | Action                              | Expect                                 |
| -------------------- | ----------------------------------- | -------------------------------------- |
| S1 place-order       | the customer pays with a saved card | the confirmation page shows the number |
| S2 confirmation-mail | wait for the confirmation email     | it names the order and the total       |
| S3 staff-sees-order  | an agent opens the order list       | the order is there, status "Paid"      |
```

```ts
// e2e/flowreel/flows/smoke.spec.ts
import { requireStorageState } from "@confidee/flowreel/app"

import { expect, note, test } from "../fixtures"

test("smoke", async ({ page, playwright, baseURL, videoLog }) => {
  let orderNumber = ""

  await test.step("S1 place-order", async () => {
    await page.goto("/shop/items/42")
    await page.getByRole("button", { name: "Buy now" }).click()
    await page.getByRole("button", { name: "Pay with saved card" }).click()
    const confirmation = page.getByRole("heading", { name: /Order #\d+/ })
    await expect(confirmation).toBeVisible()
    orderNumber = (await confirmation.textContent())!.replace(/\D/g, "")
    note("S1 place-order", "order", orderNumber)
  })

  // … S2 waits for the mail through your MailDriver and records a card:
  //   videoLog.mail("S2 confirmation-mail", "received", message)

  await test.step("S3 staff-sees-order", async () => {
    // off camera, as another persona, over its global-setup session
    const api = await playwright.request.newContext({
      baseURL,
      storageState: requireStorageState("admin"),
    })
    const res = await api.get(`/api/orders/${orderNumber}`)
    expect((await res.json()).status).toBe("paid")
    await api.dispose()
  })
})
```

Tell the reporter about it with a `RoundTripModule`
([Adapters](adapters.md#moduledescriptor)): its `project`, the `planFile`,
and a `planStepPattern` such as `/^\|\s*(S\d+ [^|]*?)\s*\|/gm`. Give the
captions plain-language titles with `CardCopy.stepTitles`
(`{ "S1 place-order": "The customer pays with a saved card" }`).

To report "nothing to verify on this target" rather than a failure (for
example, the feature is switched off there), skip the gate test with a
reason that starts with `N/A:`. The run's verdict is then N/A, which is not
a pass.

## Tour features

```ts
// e2e/flowreel/flows/tour/a-listing.spec.ts
import { expect, feature, test } from "../../tour"

test("A4 list-search", async ({ page, as, pause }) => {
  const ctx = feature(test, { id: "A4", policy: "both" }) // FIRST line
  // setup off camera, through your own API client (the `client` option)
  const order = await as("user").createOrder({ subject: `QA ${ctx.runId} A4` })

  await test.step("A4.1 Search finds the order by its number", async () => {
    await page.goto("/orders")
    await page
      .getByRole("searchbox", { name: "Search orders" })
      .fill(order.number)
    await expect(
      page.getByRole("row", { name: new RegExp(order.number) }),
    ).toBeVisible()
    await pause()
  })

  await test.step("A4.2 Clearing the search shows every order again", async () => {
    await page.getByRole("button", { name: "Clear search" }).click()
    await expect(page.getByRole("row")).not.toHaveCount(1)
  })
})
```

### `feature(test, { id, policy, devOnlyReason? })`

Call it before anything else: no setup, no `undo.change()`, no hook. On
staging a `dev` feature is skipped right there. It:

1. checks that the title is `"<id> <slug>"` with the catalogue's slug;
2. checks that `policy` is the catalogue's policy (the staging policy is
   the owner's decision; change the catalogue first, never the flow alone);
3. records an annotation the reporter and the videos read;
4. applies the policy for the run's target (from the run's config, never
   from the flow).

It returns `ctx = { id, policy, target, mode, runId }`.

| Policy      | What to write                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------- |
| `both`      | the full flow, on objects the run creates itself                                                   |
| `both+undo` | the full flow; every shared-config change goes through `undo.change()` first                       |
| `dev`       | the full flow, plus `devOnlyReason` (required, shown on the staging card): why it cannot run there |
| `view`      | wrap every write in `if (ctx.mode === "full") { … }`; on staging only what is shown is asserted    |

A tour test that passes without calling `feature()` is reported **failed**.

### The tour manifest

`TOUR` in `tour.ts` is the tour as data. Its catalogue is the committed
mirror of `e2e/flowreel/CATALOGUE.md`:

```ts
export const TOUR_AREAS: readonly TourArea[] = [
  { letter: "A", slug: "listing", title: "Listing and creation" },
  { letter: "B", slug: "workspace", title: "The order workspace" },
]

export const TOUR_CATALOGUE: Readonly<Record<string, CatalogueEntry>> = {
  A4: { slug: "list-search", policy: "both" },
  B2: { slug: "tags", policy: "both+undo" },
  B9: { slug: "bulk-import", policy: "dev" },
}

export const TOUR = defineTourManifest({
  areas: TOUR_AREAS,
  setupProject: "tour-setup",
  // projectPrefix: "tour-" (default): area A is the Playwright project "tour-a"
  catalogue: TOUR_CATALOGUE,
})
```

Keep the mirror equal to the Markdown catalogue: a unit test can compare
`parseCatalogue(markdown, { letters: TOUR.letters })` with
`TOUR_CATALOGUE`. Change the catalogue first (the owner approves it), then
the mirror, and never a flow alone.

## Steps and captions

- Tour step titles are `"<id>.<n> <sentence>"`, numbered from 1 with no
  gaps. Round-trip steps are the plan's ids.
- The caption shows the code and the sentence, the narration speaks the
  sentence, and the summary lists the step. Write the sentence for a
  viewer, in the present tense, with its subject ("The agent adds a tag",
  not "Add tag").
- One continuous recording per feature: do not open a second recorded
  page.
- Setup and checks that do not need to be seen go through `as(persona)`,
  off camera, outside any `test.step` (no caption).

## Assertions and the verdict

- Wait with assertions (`await expect(locator).toBeVisible()`), never with
  `page.waitForTimeout()`.
- Never wrap an `expect` in `try/catch`, and never weaken an assertion to
  make a run pass. `/flowreel:explain` may suggest a **locator** fix. It
  never changes what is asserted.
- Prefer `getByRole`, then `getByLabel` and `getByText`, then a stable
  `data-testid`. Re-check every label against the app's source.
- No `test.skip`, `test.only`, `test.fixme`, `test.fail` or hooks in a tour
  area. Only `feature()` skips (the tripwire enforces this).
- No retries: the config fixes `retries: 0`.

## Facts and "could not check"

Two small helpers in `fixtures.ts` (generated by init) let a flow add facts
to the summary without changing the verdict:

```ts
// e2e/flowreel/fixtures.ts (excerpt)
import {
  COULD_NOT_CHECK_ANNOTATION, // "could-not-check"
  FACT_ANNOTATION, // "qa"
} from "@confidee/flowreel/reporter"

/** A step fact in summary.md / summary.json (ids, counts, latencies). */
export function note(step: string, key: string, value: unknown): void {
  test.info().annotations.push({
    type: FACT_ANNOTATION,
    description: JSON.stringify({ step, key, value }),
  })
}

/** Something this run structurally cannot verify (listed in the summary). */
export function couldNotCheck(step: string, reason: string): void {
  test.info().annotations.push({
    type: COULD_NOT_CHECK_ANNOTATION,
    description: `${step}: ${reason}`,
  })
}
```

A fact whose key starts with `latency.` (for example
`note("S2 confirmation-mail", "latency.orderToMailMs", ms)`) is also listed
on the video's outro card, labelled by `CardCopy.latencyLabels`.

## Personas

```ts
test("B5 hand-over", async ({ page, as, asPersona }) => {
  const ctx = feature(test, { id: "B5", policy: "both" })
  // off camera, as another persona
  const order = await as("admin").createOrder({ subject: `QA ${ctx.runId} B5` })
  // on camera: the recorded page becomes the admin (no sign-in), then back
  await asPersona(page, "admin")
  // …
  await asPersona(page, "user")
})
```

- `as(persona)` is the persona's API client: setup and checks off camera.
- Swapping the recorded page uses `swapPersona(page, state, keep)` from
  `@confidee/flowreel/tour`. An `asPersona` fixture (the templates do
  not ship one; `examples/minimal/e2e/flowreel/fixtures.ts` has one to
  copy into your `tour.ts` or fixtures) calls it with
  `requireStorageState(persona)` and then `videoLog.persona(label)`, so the
  video shows "as <label>". Let the page finish loading first: a request
  still in flight can return the old persona's session cookie after the
  swap.
- Never sign in inside a flow. A feature that needs a persona that is not
  configured on staging is a `dev` feature.

## The undo ledger

Before any change to shared configuration (anything not created by the run
itself):

```ts
const previous = await as("admin").settings()
const entry = await undo.change({
  what: `Default team: ${previous.defaultTeam} -> QA-${ctx.runId}`,
  before: { defaultTeamId: previous.defaultTeamId },
  manual: "Settings > Teams: make the previous default team the default again.",
  restore: async ({ as }) => {
    const admin = as("admin")
    await admin.updateSettings({ defaultTeamId: previous.defaultTeamId })
    const now = await admin.settings()
    if (now.defaultTeamId !== previous.defaultTeamId) {
      throw new Error("the default team did not change back")
    }
  },
})
// … now make the change …
await entry.restoreNow() // for global-effect changes, restore inside the test
```

- `change()` writes the entry to `undo.json` and `undo.md` **before** it
  returns. Make the change only after it returns.
- `restore` runs after the test's fixtures are gone. Use only its `{ as }`
  and `{ request }` argument, never the test's `page`.
- A restore must **read the state back** and throw if it did not stick.
  "The write returned" is not "restored".
- `manual` must tell a person exactly how to put it back.
- Name everything you create with the run id (`QA-<RUN_ID> …`), so leftovers
  are easy to recognise.

## Texts

Every string a flow types or sends lives in a texts file:

```json
{
  "subjects": { "orderNote": "[QA {RUN_ID}] {FEATURE} note on the order" },
  "bodies": { "orderNote": "Please gift-wrap this order. Reference {RUN_ID}." }
}
```

```ts
import { interpolateText, jsonTexts } from "@confidee/flowreel/run"

const texts = jsonTexts("e2e/flowreel/texts/tour-a.json")
const body = interpolateText(texts.raw("bodies", "orderNote"), {
  RUN_ID: ctx.runId,
  FEATURE: ctx.id,
})
```

- The init templates wrap this for you: `text(key)` in `fixtures.ts`
  reads a body from the round trip's texts with `{RUN_ID}` filled in, and
  `areaText(letter, key, vars?, group?)` in `tour.ts` reads
  `texts/tour-<letter>.json` (`group` is `"bodies"` by default).
- `interpolateText` is strict: an unknown `{NAME}` throws before anything
  reaches the app.
- `runSubject(runId, text)` prefixes `[QA <RUN_ID>]`. The off-camera
  cleanup and the privacy mask both use that marker.
- Keep one guard over every texts file (a unit test, or a test in your
  app's own suite) for anything that must never be sent, such as regulated
  vocabulary or real personal data.

## Mail

Flows depend only on the `MailDriver` contract
([Adapters](adapters.md#maildriver)), so the same flow runs against a local
seam and a real mailbox:

```ts
const sent = await mail.send({ from, to: supportAddress, subject, text })
videoLog.mail("S1 send", "sent", { from, to: supportAddress, subject, text })

const reply = await mail.waitFor({
  to: customer,
  subjectIncludes: runMarker(ctx.runId),
  since: startedAt,
  excludeIds: [earlier.id], // when two hops share a mailbox
})
videoLog.mail("S4 reply", "received", reply)
```

- On staging, call `assertReplyDomainRecipient(to, replyDomain)` (or let
  your driver call it) **before** the network request. It refuses any
  address not on the configured domain.
- Never re-send on a timeout: a re-sent mail creates a duplicate record.
- In a tour, every inbound send and reply goes through
  `inboundBudget.consume(what)` first (at most 3 per staging run by
  default). Across runs, `consumeInbound()` with the cross-run inbound
  ledger refuses a sender that already sent its hourly limit. Both refuse
  **before** sending, so nothing is sent.
- Prefer creating records through the app's API over inbound mail in a
  tour.

## Pacing

- `pause()` after a **key** assertion only: it holds 1.8 s at demo pace and
  does nothing at qa pace.
- Never use `waitForTimeout` for pacing.
- Long waits (mail, background jobs) are fine. At qa pace the video
  fast-forwards them. At demo pace they play in real time with a "waiting"
  badge and one spoken line.

## The static tripwire

Add a unit test that scans every area spec with your own `typescript`
package:

```ts
import ts from "typescript"
import {
  checkDeclaredFeatures,
  scanAreaSpec,
  scanAreaSupport,
} from "@confidee/flowreel/tour"

const seen = new Map<string, string>() // carries ids across area files
const { tests, problems } = scanAreaSpec(ts, file, source)
problems.push(...checkDeclaredFeatures(TOUR, file, "A", tests, seen))
expect(problems).toEqual([])
```

- `scanAreaSpec` reports a `test()` that does not start with
  `feature(test, { id, policy })`, a hook or a
  `test.skip/only/fixme/fail/slow` outside `feature()`, and any in-body skip
  (`test.skip(…)`, `test.info().fixme(…)`, `testInfo.fail(…)`).
- `scanAreaSupport(ts, file, source)` checks an area's helper file for
  in-body modifiers.
- `checkDeclaredFeatures` checks titles, that each id belongs to the area
  and is in the catalogue, the slug and policy, and that each feature is
  tested exactly once.

The runtime takes the TypeScript compiler API as an argument (typed
structurally), so it has no dependency on `typescript` itself. The scanner
supports TypeScript 5.x and 6.x; TypeScript 7 is not supported yet
([issue #6](https://github.com/Confidee/flowreel/issues/6)).

## Checklist before you hand a flow back

- [ ] Titles: `"<id> <slug>"` and `"<id>.<n> <sentence>"`, matching the
      plan and the catalogue.
- [ ] `feature()` is the first line, and the policy is the catalogue's.
- [ ] Every string the flow types or sends is in a texts file.
- [ ] Every shared-config change goes through `undo.change()`, with a
      restore that re-reads the state.
- [ ] No `waitForTimeout`, no `try/catch` around an `expect`, no skips.
- [ ] Green locally at `--pace qa`, then once at `--pace demo`, and you
      have watched the video.
- [ ] Narration lines for any step that needs more than its title (see
      [Narration and videos](narration-and-videos.md)).
- [ ] The plan file matches the flow.
