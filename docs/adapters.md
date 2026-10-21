# Adapters

flowreel's core knows nothing about your app, your mail provider, your
database or your brand. You connect it through a few small interfaces.
Each one is a plain TypeScript object or function that you write once,
usually in `e2e/flowreel/adapter.ts`. Some come ready-made from a subpath.

| Interface                                 | Entry point                   | You need it for                                      |
| ----------------------------------------- | ----------------------------- | ---------------------------------------------------- |
| [AppAdapter](#appadapter)                 | `@confidee/flowreel/app`      | every project: signing personas in and out           |
| [MailDriver](#maildriver)                 | `@confidee/flowreel/mail`     | flows that send or receive email                     |
| [DbIsolation](#dbisolation)               | `@confidee/flowreel/pipeline` | a fresh database per development run                 |
| [CleanupAdapter](#cleanupadapter)         | `@confidee/flowreel/run`      | closing the records a run created on a shared target |
| [Brand and CardCopy](#brand-and-cardcopy) | `@confidee/flowreel/video`    | videos in your colours and words                     |
| [VoiceEngine](#voiceengine)               | `@confidee/flowreel/voice`    | narration (macOS built in; others pluggable)         |
| [ModuleDescriptor](#moduledescriptor)     | `@confidee/flowreel/reporter` | every project: the round trip and the tour           |
| [TourManifest](#tourmanifest)             | `@confidee/flowreel/tour`     | a feature tour                                       |
| [DemoCatalogue](#democatalogue)           | `@confidee/flowreel/demos`    | publishing demo videos to `latest/`                  |

Stack guides: [rails-inertia](#rails-inertia) and
[mail-graph (Microsoft 365)](#mail-graph-microsoft-365).

The root entry point (`@confidee/flowreel`) re-exports everything except
the reporter, the demos and the two stack adapters, which have their own
subpaths.

## AppAdapter

The project's side of signing in and out. flowreel decides **when**: each
distinct persona signs in once per run in global setup, is never retried,
its session is handed to the workers, and every session is revoked by global
teardown. The adapter knows **how**.

```ts
interface AppAdapter<P extends string = string> {
  signIn(ctx: SignInContext, key: P, persona: Persona): Promise<StorageState>
  signOut(
    api: APIRequest,
    baseURL: string,
    state: StorageState,
  ): Promise<{ revoked: boolean; detail: string }>
  isSignedOut(answer: SessionAnswer): boolean
  sessionKind?(key: P): string // personas sharing email AND kind share a session
  needsBrowser?(target: TargetName): boolean // default: staging only
  keepalivePath?: string // GET target of the keepalive (default "/")
  health?(api: APIRequest, baseURL: string): Promise<string | null>
  prepareLocal?(): Promise<void> | void // development only, before any sign-in
}
```

| Member          | Contract                                                                                                                                                                                                                                                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signIn`        | Signs one persona in **once** and returns its storageState. Throws a `LoginError` naming the persona and the step, never a password. `ctx` holds the target, the allowlisted `baseURL`, Playwright's `api`, and a `browser` launched outside any test when `needsBrowser` asked for one, so no trace ever records a password being typed. |
| `signOut`       | Revokes one session. Never throws. `detail` names an HTTP status, never a cookie.                                                                                                                                                                                                                                                         |
| `isSignedOut`   | True when an authenticated request's answer means "signed out" (for example a 401, or a redirect to the sign-in page). Used by the session keepalive.                                                                                                                                                                                     |
| `sessionKind`   | Optional. Personas with the same email but a different kind (say `staff` and `portal`) get separate sessions.                                                                                                                                                                                                                             |
| `needsBrowser`  | Optional. Return true where sign-in needs a real form. Default: staging only.                                                                                                                                                                                                                                                             |
| `keepalivePath` | Optional. A cheap page every persona can GET. Default `/`.                                                                                                                                                                                                                                                                                |
| `health`        | Optional. Null when the target is healthy, otherwise what is wrong (no secrets). Reserved for a generic preflight: in 0.x no runtime code calls it, so a project's own preflight calls it if it wants the check.                                                                                                                          |
| `prepareLocal`  | Optional. Development only, before any sign-in: migrate and seed the database, build assets. Throw to stop the run.                                                                                                                                                                                                                       |

Helpers for the common cookie-session app:

```ts
import {
  type AppAdapter,
  type SessionProtocol,
  revokeSession,
  signedOutBy,
} from "@confidee/flowreel/app"
import { LoginError } from "@confidee/flowreel/core"
import { seamSignIn } from "@confidee/flowreel/rails-inertia"

const session: SessionProtocol = {
  probePath: "/",
  isSignInPath: (path) => path === "/login",
  signOut: { method: "DELETE", path: "/session" },
  csrf: { cookie: "XSRF-TOKEN", header: "X-XSRF-TOKEN" }, // omit if none
}

export const appAdapter: AppAdapter<"agent" | "admin"> = {
  async signIn({ target, baseURL, api, browser }, key, persona) {
    if (target === "local") {
      // a test-only seam, routed only in test/development (see rails-inertia)
      return seamSignIn(api, baseURL, { body: { email: persona.email } })
    }
    const context = await browser!.newContext({ baseURL })
    try {
      const page = await context.newPage()
      await page.goto("/login")
      await page.getByLabel("Email").fill(persona.email)
      await page.getByLabel("Password").fill(persona.password)
      await page.getByRole("button", { name: "Sign in" }).click()
      if (new URL(page.url()).pathname === "/login") {
        throw new LoginError(
          `${key}: still on the sign-in page after submitting`,
        )
      }
      return await context.storageState()
    } finally {
      await context.close()
    }
  },
  signOut: (api, baseURL, state) => revokeSession(api, baseURL, state, session),
  isSignedOut: signedOutBy("/login"),
}
```

`revokeSession` sends the sign-out request, then opens a fresh context with
the **original** state to prove the session is dead. A session that is
already signed out counts as revoked.

Wire the adapter into Playwright's global hooks:

```ts
// e2e/flowreel/global-setup.ts
import { createGlobalSetup } from "@confidee/flowreel/app"

import { flowreel } from "../../flowreel.config"
import { appAdapter, loadRun, runPersonas } from "./adapter"

export default createGlobalSetup({
  load: () => runPersonas(loadRun()),
  adapter: appAdapter,
  logPrefix: flowreel.logPrefix,
})

// e2e/flowreel/global-teardown.ts: the same, with createGlobalTeardown
```

`load` returns a `RunPersonas` (plus an optional `module` for the log
line): `{ target, baseURL, keys, persona(key) }`, where `persona(key)`
returns `{ email, password }` or null when the persona is not configured
on this target. `loadRun()` and `runPersonas()` are **your** code (the
init template writes them in `adapter.ts`), not runtime API. Locally,
passwords can be your seeded development accounts. On staging, read them
through the config source (see
[Configuration: secrets](configuration.md#secrets)).

What the two hooks do:

- **Setup** runs `prepareLocal()` on the development stage, then calls
  `signIn` once per distinct session and writes each storageState to
  `FLOWREEL_STATE_<PERSONA>` (an unconfigured persona's variable is
  deleted). It logs one line: the target, the module and how many
  personas signed in.
- **Teardown** calls `signOut` once per distinct session, pass or fail,
  and logs `signed out the <persona> persona (…)` or a loud `WARNING`
  naming the persona and what to do. It never fails the run.

Both take an optional `prefix` for the handoff variables (default
`FLOWREEL_STATE_`). The lower-level `signInAll()` and `signOutAll()` are
exported for projects that need their own hooks.

## MailDriver

```ts
interface MailDriver {
  readonly kind: "graph" | "seam"
  health(): Promise<void> // throws an actionable Error
  send(mail: OutgoingMail): Promise<SendResult>
  waitFor(query: MailQuery): Promise<MailMessage> // polls; throws TimeoutError
  reply(original: MailMessage, mail: ReplyMail): Promise<SendResult>
  saveEml?(message: MailMessage, dir: string): Promise<string | null>
}
```

Flows depend only on this contract, so the same flow runs against a local
seam during development and a real mailbox on staging.

| Type           | Fields                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `OutgoingMail` | `from`, `to` (one address), `subject`, `text`; development only: `headers` (from the seam's allowlist) and up to three small `attachments` |
| `MailQuery`    | `since` (required), `to`, `subjectIncludes`, `bodyIncludes`, `excludeIds` (ids already consumed by an earlier hop), `timeoutMs`            |
| `MailMessage`  | `id`, `messageId`, `from`, `to`, `cc`, `replyTo`, `subject`, `text`, `inReplyTo`, `references`, `headers`, `receivedAt`, `sandboxed`       |
| `ReplyMail`    | `from`, `text`. `reply()` sends to `replyTo[0] ?? from` and threads with In-Reply-To and References                                        |

Building blocks for writing a driver:

- `poll(attempt, { waitingFor, timeoutMs })` from `/core`: exponential
  back-off from 1 s to 5 s. The `TimeoutError` names what was awaited and
  the last state observed. An exception inside `attempt` is a real failure
  and is not retried.
- `matchMessage`, `matchesQuery`, `describeQuery`, `describeCandidates` from
  `/mail`: the pure matcher and the "what did we see instead" text for a
  timeout.
- `assertReplyDomainRecipient(to, replyDomain)` and
  `replyDomainTarget(supportAddress, replyDomain)` from `/mail`: the
  staging send guard. Call it before any network request. See
  [Safety](safety.md#mail).
- **Bound every request yourself.** `poll()` cannot interrupt an attempt
  that never returns, so a request with no bound of its own (connection,
  headers and the whole body) stalls the run past the wait's `timeoutMs`.
  Give each request an `AbortController` and a timer, and race the body
  read against it too.

Drivers:

| Driver               | Where                              | Use                                                                                                       |
| -------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `HttpSeamMailDriver` | `@confidee/flowreel/rails-inertia` | development: the app's test seams ([the seam protocol](#the-seam-protocol); any backend may implement it) |
| `GraphMailDriver`    | `@confidee/flowreel/mail-graph`    | staging: one Microsoft 365 mailbox through Microsoft Graph ([below](#mail-graph-microsoft-365))           |
| Mailpit, IMAP        | none                               | out of scope for 0.x                                                                                      |

`/mail` holds the contract only; it exports no driver. The seam driver
ships on `/rails-inertia` because the Rails seam kit is its reference
server, but it depends on nothing Rails or Inertia: it speaks plain HTTP and
JSON. A backend in another stack that implements the seam protocol imports
`HttpSeamMailDriver` (and `seamSignIn`) from `/rails-inertia` all the same.

## DbIsolation

A fresh database per development run, so a run never shares or pollutes
the database your other test suites use.

```ts
interface DbIsolation {
  create(key: string): Record<string, string> // env that selects the copy; throws on failure
  drop(key: string): boolean // never throws
}
```

The pipeline calls `create(key)` once before the development stage, passes
the returned environment to that stage only, then calls `drop(key)` after
the stage, or on a second Ctrl-C. With `--keep-db` the copy is kept and the
log prints how to drop it. A `create` failure means development is not run
and is recorded FAIL with the message. Neither call is retried by the
runner.

Most projects wrap an existing clone script with `commandDbIsolation`:

```ts
import { commandDbIsolation } from "@confidee/flowreel/pipeline"

const isolation = commandDbIsolation({
  command: "bin/test-db-clone", // `<command> <key>` creates, `<command> <key> drop` drops
  cwd: repoRoot,
  parse: (stdout) => {
    // e.g. the script prints `export DATABASE_URL=…` lines
    const env: Record<string, string> = {}
    for (const m of stdout.matchAll(/^export (\w+)=(.*)$/gm)) env[m[1]] = m[2]
    if (!env.DATABASE_URL)
      throw new Error("the clone script printed no DATABASE_URL")
    return env
  },
  // dropWaits: [0, 3000, 10000] (default): the stage's server may still hold connections
})
```

and register it in the `PipelineSpec`:

```ts
db: {
  modules: ["checkout-tour"],
  isolation,
  keyPrefix: "tour",
  describe: (env) => env.DATABASE_URL?.split("/").pop() ?? null, // for the log
  dropCommand: (key) => `bin/test-db-clone ${key} drop`,
}
```

The pipeline also writes the key as `FLOWREEL_DB_KEY` (or your first
alias) into the development stage's environment. Your global setup can
refuse to run against a shared database when the key is missing.

## CleanupAdapter

After every feature (pass, fail or timeout), outside the recording, a run
closes the records it created, so it leaves nothing open on a shared target.

```ts
interface CleanupAdapter {
  isRecordNumber(number: string): boolean // the shape of a record number
  doneStatuses: ReadonlySet<string> // statuses that need nothing more
}
```

The runtime owns the rules:

- `cleanupCandidates(adapter, runId, tracked, rows, skip?)` picks the records to touch: those the flow
  tracked as it created them, plus open rows whose subject carries this
  run's marker `[QA <RUN_ID>]`. A record is touched only when its number
  has your shape **and** it is tracked or marked. A real record is never
  touched.
- `cleanUpRunRecords(adapter, runId, deps)` reads each candidate's status through
  each persona in turn, leaves done or unreadable ones alone, and solves
  the rest with the first `solve` function that succeeds. It never throws.
  Every record lands in exactly one list (`solved`, `done`, `unreadable`,
  `failed`).
- `cleanupLine(feature, result, { logPrefix, noun })` formats the log line.

You supply `CleanupDeps`, built per feature over your personas' API
clients: `tracked`, `skip`, `listOpen[]`, `status[]` and `solve[]`. Report
each `failed` record with `undoLedger.recordOutcome(...)` so it becomes a
FAILED undo entry, which makes the pipeline exit 4.

Your cleanup fixture must be an `auto` fixture declared **before** the
recorded page and must not depend on it. Playwright tears fixtures down in
reverse order, so it then runs after the page and its video are closed:
off camera, with no caption. In 0.x this fixture is project-side:
`tourFixtures()` does not provide one.

## Brand and CardCopy

How the videos look and what the cards say. Both start neutral (slate
colours, no logo, plain English), and you override only what differs:

```ts
import {
  createVideoKit,
  defineBrand,
  defineCardCopy,
  defineNarrationCopy,
  svgDataUri,
} from "@confidee/flowreel/video"

export const kit = createVideoKit({
  brand: defineBrand({
    name: "Acme",
    colors: { primary: "#1d4ed8", accent: "#60a5fa" },
    logos: () => ({
      onBrand: svgDataUri("e2e/flowreel/brand/logo-white.svg"),
      onLight: svgDataUri("e2e/flowreel/brand/logo.svg"),
    }),
  }),
  copy: defineCardCopy({ run: { title: "Checkout round trip" } }),
  narrationCopy: defineNarrationCopy({ featureId: "[A-H]\\d{1,2}" }),
  narrationDir: "e2e/flowreel/narration",
})
```

The full reference (every colour token, every card string, the never-speak
patterns) is in [Narration and videos](narration-and-videos.md#your-video-kit).

## VoiceEngine

```ts
interface VoiceEngine {
  name: string // "macos", "none", …
  voice: string | null // known once available() returned null
  warning: string | null // e.g. a fallback-voice warning for the summary
  cacheParts(): string[] // everything besides the text that changes the audio
  available(): Promise<string | null> // null when it can speak, else why not
  synthesize(text: string, outPath: string): Promise<number> // writes a WAV, returns seconds
}
```

- `macosEngine(env)`: `say` plus one ffmpeg loudness pass (−16 LUFS,
  48 kHz mono). The default on macOS.
- `noneEngine(reason)`: speaks nothing. The video stays silent and the
  summary says why.
- `engineFor(env)`: picks one from `FLOWREEL_VOICE_ENGINE`.

To plug in your own engine (for example a Linux or cloud voice), pass
`voice: { engine: (env) => myEngine(env) }` to `createVideoKit`. Call every
tool with an argument array, never a shell string: the text is data and
must never become a command. Put the voice, rate and output format in
`cacheParts()` so cached clips are never mixed across settings.

## ModuleDescriptor

`SummaryReporterOptions.modules` lists the project's modules: **exactly
one** `RoundTripModule` (the release gate) and **at most one**
`TourModule`. `modulesByKind()` throws otherwise.

- **`RoundTripModule`** (`kind: "round-trip"`): `name` (what
  `summary.json` records), `project` (the Playwright project whose single
  test is the gate), optional `planFile` and `planStepPattern` (capture
  group 1 is a step id; every id appears in the summary, run or not),
  `verdictCopy` (`passed`, `notInRun`, `skipped` sentences) and, for demo
  publishing, `demo: { file, shows }`. Verdict: PASS only when the gate
  test passed; N/A when it skipped with an `N/A:` reason or did not run;
  FAIL on any failure anywhere in the run.
- **`TourModule`** (`kind: "tour"`): build it with
  `tourModuleFrom(manifest, { name, feature?, demos? })` from
  `@confidee/flowreel/tour`, never by hand. `feature` takes the same
  `annotationType` and `devOnlyPrefix` overrides you pass to
  `declareFeature()`. Leave both out on both sides to use the defaults. A
  prefix the reporter did not know would count development-only skips as
  N/A, and an annotation it did not know would lose the features. Verdict:
  FAIL on any failed feature; PASS when at least one feature was verified
  (passed or view-only) and none failed; N/A when nothing was verified.

`planStepIds()` reads a plan's step ids.

The reporter itself is a subclass (Playwright constructs reporters from a
path, so the options are bound in the subclass):

```ts
// e2e/flowreel/reporter.ts
import { SummaryReporter } from "@confidee/flowreel/reporter"
export default class extends SummaryReporter {
  constructor() {
    super(reporterOptions()) // modules, config, repoRoot, video producers, …
  }
}
```

`SummaryReporterOptions` also takes `describeConfig()` (the redacted
configuration written to `summary.json`), `videoPace(module)`,
`produceVideo` / `produceTourVideos` (from your video kit),
`publishDemos` (from your demo publisher), `setupLocation`,
`tabulatedProjects` and `preflightFile`. See its doc comments in
`runtime/src/reporter/summary.ts`.

## TourManifest

The tour as data: areas, the setup project, the project prefix and the
catalogue.

```ts
const manifest = defineTourManifest({
  areas: [{ letter: "A", slug: "listing", title: "Listing and creation" }],
  setupProject: "tour-setup",
  projectPrefix: "tour-", // default
  catalogue: { A4: { slug: "list-search", policy: "both" } },
})
```

Areas are single capital letters, each its own Playwright project
(`<prefix><lower-case letter>`). Feature ids are a letter plus one or two
digits. The manifest gives you the parsers the reporter and the pipeline
use: `parseAreas("A,c")`, `parseFeatureTitle`, `parseStepTitle`,
`projectOfArea`, `areaOfProject`, `isTourProject`, `areaOfFeature`.
`detectModule(argv, env, …)` tells your Playwright config which module a
run belongs to.

## DemoCatalogue

Where a demo-pace run's videos are published, and under which names:

| Field               | Meaning                                                   |
| ------------------- | --------------------------------------------------------- |
| `dir`               | the `latest/` folder                                      |
| `runIdPattern`      | the run ids the demos command accepts (never a path)      |
| `runDir(runId)`     | a run's results folder                                    |
| `developmentTarget` | the target automatic publishing accepts (default `local`) |
| `roundTrip`         | a `RoundTripModule` with `demo` (or none)                 |
| `tour`              | a `TourModule` with `demos` (or none)                     |
| `readme`            | the `latest/README.md` wording and the refresh command    |

`demoPublisher(catalogue)` returns `planDemos`, `publishDemos`,
`demosReadme`, `keepPassing`, `parseRunIdArg`, `areaDemoName`, `runDirOf`
and the staging skip reason, all bound to the catalogue. A run is published
under the round trip or the tour only when its summary's `module` is that
module's `name` (a summary with no `module` belongs to the round trip). Pass
the publisher's `publishDemos` to `SummaryReporterOptions.publishDemos` to
publish after a demo-pace run, and its `parseRunIdArg` and `publishDemos`
to `demosCli` for the manual command. See
[Narration and videos](narration-and-videos.md#the-demos-folder).

## rails-inertia

`@confidee/flowreel/rails-inertia` is the adapter for Rails apps rendered
with [Inertia](https://inertia-rails.dev). It has three parts:

- **`InertiaPropsReader`**: reads what the server rendered through a
  persona's API context, without scraping the DOM.
- **The seam client**: `seamSignIn()` and `HttpSeamMailDriver`, the
  development stage's side of the app's test-only seams.
- **The Rails seam kit** (plugin templates, `plugin/templates/rails/`): the
  seam controllers, their routes and one request spec per seam.

The reader only speaks the Inertia protocol and the seam client only speaks
HTTP and JSON, so neither depends on Rails; the kit is what is Rails-specific.

### InertiaPropsReader

```ts
import { InertiaPropsReader } from "@confidee/flowreel/rails-inertia"

class Shop extends InertiaPropsReader {
  async openOrders(): Promise<{ id: number }[]> {
    // a partial reload resolves the deferred `records` prop
    const props = await this.props("/orders?status=open", ["records"])
    return props.records as { id: number }[]
  }
}

// `request`: a Playwright APIRequestContext created with the target's
// baseURL and a persona's storageState (from the global setup).
const shop = new Shop(request, {
  persona: "agent",
  isSignInPath: (path) => path.startsWith("/session"),
})
```

| Member                       | What it does                                                                                                                                                                                                                                                                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `htmlPage(path)`             | A full HTML GET. Reads the initial page object, so also the asset version and the page's component.                                                                                                                                                                                                                                    |
| `page(path, only?)`          | The page object of an `X-Inertia` request. The first read of a reader is the HTML page. With `only`, a partial reload of those props (`X-Inertia-Partial-Component` + `X-Inertia-Partial-Data`): how deferred props are resolved. A `409` (the asset version changed) refetches the HTML once and retries; a second `409` is an error. |
| `props(path, only?)`         | `page(...).props`.                                                                                                                                                                                                                                                                                                                     |
| protected `request`          | the request context, for the app's own JSON calls                                                                                                                                                                                                                                                                                      |
| protected `inertiaHeaders()` | the Inertia request headers, with `X-Inertia-Version` once known (for a write the app answers with an Inertia redirect)                                                                                                                                                                                                                |
| protected `assetVersion`     | the version last read (`undefined` before the first read, `null` when the server sends none)                                                                                                                                                                                                                                           |
| protected `assertSignedIn()` | throws `notSignedIn()` when a response landed on the sign-in page                                                                                                                                                                                                                                                                      |
| protected `notSignedIn()`    | the `LoginError` for that case, in `signedOutMessage` wording                                                                                                                                                                                                                                                                          |

Options: `persona` (named in every error; default `"signed-in"`),
`isSignInPath(pathname)` (a response that landed there throws a
`LoginError` instead of being read: the session expired or was revoked,
and retrying a sign-in mid-run would feed the app's lockout counter; omit
it for an app without sessions) and `signedOutMessage(request, landed,
persona)`.

Errors name the request, the persona and the HTTP status, never a cookie.
A partial reload that renders a different component than the page's (a
redirect) is an error naming both.

Helpers: `parseInitialPage(html)` reads the page object from the Inertia v3
script element (`<script data-page="app" type="application/json">`, what
inertia_rails renders with `use_script_element_for_initial_page`) or the
legacy `<div data-page="…">` attribute, and returns null for a document
without one. `asInertiaPage(json, where)`, `decodeHtmlEntities(text)`,
`pathnameOf(path)`, `INERTIA_ACCEPT`, and `INERTIA_RAILS_CSRF`
(`{ cookie: "XSRF-TOKEN", header: "X-XSRF-TOKEN" }`, the `csrf` of a
`SessionProtocol` for inertia_rails).

### The seam client

```ts
import {
  HttpSeamMailDriver,
  seamHttpFromRequest,
  seamSignIn,
} from "@confidee/flowreel/rails-inertia"

// AppAdapter.signIn on the local target: once, never retried
await seamSignIn(api, baseURL, { body: { email: persona.email } })

// the development stage's MailDriver
const mail = new HttpSeamMailDriver({
  http: seamHttpFromRequest(request), // or seamHttpFromFetch(baseURL)
  defaultTimeoutMs: 60_000,
})
```

`seamSignIn(api, baseURL, options)` posts `options.body` to the sign-in
seam in a fresh request context and returns its storageState. Options:
`path`, `accept(status)` (default any 2xx) and `failure(status)` (the
`LoginError` text; never put a password in it).

`HttpSeamMailDriver` (`kind: "seam"`) implements `MailDriver`:

- `send()` posts `mode: "support_address"` with a fresh Message-ID; `reply()`
  posts `mode: "raw"` to the original's `Reply-To` (else `From`), with
  `In-Reply-To` and the `References` chain. Neither is ever retried: a
  retry can create a duplicate record. A `422` names the seam's `mailbox`,
  `outcome`, `reason` and `status`, never the mail.
- Every send and reply is followed by a job drain, and every poll of
  `waitFor()` starts with one, so `deliver_later` mail is delivered. A job
  that raised is listed in the drain's `errors`, and the last three appear
  in the timeout message.
- `waitFor()` reads the delivery list by cursor (a lower cursor means the
  list was cleared: it starts over), floors `since` to the second (the
  `Date` header has second precision) and matches with the shared matcher.
- `health()` reads the delivery list and drains once.
- It does not call the staging send guard: it only ever talks to the
  loopback development server, and the mail never leaves the app.

| Option                 | Default                                           | What it is for                                                                                                                    |
| ---------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `http`                 | required                                          | `seamHttpFromRequest(request)` or `seamHttpFromFetch(baseURL, fetch?)`                                                            |
| `defaultTimeoutMs`     | required                                          | the per-hop wait                                                                                                                  |
| `paths`                | `DEFAULT_SEAM_PATHS`                              | `mailDeliveries`, `performEnqueuedJobs`, `inboundEmails`                                                                          |
| `messageId(uuid)`      | `<flowreel-<uuid>@flowreel.invalid>`              | the Message-ID of a sent mail                                                                                                     |
| `alternateRecipients`  | none                                              | `(to) => string[]`: where the app's development mail sandbox would redirect `to`; a match there comes back with `sandboxed: true` |
| `notFoundHint`         | names the seam flag and a local Rails environment | appended to a `404` failure                                                                                                       |
| `now`, `sleep`, `uuid` | the real clock and `crypto.randomUUID`            | for unit tests                                                                                                                    |

### The seam protocol

Paths are the defaults (`DEFAULT_SEAM_PATHS`). Every seam answers `404`
unless the server runs in a local environment with the seam flag set,
the request comes from this machine with a loopback `Host`, and a `POST`
carries a JSON body. Every `POST` sends a JSON body with
`Content-Type: application/json` (`{}` when it has no fields); every
answer is JSON.

| Request                                 | Body                                                                                                                           | Answer                                                                                                                                                                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /test/sign_in_as`                 | `{ email, … }`                                                                                                                 | `204` + the session cookie; `404` unknown account or a body that is not JSON (a cross-site form: login CSRF); `403` may not sign in; `400` no email                                                                                                       |
| `GET /test/mail_deliveries[?after=<n>]` |                                                                                                                                | `200 { deliveries: [entry], cursor }`: the entries with `index > n` (at most the newest 200), `cursor` = the highest index (`0` when empty)                                                                                                               |
| `DELETE /test/mail_deliveries`          |                                                                                                                                | `204`: the list is cleared (a local preflight only)                                                                                                                                                                                                       |
| `POST /test/perform_enqueued_jobs`      |                                                                                                                                | `200 { performed, discarded, deferred, deferredJobs, errors: [{ job, error }] }` once every ready job ran (passes until nothing is ready); `422 { error }` when the queue adapter is not the test adapter. Anything but 200 fails                         |
| `POST /test/inbound_emails`             | `{ mode: "support_address" \| "raw", to, from, subject, body, message_id, in_reply_to?, references?, headers?, attachments? }` | `201 { mailbox, status, messageId, … }`: stored and processed; `422` with any of `mailbox`, `outcome`, `reason`, `status`: not captured (`outcome: "invalid_env"` when the queue adapter is not the test adapter; nothing is stored). Anything else fails |

A delivery entry: `index` (1-based), `messageId` (with angle brackets),
`from` (formatted, display name kept), `to`, `cc`, `replyTo` (bare
addresses), `subject`, `text` (the text part, else the HTML part reduced
to text), `inReplyTo`, `references` (with angle brackets), `headers`
(names lower-cased, a repeated header joined with `", "`) and
`deliveredAt` (ISO 8601).

Rules for a server: leave jobs scheduled for the future queued, discard the
inbound routing job when the inbound seam routes by hand (or each mail is
processed twice), refuse inbound mail where that discard cannot happen (a
real queue adapter, as in a development server: the routing job would run
too), and refuse inbound `headers` and `attachments` outside an allowlist.
The kit below does all of this.

### The Rails seam kit

`plugin/templates/rails/` holds the server side of the protocol for a
Rails 7.1+ app on Ruby 3.1+ (any Rack version: the kit answers `422` by
number, not by a Rack status symbol): `Test::E2eSeamGate` (the controller half of the double
gate), the four seam controllers, `config/routes/flowreel_seams.rb` (the
route half, loaded with `draw(:flowreel_seams)`), a request spec per seam,
a tripwire spec that fails when a `/test/` route's controller lacks the
gate or a gated controller is routed outside `/test/`, and the shared
contexts the specs use. Its README has the install steps and the
`TODO(flowreel)` spots (the flag name, and how your app finds
an account and starts a session). The inbound seam needs Action Mailbox; it
routes through your real router and mailboxes.

What has been run: the kit as shipped, copied into a new
`rails new` app (Rails 8.1.3, Ruby 3.4, Rack 3.2, PostgreSQL) with Action
Mailer, Active Job, Active Storage and Action Mailbox enabled,
`rspec-rails`, `config.action_mailer.delivery_method = :test` and a
`User` model with an `email` column. All of its request specs passed in
random order (38 examples on 2026-10-15). With the gate weakened to "not
production", every staging-like example failed; with one controller's gate
removed, the tripwire failed. On 2026-10-15 the tripwire also failed, as
it should, for an ungated controller drawn inside `scope "(:locale)"`, for
one inside an engine mounted at `/admin`, and for a gated controller routed
outside `/test/` inside that engine; and the sign-in spec failed for a form
post once the JSON check was removed. On 2026-10-16 the kit, with the
gate's loopback and JSON-body checks, was run again the same way (Rails
8.1.4, Ruby 3.4, Rack 3.2, PostgreSQL): 44 examples passed in random order;
with the loopback check removed, the non-loopback `Host` and client-address
examples failed, and with the JSON-body check removed, the form-encoded,
no-body and `text/plain` POST examples (and the sign-in seam's form post)
failed. `seamSignIn` and
`HttpSeamMailDriver` ran a send, a threaded reply and a timeout against
the earlier app's server. Older Rails, Ruby and Rack versions inside the
stated range have not been run.

Rules for every test seam (they are the reason the seams are safe to ship):

1. **Routed only in the test and development environments**, and only when
   an explicit flag is set (a double gate). In production the route does
   not exist. The controller gate keys on `Rails.env.local?`, never on "not
   production": a deployed staging environment is not production.
2. **Every seam ships a request spec that proves both 404 paths**: closed
   without the flag, and closed in a staging-like environment with the
   flag set.
3. The local target is loopback-only (see
   [Configuration](configuration.md#targets-and-the-allowlist)), so seams
   are never called on anything but this machine.
4. A seam never weakens a real control. It replaces a step the test cannot
   do in development (receiving real mail, signing in through an identity
   provider), nothing more: the sign-in seam signs in an existing account
   and refuses one the real sign-in would refuse.
5. **Every seam is routed under `/test/`.** If you change a seam's path
   through the client's `paths` or `path` option, keep it under `/test/`.
   The kit's tripwire checks both directions, in the main app and in every
   mounted engine, reading a path without its optional segments (so
   `/(:locale)/test/…` and `/admin/test/…` count): every `/test/` route's
   controller includes the gate, and no gated controller is routed outside
   `/test/`. A route under `/test/` with no controller (a redirect, a
   mounted app) fails the tripwire with its path named.

## mail-graph (Microsoft 365)

`@confidee/flowreel/mail-graph` is the `MailDriver` for one Microsoft 365
mailbox, through Microsoft Graph, using application (app-only)
permissions and the client-credentials grant.

```ts
import { GraphMailDriver } from "@confidee/flowreel/mail-graph"

const mail = new GraphMailDriver({
  tenantId,
  clientId,
  clientSecret, // from the secrets source, never the repository
  mailbox: "qa@example.com",
  replyDomain: "reply-staging.example.com",
  defaultTimeoutMs: 120_000,
})
```

flowreel reads no variables for the driver: your project's config reads
the tenant id, client id, client secret, mailbox and reply domain (see
[Configuration: secrets](configuration.md#secrets)) and passes them in.

| Option                                                | What it is                                                                                                                                                                                                            |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenantId`                                            | the directory (tenant) id                                                                                                                                                                                             |
| `clientId`                                            | the app registration's application (client) id                                                                                                                                                                        |
| `clientSecret`                                        | a client secret of the app. The only credential type in 0.x: no certificate                                                                                                                                           |
| `mailbox`                                             | the QA mailbox: the requester the flows send as, and where the app's staging mail to the personas lands                                                                                                               |
| `replyDomain`                                         | the only domain a send or reply may address (the staging reply domain)                                                                                                                                                |
| `defaultTimeoutMs`                                    | the per-hop wait                                                                                                                                                                                                      |
| `requestTimeoutMs`                                    | optional: the longest one request may take, from the connection to the last byte of the body, the token request included. Default `30_000`. A whole number of milliseconds from 1 to 2147483647, else a `ConfigError` |
| `copy`                                                | optional wording: `guard` (the send guard's `SendGuardCopy`), `healthHint` (your setting names), `subjectRequired`                                                                                                    |
| `fetch`, `now`, `sleep`, `setTimeout`, `clearTimeout` | for unit tests. The bound's timer is unref'd: a real `fetch` holds a socket until it fires, but a mocked or custom `fetch` that holds no handle may let the process exit first                                        |

What it does:

- **Send** (`sendMail`) from the mailbox itself; a `from` other than the
  mailbox (an alias of it) is set as `from` and needs the tenant's
  SendFromAliasEnabled. Graph forbids setting a Message-ID, so a send
  returns `messageId: ""` and flows correlate by subject. Extra `headers`
  and `attachments` are refused: those are development-only.
- **Reply**: `createReply`, then a PATCH that sets the one guarded
  recipient, empties Cc and Bcc and sets the text body, then `send`. Graph
  sets In-Reply-To and References from the original.
- **The send guard runs first**: every send and every reply recipient
  (Reply-To, else From) passes `assertReplyDomainRecipient` before any
  request, so a run can never mail a real mailbox.
- **Never retried**: a send or a reply. Only `waitFor`'s reads are
  re-polled: a `429`, `503` or `504` on the list (honouring Retry-After),
  and a read, the token request included, that got no answer. Any other
  failure ends the wait at once: auth, permission and token errors, and a
  connection error such as `ECONNREFUSED` (a read that could not connect
  is not a read that is slow).
- **Every request is bounded**: each Graph and token request, from the
  connection to the last byte of the body, gets `requestTimeoutMs` (30 s
  by default). Inside `waitFor` a request gets no more than the wait has
  left (at least 1 ms), and after the first attempt none starts once
  nothing is left, so a wait always ends at its own `timeoutMs`. A request that runs out is aborted and throws
  `GraphRequestTimeoutError` (`operation`, `timeoutMs`, `mayHaveSent`):
  `Graph <operation> got no answer within 30 s`. 30 s is deliberately
  stricter than the defaults around it: Microsoft's .NET Graph SDK and its
  Go client wait 100 s (its JavaScript SDK sets no request timeout), and
  Node's built-in `fetch` waits 300 s for the headers and 300 s between
  two pieces of the body, so a body that trickles in never ends.
  <!-- Sources: msgraph-sdk-dotnet-core GraphClientFactory.cs
  (`defaultTimeout = TimeSpan.FromSeconds(100)`), kiota-http-go
  kiota_client_factory.go (`Timeout: time.Second * 100`), checked
  2026-10-21; undici 7 lib/dispatcher/client.js headersTimeout and
  bodyTimeout defaults (300 000 ms). -->
- **A send that got no answer may have been sent**: a `sendMail` or a
  reply's `send` that times out has `mayHaveSent: true` and says so,
  because Graph may have accepted it before the answer was lost. It is
  not retried. A `createReply` or PATCH that times out sent nothing, but
  can leave an unsent draft in the QA mailbox's Drafts folder.
- **One token request at a time**: callers share it, and it always gets
  the full `requestTimeoutMs`. A wait with less time left stops waiting
  for it without cutting it short for the others, so the request can keep
  the process alive for at most `requestTimeoutMs` after that wait ended.
  One that timed out is dropped, and the next call asks for a new token.
- **Reads as little as it can**: `waitFor` requires `subjectIncludes`. The
  list asks Graph for that subject server-side and selects only id,
  subject and time; if Graph refuses the `contains()` filter (a `400`), the
  driver drops it for the rest of the run and narrows client-side. Body,
  recipients and headers are fetched once per message, only for one whose
  subject matched. A timeout reports counts, never another mail's subject
  or recipients.
- **Plus addresses**: the raw `To`/`Cc` headers are merged into the
  recipients, so a wait on `qa+agent@` matches even when Exchange lists
  the resolved `qa@`.
- **No secret in an error**: errors carry the HTTP status and Graph's error
  code; the access token and the client secret are redacted, and a
  transport error is re-thrown without its cause, keeping only the cause's
  system error code (`fetch failed (ECONNREFUSED)`).
- **`health()`** reads one message id. When a request got no answer, its
  message points at the network path instead of the credentials.
  **`saveEml()`** saves the raw MIME (`$value`) under the results folder.

The tenant setup below is independent of the driver code. A tenant
administrator does it once.

### What the driver needs

- A **dedicated QA mailbox** (for example `qa@example.com`) that receives
  the app's staging mail and sends the inbound test mail.
- An **Entra app registration**: the identity the driver signs in as, with
  a client secret.
- The permissions `Mail.ReadWrite` and `Mail.Send` for that app, **limited
  to the QA mailbox**. Without a limit, application mail permissions reach
  **every mailbox in the tenant**. `Mail.ReadWrite` is needed because a
  threaded reply is created as a draft (`createReply`): Graph's `sendMail`
  cannot set In-Reply-To or References. `Mail.Read` plus `Mail.Send` is
  the least-privilege option only if you never need threaded replies.
- The tenant id, client id and client secret, provided to staging runs as
  secrets.

Exchange Online has two ways to limit an app to one mailbox. The driver
works the same with either: it only ever calls Graph for the QA mailbox.

| Way                                                                    | Microsoft's status                                                      | Use it for                                                           |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [RBAC for Applications](#admin-steps-rbac-for-applications)            | the current mechanism: it "replaces Application Access Policies"        | every new setup                                                      |
| [An application access policy](#an-existing-application-access-policy) | replaced. The cmdlet's page says "Don't create new App Access Policies" | a tenant that already restricts this app with one, until you migrate |

The two work differently, and mixing them up opens every mailbox:

- With **RBAC for Applications**, the permissions are granted in Exchange
  Online, together with their scope. The app must have **no** admin
  consent for `Mail.*` in Entra ID: Exchange adds the Entra grants to its
  own, so an unscoped Entra consent makes the scope meaningless.
- With an **application access policy**, the permissions are consented in
  Entra ID and the policy restricts them to a group of mailboxes.

### Admin steps: RBAC for Applications

A tenant administrator does this once, in Exchange Online PowerShell
(`Connect-ExchangeOnline`), as a member of the Organization Management
role group.

1. **Create the app registration with no mail permissions.** Entra admin
   center → App registrations → New registration. Do not add or consent
   `Mail.ReadWrite` or `Mail.Send` there. Note the Application (client)
   ID and the Directory (tenant) ID. Then open **Enterprise applications**
   → the same app, and note its **Object ID**: the service principal's,
   not the one on the App registrations page, which is different.

2. **Create a mail-enabled security group that holds only the QA
   mailbox.** Only direct members count: a nested group's members are out
   of scope.

   ```powershell
   New-DistributionGroup -Name "flowreel QA mailboxes" -Alias flowreel-qa-mailboxes `
     -Type Security -Members qa@example.com
   ```

3. **Create a management scope for that group.** The filter takes the
   group's distinguished name:

   ```powershell
   $dn = (Get-Group flowreel-qa-mailboxes).DistinguishedName
   New-ManagementScope -Name "flowreel QA mailbox" `
     -RecipientRestrictionFilter "MemberOfGroup -eq '$dn'"
   ```

4. **Point Exchange at the app's service principal:**

   ```powershell
   New-ServicePrincipal -AppId <client-id> -ObjectId <enterprise-app-object-id> `
     -DisplayName "flowreel QA"
   ```

5. **Grant the two permissions inside that scope.** The role
   `Application Mail Full Access` is exactly `Mail.ReadWrite` plus
   `Mail.Send`:

   ```powershell
   New-ManagementRoleAssignment -App <enterprise-app-object-id> `
     -Role "Application Mail Full Access" -CustomResourceScope "flowreel QA mailbox"
   ```

6. **Test it.** Do not continue until each test gives the expected result:

   ```powershell
   Test-ServicePrincipalAuthorization -Identity <enterprise-app-object-id> `
     -Resource qa@example.com | Format-Table
   # InScope : True
   Test-ServicePrincipalAuthorization -Identity <enterprise-app-object-id> `
     -Resource someone.real@example.com | Format-Table
   # InScope : False
   ```

   Also test your real support mailbox: it must be **False**. This test
   leaves out Entra grants, so also check Entra admin center → Enterprise
   applications → the app → Permissions: no `Mail.*` application
   permission may have admin consent. The test reads the new assignment
   at once, but the app's live calls can take from 30 minutes to 2 hours to
   follow a change, so wait before the first run and after any change to
   the scope.

7. **Create a client secret** (the only credential type the driver
   supports in 0.x). Record its expiry and rotate it before then (180 days
   is a sensible maximum), and keep it only in your password manager.

8. **Check the mailbox itself** before the first run, and again before each
   release gate. Your app's staging mail may come from a real support
   address, so an automatic reply or a forward on the QA mailbox would mail
   real people or carry test mail outside the app's scope:

   ```powershell
   Get-MailboxAutoReplyConfiguration qa@example.com   # AutoReplyState : Disabled
   Get-Mailbox qa@example.com | Format-List ForwardingAddress,ForwardingSmtpAddress,DeliverToMailboxAndForward
   # empty, empty, False
   Get-InboxRule -Mailbox qa@example.com              # nothing that forwards or redirects
   Get-MailboxPermission qa@example.com               # keep the list of people minimal
   Get-RecipientPermission qa@example.com
   ```

   The driver does not read these settings itself: that would need one more
   permission (`MailboxSettings.Read`).

9. **Turn on auditing.** Confirm that the unified audit log records
   `MailItemsAccessed` and `Send` for the app's identity, and register the
   app, its credential and the mailbox (with its owner and members) in your
   asset inventory.

### An existing application access policy

If your tenant already limits the app with an application access policy,
the driver works with it unchanged. Microsoft has replaced these policies
with RBAC for Applications and asks you not to create new ones, so do not
set one up for a new app. Keep an existing one correct until you migrate:

- The app's `Mail.ReadWrite` and `Mail.Send` are application permissions
  with admin consent in Entra ID, and a `RestrictAccess` policy limits them
  to a mail-enabled security group that holds only the QA mailbox:

  ```powershell
  New-ApplicationAccessPolicy -AccessRight RestrictAccess -AppId <client-id> `
    -PolicyScopeGroupId <group address>
  ```

- `Test-ApplicationAccessPolicy -Identity <mailbox> -AppId <client-id>`
  must report `AccessCheckResult : Granted` for the QA mailbox and
  `Denied` for any other mailbox, your real support mailbox included.
- Order matters when a policy changes: consent granted before the policy
  takes effect gives the app every mailbox until it does. Change the
  policy first, test it, and only then grant consent.
- Steps 7 to 9 above (the secret, the mailbox checks, auditing) apply
  unchanged.

**Migrating** without an interruption, in Microsoft's order, with a test
and a wait before anything is removed:

1. Create the management scope from the policy's group (step 3 above).
2. Create the service principal pointer (step 4).
3. Assign `Application Mail Full Access` with that scope (step 5), and run
   the `Test-ServicePrincipalAuthorization` checks in step 6 at once:
   `InScope : True` for the QA mailbox, `False` for another mailbox and
   for your real support mailbox. A wrong scope (a bad group filter, say)
   shows up here, while the access policy still protects the tenant. Do
   not continue until all three give the expected result.
   **Wait for the assignment to reach the app's live calls** (up to 2
   hours) before step 4: until it does, the Entra consent is what lets the
   app in, and removing it early interrupts access.
4. Remove the app's `Mail.*` admin consent in Entra ID.
5. Remove the application access policy (`Remove-ApplicationAccessPolicy`).

Then run the step 6 tests again, check that no `Mail.*` application
permission keeps admin consent in Entra ID, and run the health check.

<!-- Checked 2026-10-15 against Microsoft Learn: "Role Based Access Control
for Applications in Exchange Online" (exchange/permissions-exo/application-rbac,
updated 2026-08-21; the Graph page on limiting mailbox access now redirects
there) and New-ApplicationAccessPolicy (its "Important" note). TODO(verify):
replay these steps in a test tenant; nobody has run them end to end yet. -->

### On the flowreel side

- Set the reply domain (an inbound domain routed to **staging**, never
  production's) as the only domain staging runs may mail. The send guard
  refuses everything else before any request.
- Keep the QA mailbox's credentials only in your password manager, injected
  for one command (see [Configuration: secrets](configuration.md#secrets)).
- Treat saved `.eml` files in the results folder as sensitive: they can
  contain reply tokens.
