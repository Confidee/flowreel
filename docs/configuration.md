# Configuration

A flowreel project is configured in three places:

1. **`flowreel.config.ts`**: one `defineConfig()` call with the targets,
   modules, personas, secrets and results folder. Reviewed and committed.
2. **Environment variables** (`FLOWREEL_*`): what this particular run should
   do. Set per command, by the pipeline, or by CI.
3. **Secrets**: passwords and API credentials for staging. Never committed:
   injected into the process environment for one command, or kept in an
   owner-only file outside the repository.

The video look and voice (brand, card wording, narration copy) are
configured separately, through `createVideoKit()`. See
[Narration and videos](narration-and-videos.md).

- [defineConfig reference](#defineconfig-reference)
- [Targets and the allowlist](#targets-and-the-allowlist)
- [Environment variables](#environment-variables)
- [Your own variable names (aliases)](#your-own-variable-names-aliases)
- [Secrets](#secrets)
- [The Playwright config: createConfig()](#the-playwright-config-createconfig)

## defineConfig reference

```ts
// flowreel.config.ts
import { join } from "node:path"

import { defineConfig } from "@confidee/flowreel/config"

export const flowreel = defineConfig({
  logPrefix: "flowreel", // console lines read "[flowreel] …" (the default)
  targets: {
    local: {
      host: "localhost",
      portMin: 3100,
      portMax: 3199,
      defaultPort: 3101,
    },
    staging: ["https://staging.example.com"],
    isProductionHost: (host) =>
      host === "example.com" || host === "app.example.com",
  },
  modules: { names: ["smoke", "tour"], default: "smoke" },
  personas: ["user", "admin"],
  secrets: {
    file: (home) => join(home, ".config", "flowreel", "staging.env"),
    template: "e2e/flowreel/env.example",
    envHint: "e.g. injected from your password manager",
  },
  results: "flowreel-results",
  envAliases: {}, // see "Your own variable names"
})
```

`defineConfig()` checks the whole object once, throws a `ConfigError` that
names the first problem, registers your environment aliases, and returns
the config with defaults filled in. Everything else in the runtime takes
the result as a parameter. Nothing reads the file behind your back.

| Field                | Type                               | Meaning                                                                                                 |
| -------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `logPrefix`          | `string` (optional)                | Console prefix, `[<logPrefix>] …`. Default `flowreel`.                                                  |
| `targets`            | `TargetPolicy`                     | Where a run may point. See [Targets](#targets-and-the-allowlist).                                       |
| `modules.names`      | `string[]`                         | Every module a pipeline can run. Non-empty, no repeats.                                                 |
| `modules.default`    | one of `names`                     | The module when `--module` and `FLOWREEL_MODULE` are not given.                                         |
| `personas`           | `string[]`                         | Every persona key, in sign-in order. No repeats.                                                        |
| `secrets.file`       | `(home: string) => string`         | The default secrets file for a home directory. `FLOWREEL_ENV_FILE` overrides it per run.                |
| `secrets.baseUrlKey` | `string` (optional)                | The variable that holds the staging base URL. Default `FLOWREEL_BASE_URL`.                              |
| `secrets.template`   | `string` (optional)                | Path to your secrets template, named in error messages.                                                 |
| `secrets.envHint`    | `string` (optional)                | How secrets usually arrive, named in error messages.                                                    |
| `results`            | `string`                           | The results folder. Each run writes `<results>/<RUN_ID>/`. Resolved to an absolute path. Git-ignore it. |
| `envAliases`         | `Record<KEY, string[]>` (optional) | Your own names for flowreel's variables. See [aliases](#your-own-variable-names-aliases).               |

Helpers on the result: `resultsDir(config, runId)` (`<results>/<runId>`)
and `reportDir(config, runId)` (`<results>/<runId>/report`).

Two generic parameters type your module and persona names:
`FlowreelConfig<"smoke" | "tour", "user" | "admin">`. The template exports
them as `type Module = (typeof flowreel.modules.names)[number]` and
`type PersonaKey = (typeof flowreel.personas)[number]`.
`defineConfig()` infers them from the literals you pass.

## Targets and the allowlist

```ts
interface TargetPolicy {
  local: {
    host?: string // "localhost" (default), "127.0.0.1" or "[::1]"
    portMin: number
    portMax: number
    defaultPort?: number // default portMin
  }
  staging: readonly string[] // exact https origins
  isProductionHost: (host: string) => boolean // host is lower-cased
}
```

The rules, checked by `defineConfig()` and again on every base URL before
any request:

- **Local** means `http://<loopback host>:<port>`, with the port inside
  `portMin..portMax`, and no path, query, fragment or credentials. The
  local stage points test-only seams at this host, so nothing off the
  machine is ever accepted.
- **Staging** means exactly one of the listed origins. Each must be a bare
  `https://` origin.
- **Production** is refused for every target, with its own message, even
  when the policy lists it as local or staging. `isProductionHost` is your
  rule, so make it generous: list every production host name, including
  reply and API subdomains.
- Error messages never echo credentials from a URL.

Use `assertSafeBaseUrl(url, target, policy)`, `parseLocalPort(raw, policy,
label)` and `resolveBaseUrl(source, policy, secrets)` from
`@confidee/flowreel/config` when you build your own settings on top.

## Environment variables

flowreel reads `FLOWREEL_<KEY>`. If you register aliases, it then tries each
alias in order. An unset or empty value falls through to the next name. Error
messages name the variable that was actually set, never its value.

### What a run is

| Variable              | Values                       | Meaning                                                                                                                                                                                                                                                         |
| --------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FLOWREEL_TARGET`     | `local` (default), `staging` | The target. Read from the process environment only, never from the secrets file. The pipeline sets it per stage.                                                                                                                                                |
| `FLOWREEL_RUN_ID`     | `loc-…`, `stg-…`             | The run id shared by the runner, workers and reporter. Your Playwright config sets it with `settleEnvValue()` before workers start. The pipeline sets it per stage.                                                                                             |
| `FLOWREEL_MODULE`     | one of `modules.names`       | The module. When unset, `detectModule()` infers the tour module from `--project` arguments. The pipeline sets it per stage.                                                                                                                                     |
| `FLOWREEL_LOCAL_PORT` | inside `portMin..portMax`    | The development stage's port. Default `targets.local.defaultPort`. Use a different port per developer or agent to run in parallel.                                                                                                                              |
| `FLOWREEL_BASE_URL`   | an allowlisted origin        | The staging base URL (or whatever `secrets.baseUrlKey` names). Process env or the secrets file. The pipeline strips this name and its aliases from the development stage. A custom `secrets.baseUrlKey` is stripped only if `PipelineSpec.isSecret` matches it. |
| `FLOWREEL_ENV_FILE`   | a path                       | Overrides `secrets.file` for this run. Treated as a staging secret.                                                                                                                                                                                             |
| `FLOWREEL_DB_KEY`     | set by the pipeline          | The development stage's database copy key, when `DbIsolation` is configured.                                                                                                                                                                                    |

`TARGET`, `RUN_ID` and `MODULE` decide what a run _is_. For these three, a
disagreement is refused rather than resolved: if `FLOWREEL_<KEY>` and one of
its aliases are both set to different values, the run stops with a message
naming both variables. An inherited `FLOWREEL_TARGET=staging` can never
silently turn a local run into a staging run.

### Stopping and deadlines

| Variable                      | Values                                                                  | Meaning                                                                                                                               |
| ----------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `FLOWREEL_DEADLINE`           | a duration (`25m`, `90s`, `1h`, milliseconds) or a time (ISO, epoch ms) | The pipeline's deadline when `--deadline` is not given. No default. See [Time limits on CI](pipeline-and-gates.md#time-limits-on-ci). |
| `FLOWREEL_COMPOSE_BUDGET_SEC` | seconds (default 60)                                                    | With a deadline, a video is composed only when at least this much time is left before it; otherwise it is skipped.                    |
| `FLOWREEL_DEADLINE_AT`        | set by the pipeline                                                     | The deadline as epoch milliseconds, for the stage's own video (and, on Windows, its stop).                                            |
| `FLOWREEL_PIPELINE_PID`       | set by the pipeline                                                     | The pipeline's process id. The stage stops as on a Ctrl-C when that process is gone.                                                  |
| `FLOWREEL_HUP`                | set by the pipeline (`graceful`)                                        | Set when the pipeline runs in a terminal: a hangup (SIGHUP) is then a stop request for the stage. Otherwise SIGHUP keeps its default. |

The pipeline never passes an inherited `FLOWREEL_DEADLINE`,
`FLOWREEL_DEADLINE_AT`, `FLOWREEL_PIPELINE_PID` or `FLOWREEL_HUP` on to a
stage. See [Interrupting a run](pipeline-and-gates.md#interrupting-a-run).

### Pace, video and voice

| Variable                   | Values                                        | Meaning                                                                                                   |
| -------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `FLOWREEL_PACE`            | `demo` (default), `qa`                        | Tour pace. See [Concepts: pace](concepts.md#pace).                                                        |
| `FLOWREEL_NARRATION`       | `on`/`1`/`true`/`yes`, `off`/`0`/`false`/`no` | Forces narration on or off. Unset: on for a tour at demo pace, off otherwise.                             |
| `FLOWREEL_VIDEO`           | `off`/`0`/`false`/`no` disables               | The run videos. Default on.                                                                               |
| `FLOWREEL_SLOW_FACTOR`     | 1 to 3 (default 1.5)                          | How much slower recordings play at demo pace. Anything outside the range uses the default.                |
| `FLOWREEL_SLOW_MO`         | milliseconds                                  | Browser slowMo. The pipeline sets 300 with `--headed` when nothing else is set. Your config reads it.     |
| `FLOWREEL_VOICE`           | an installed voice name                       | The exact macOS voice, for example `Zoe (Premium)`. Default: the best installed English voice.            |
| `FLOWREEL_VOICE_RATE`      | 90 to 360 (default 175)                       | Words per minute. A value outside the range, or not a whole number, uses the default.                     |
| `FLOWREEL_VOICE_ENGINE`    | `macos`, `none`                               | Default `macos` on macOS, `none` elsewhere. `piper` and `azure` are reserved and not built yet.           |
| `FLOWREEL_VOICE_CACHE_DIR` | a path                                        | Where voice clips are cached. Default `.flowreel/cache/voice` under the working directory. Git-ignore it. |

### Sessions

| Variable                     | Values                  | Meaning                                                                                                                                                                                        |
| ---------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FLOWREEL_KEEPALIVE_MAX_MIN` | 15 to 480 (default 120) | The session keepalive stops this many minutes after the run started. A project can lower the upper limit with `tourFixtures({ keepalive: { maxMinutes } })`. See [Safety](safety.md#sessions). |
| `FLOWREEL_STATE_<PERSONA>`   | set by global setup     | A persona's session handed to the workers, in memory only. Never set it yourself. The pipeline strips it from every stage's environment.                                                       |

The plugin's session-start check reads `FLOWREEL_PREREQS`: `off` silences
it, `always` runs it outside flowreel projects too.

flowreel also respects two standard variables: `PWDEBUG` (the session
keepalive is off under the Playwright inspector) and `CI` (`test.only` is
refused when `CI` is set).

### Variables your project defines

Settings the runtime does not read itself are yours to name. The init
templates use this convention, read by `loadRun()` in
`e2e/flowreel/adapter.ts`:

| Variable                      | Meaning                                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| `FLOWREEL_<PERSONA>_EMAIL`    | a persona's staging account, for example `FLOWREEL_ADMIN_EMAIL`. Dedicated QA accounts only.    |
| `FLOWREEL_<PERSONA>_PASSWORD` | its password. Required on staging for every persona in `personas`. Treated as a staging secret. |

Locally, personas use your seeded development accounts and these are never
read. Mail credentials and a reply domain, when you add a mail driver,
follow the same pattern.

Read your own settings through the config source
(`openConfigSource(...).get(name)`), so they follow the same rules as flowreel's own: process env first, the secrets file only on
staging, empty means unset. The default wording of the mail send guard
names `FLOWREEL_REPLY_DOMAIN`. Pass a `SendGuardCopy` if your setting is
called something else.

## Your own variable names (aliases)

If your project already has names for these settings (for example from a
harness flowreel replaced), keep them working with aliases:

```ts
defineConfig({
  // …
  envAliases: {
    TARGET: ["MYAPP_E2E_TARGET"],
    RUN_ID: ["MYAPP_QA_RUN_ID"],
    LOCAL_PORT: ["MYAPP_QA_PORT"],
    VOICE: ["MYAPP_QA_VOICE"],
  },
})
```

or, outside `defineConfig()`:

```ts
import { registerEnvAliases } from "@confidee/flowreel/core"

// once, in a module that every process (runner, workers, CLIs) loads
// before it reads the environment
registerEnvAliases({ VIDEO: ["MYAPP_QA_VIDEO"] })
```

Rules:

- Keys are written without the prefix, in upper case (`VOICE`, not
  `FLOWREEL_VOICE`). An alias may not start with `FLOWREEL_`.
- `FLOWREEL_<KEY>` is always read first, then the aliases in order.
- When the pipeline **writes** a value for a child process, it uses your
  first alias (or `FLOWREEL_<KEY>` without one), so old scripts that read
  your names directly keep working.
- Registration is idempotent and only appends. flowreel itself registers
  no aliases.
- Every process must load the module that registers them: the Playwright
  config (and therefore the workers and reporter), the pipeline script and
  the demos script.

## Secrets

flowreel needs secrets only for staging: persona passwords, mail provider
credentials, perhaps the staging base URL. Local runs need none, and **a
local run never reads the secrets file**.

There are two supported ways to provide them.

**Recommended: inject them for one command.** Keep them in your password
manager and load them into the environment of a single command, so no
plaintext copy stays on disk:

```bash
# example with a password manager CLI that prints KEY=VALUE lines
( set -a; . <(your-password-manager get-note "flowreel staging.env"); set +a
  npm run flowreel )
```

**Alternative: an owner-only file outside the repository**, at the path
`secrets.file(home)` returns (or `FLOWREEL_ENV_FILE`):

```bash
mkdir -p ~/.config/flowreel
cp e2e/flowreel/env.example ~/.config/flowreel/staging.env
chmod 600 ~/.config/flowreel/staging.env
```

The file is `KEY=VALUE` lines, with `#` comments, an optional `export `
prefix and optional quotes. flowreel refuses to read it if it is owned by
someone else or readable by group or others, and the message tells you the
`chmod` to run. It checks the open file descriptor, so the file checked is
the file read.

How values are resolved:

1. The target comes from the process environment only.
2. On a staging run, the file is read once. A key **present** in the process
   environment always wins, even when empty: an empty value blanks a file
   value.
3. An empty value counts as unset.
4. `requireKeys(source, keys)` throws naming every missing key, never a
   value. The pipeline uses this to report "staging not configured
   (missing …)" up front, before development spends minutes running.
5. `assertNoPlaceholders(source, keys, placeholders)` refuses values still
   left as template placeholders (`change-me` and the like), naming the
   keys only.

The pipeline strips staging secrets from the development stage's
environment: `FLOWREEL_BASE_URL` and `FLOWREEL_ENV_FILE` (and their
aliases), plus anything your `PipelineSpec.isSecret(name)` matches. Make
`isSecret` match every staging credential, and your custom
`secrets.baseUrlKey` if you set one. Otherwise that variable reaches the
development stage, where `resolveBaseUrl()` refuses it as a non-loopback
URL and the development stage fails with a confusing message. With a
complete `isSecret`, a password injected for staging never reaches the
local run. See [Safety](safety.md#secrets).

### The env template

`/flowreel:init` writes `e2e/flowreel/env.example`. Commit it: it shows the
shape (names and placeholders), never real values. Put a placeholder that
`assertNoPlaceholders` will refuse in every secret slot, so a copied but
unfilled template fails before any request is made.

## The Playwright config: createConfig()

`createConfig()` from `@confidee/flowreel/config` returns the Playwright
config for one run. You supply what differs between projects. flowreel fixes
what must not change:

| Fixed by flowreel                                            | Why                                                                                                                                                                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retries: 0`, `workers: 1`, `fullyParallel: false`           | a re-sent mail duplicates records; a re-run sign-in feeds a lockout counter                                                                                                                                   |
| `trace: "on"`, `screenshot: "on"`, `video: "on"`             | every run is evidence; the video is built from the recording                                                                                                                                                  |
| `outputDir` and the HTML report inside `<results>/<RUN_ID>/` | a shared report folder would keep only a pipeline's last stage                                                                                                                                                |
| reporters `list`, `html`, and your summary reporter          | the summary is what the pipeline and the plugin read                                                                                                                                                          |
| `webServer` only when the target is `local`                  | staging is never started by flowreel                                                                                                                                                                          |
| `forbidOnly` on CI                                           | a stray `test.only` must not pass a gate                                                                                                                                                                      |
| `launchOptions` `handleSIGTERM: false`                       | a CI signals the whole process group; a browser that closed itself would lose the running test's video. The runner stops gracefully and closes it. A project's own launchOptions keep this unless they set it |

| Input                                                 | Meaning                                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `target`, `baseURL`                                   | from `readTarget()` and `resolveBaseUrl()`                                           |
| `resultsDir`, `reportDir`                             | from `resultsDir(config, runId)` and `reportDir(config, runId)`                      |
| `reporter`, `globalSetup`, `globalTeardown`           | module paths, relative to the config file                                            |
| `testDir`, `timeout`, `projects`, `testIgnore`        | as in Playwright                                                                     |
| `video: { on, size? }`                                | on from `videoEnabled()`; size `APP_VIEWPORT` (1680x945) for full-quality reels      |
| `slowMo`                                              | from the pace (`PACE_SLOW_MO`) or `FLOWREEL_SLOW_MO`                                 |
| `use`                                                 | extra Playwright `use` options, merged under flowreel's                              |
| `webServer`                                           | `localWebServer({ cwd, port, command, readyPath, baseURL, reuse, env })`             |
| `expectTimeout`, `actionTimeout`, `navigationTimeout` | default 15 s, 15 s, 30 s (flowreel's own requests have their own `requestTimeoutMs`) |

`localWebServer()` waits for `readyPath` (default `/up`) to answer, for up to
180 seconds by default. Set `reuse: true` only when nothing per-run, such as
a fresh database, is in play, and never on CI: a reused server may be
running old code or pointing at another database.
