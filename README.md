<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/flowreel-mint-horizontal-dark.svg">
    <img alt="flowreel" src="assets/brand/flowreel-mint-horizontal-light.svg" height="64">
  </picture>
</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@confidee/flowreel"><img alt="npm version" src="https://img.shields.io/npm/v/@confidee/flowreel"></a>
  <a href="https://github.com/Confidee/flowreel/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Confidee/flowreel/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/npm/l/@confidee/flowreel"></a>
  <a href="docs/getting-started.md#1-prerequisites"><img alt="Node >= 20" src="https://img.shields.io/node/v/@confidee/flowreel"></a>
  <a href="docs/plugin.md"><img alt="Claude Code plugin" src="https://img.shields.io/badge/Claude_Code-plugin-0F8A7E"></a>
</p>

**Playwright flows that are both your release gate and your narrated product videos.**

flowreel takes plain-English feature plans and turns them into deterministic
Playwright flows. You run your app's features with one command, first on a
development target and then, only if they pass, on staging. Each run gives
you three things:

- **a verdict** (PASS, FAIL or N/A) that only Playwright assertions decide,
  and that a CI job or a release checklist can gate on;
- **an evidence trail**: a per-step summary, traces, an HTML report and an
  undo ledger for every change the run made to shared configuration;
- **branded, narrated videos** of every feature, with a caption per step,
  email cards, a spoken explanation of each step and a scoreboard at the end.

You record the flow once and get the regression test, the release evidence
and the demo or training video from it.

https://github.com/user-attachments/assets/1aea798d-8d1b-4121-ad30-244d1b84480d

<sub>A 76-second demo, sound on: flowreel records one flow of a small demo
app, with a caption and a verdict per step, narrated with
[Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) (Apache-2.0). The video, its
thumbnail and the run's report are in [assets/demo](assets/demo/README.md).</sub>

> **Status: 0.x** (APIs may still change between minor versions). The APIs
> described here are the ones in
> the code today, including the `rails-inertia` and `mail-graph` adapters
> and the Claude Code plugin. Not shipped yet: a `flowreel` command-line
> binary (a project calls the exported commands from its own entry files)
> and voice engines off macOS (videos made there are silent). The runtime
> is on npm as
> [`@confidee/flowreel`](https://www.npmjs.com/package/@confidee/flowreel),
> published by this repository's [release workflow](RELEASING.md) with a
> provenance attestation.

## What a run looks like (the 60-second version)

You type `/flowreel:run checkout` in Claude Code, or
`npm run flowreel -- --module checkout` in a terminal:

1. **Development stage.** flowreel starts your app on a loopback port, with
   its own database copy if you configured one. It signs each persona in
   **once**, then runs the `checkout` flows in a recorded Chromium.
2. **The gate.** If development passed, the same flows run against your
   allowlisted staging host, with real mail if you configured a mail driver.
   If development failed, staging never starts. Add `--local` to stop after
   development: staging is then reported as `skipped (--local)`.
3. **The result.** `pipeline.md` puts both stages side by side, and the exit
   code reports the verdict: 0 pass, 1 fail, 2 staging not configured,
   3 nothing verified, 4 a shared-config change could not be put back,
   64 bad arguments, 130 stopped (Ctrl-C, a CI's stop signal or the
   `--deadline`). See
   [Exit codes](docs/pipeline-and-gates.md#exit-codes).
4. **The video.** An MP4 at 1920x1080. A title card, then your app with a
   caption bar per step ("Checkout · The customer pays with a saved card ·
   Passed"), email cards where mail moved, and an outro listing every step.
   With narration turned on (`FLOWREEL_NARRATION=on`), a voice explains
   each step and the picture holds until the sentence ends; otherwise the
   video is silent.

If something fails, `/flowreel:explain` reads the summary and the trace and
tells you in plain language which step broke and why. It may suggest a
locator fix. It never edits an assertion.

## Features

- **Deterministic verdicts.** Never retried, one worker, a trace and a video
  of everything. AI helps write plans, flows and narration, and explains
  results. It never decides PASS or FAIL.
- **Development → staging pipeline** with a gate, a clean environment per
  stage (staging secrets never reach the development run), optional
  per-run database isolation, and exit codes CI can rely on.
- **Feature tours.** A catalogue of features grouped into areas, each with
  an owner-approved staging policy (`both`, `both+undo`, `dev`, `view`)
  that only `feature()` applies. A static tripwire keeps flows honest.
- **Personas.** Each persona signs in once per run in global setup and its
  session is handed to the workers in memory. The recorded page can switch
  persona without signing in again. Every session is revoked at teardown.
- **Write-ahead undo ledger.** Every change to shared configuration is
  recorded before it is made, restored newest-first after the test, and
  listed with manual instructions if a restore fails (exit code 4).
- **Safe by default.** Production hosts are refused. Staging is an exact
  allowlist. Sign-ins are never retried. A send guard limits mail to one
  configured domain, checked before any network call, wherever your mail
  driver or flow calls it (see [Safety](docs/safety.md#mail)).
- **Branded videos.** Your colours, logos and wording through `Brand` and
  `CardCopy`. Email cards redact reply tokens and links. On staging, a
  privacy mask you install on the recorded page blurs table rows that do
  not belong to the run.
- **Narration**, off unless you turn it on (`FLOWREEL_NARRATION=on`).
  Every step is then spoken from its own title, and you can add curated
  lines per step. The built-in voices are the macOS system voices, which
  Apple licenses for personal, non-commercial use only; for work or public
  videos, see [Voices and licensing](docs/narration-and-videos.md#voices-and-licensing). Addresses,
  links, run ids and tokens are never spoken. Clips are cached, so a re-run
  only synthesizes the lines that changed.
- **Demos folder.** After a passing demo-pace development run, the videos
  are copied to `latest/` under fixed names, with a README.
- **Local-first, no telemetry.** flowreel talks only to the targets, mail
  provider and voice engine you configure.

## Quick start

You need Node.js 20.19+, 22.12+ or 23+ (any 20+ if your `package.json` has
`"type": "module"`; prefer 22 or later, since Node 20 is end-of-life and
supported as best effort only), Playwright 1.56 or later with its
Chromium, and, for videos, ffmpeg. [Getting started](docs/getting-started.md#1-prerequisites)
lists every prerequisite, why flowreel needs it, and the install commands
for each OS.

### With Claude Code (recommended)

```text
/plugin marketplace add Confidee/flowreel
/plugin install flowreel@flowreel
/flowreel:doctor
/flowreel:init
/flowreel:run <module> --local
```

1. **Install the plugin** from the `flowreel` marketplace in this
   repository ([Installing the plugin](docs/team-install.md) also covers
   a local clone and enabling it for a whole project). Start a new
   session afterwards so the skills load.
2. **`/flowreel:doctor`** checks each prerequisite, says what it is for, and
   offers the exact install command. It installs nothing unless you say yes.
3. **`/flowreel:init`** shows a plan, then scaffolds `flowreel.config.ts`
   and `e2e/flowreel/`, adds the `.gitignore` entries and the
   `flowreel`, `flowreel:demos` and `flowreel:unit` npm scripts, and
   (after a second yes) installs `@confidee/flowreel` as a dev
   dependency.
4. **`/flowreel:inventory` and `/flowreel:author`** turn a module of your app
   into a feature catalogue and then into flows.
5. **`/flowreel:run <module> --local`** runs the development stage once
   and explains the result. Drop `--local` when you want the staging stage
   too: it runs only after development passes.

[docs/plugin.md](docs/plugin.md) lists every skill, agent and hook, and
every command the plugin may run on your machine.

### Use with any Agent Skills agent

[`skills/flowreel/`](skills/flowreel/) is flowreel as a standard
[Agent Skill](https://agentskills.io): one folder with a `SKILL.md` and
its `references/` and `scripts/`, for any agent that reads the format. It
covers the same workflows as the plugin (doctor, init, inventory, author,
narrate, run, explain, demos). You ask for them in words, because there
are no `/flowreel:*` commands, plugin agents or session-start check
outside the plugin. In Claude Code, the plugin above is still the better
choice.

Get the folder from a release (0.5.0 or later; the
[Releases](https://github.com/Confidee/flowreel/releases) page names the
newest), then copy it to where your agent looks for skills:

```bash
git clone --depth 1 --branch v<version> https://github.com/Confidee/flowreel.git /tmp/flowreel-skill
mkdir -p .claude/skills && cp -R /tmp/flowreel-skill/skills/flowreel .claude/skills/
```

`.claude/skills/` in your project works for all three agents below.
Each also reads its own folders:

| Agent                     | Project (this repository only)                                          | Personal (every project)                                         |
| ------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Claude Code               | `.claude/skills/flowreel/`                                              | `~/.claude/skills/flowreel/`                                     |
| Cursor                    | `.cursor/skills/`, `.agents/skills/` or `.claude/skills/` + `flowreel/` | `~/.cursor/skills/`, `~/.agents/skills/` or `~/.claude/skills/`  |
| GitHub Copilot in VS Code | `.github/skills/`, `.agents/skills/` or `.claude/skills/` + `flowreel/` | `~/.copilot/skills/`, `~/.agents/skills/` or `~/.claude/skills/` |

Then start a new chat and ask, for example, "set up flowreel in this
project". In VS Code, **Open Customizations** in the Chat view lists the
skill under **Skills**. Read `SKILL.md` before you rely on it, as you
would for any skill you copy in.

**What the plugin enforces and the skill can only ask for.** In the
plugin, every workflow but explain starts only when you call it, and the
two exploring agents can only read. The specification has no field for
either, so the skill states both as rules the agent must follow:

- start a workflow only when you ask for it;
- only read while exploring an app or a run.

An agent that ignores its instructions is not stopped by anything. Use
the plugin where you can.

What has been checked, and what has not:

- **Checked:** `SKILL.md` follows the Agent Skills specification and
  passes its reference validator (`skills-ref validate`). We targeted the
  specification at commit
  [`69ef37e`](https://github.com/agentskills/agentskills/tree/69ef37e9424c0a7ea9dd2293b559e43ec8176379)
  (2026-08-09); it has no version number of its own. In CI, a stricter
  check of our own runs on every change. The folders in the table come
  from each agent's documentation, read on 2026-10-22 and 2026-10-23:
  [Claude Code](https://code.claude.com/docs/en/skills),
  [Cursor](https://cursor.com/docs/context/skills),
  [VS Code](https://code.visualstudio.com/docs/copilot/customization/agent-skills).
- **Run in Claude Code without the plugin** (2026-10-23, Claude Code
  2.1.309): a new Node app, with the skill installed as above from the
  v0.5.0 tag and the flowreel plugin switched off.
  - From plain requests, Claude Code loaded the skill and checked the
    prerequisites from the project.
  - It showed the set-up plan and waited for a yes before writing.
  - It scaffolded from the tag's templates and installed
    `@confidee/flowreel` from npm.
  - It wrote the round trip (sign in, create, find, delete a note) and ran
    it locally: PASS, with its video.
  - A question that only mentioned flowreel started nothing, and an
    unrelated question did not load the skill.
- **Not yet checked:** a run of the skill inside Cursor or VS Code, other
  agents that read the format (Codex, Copilot CLI and so on), and
  installing it from a marketplace. Cursor's import from GitHub needs a
  `.cursor-plugin/marketplace.json`, which this repository does not have.

### Without the plugin

From npm:

```bash
npm install --save-dev @confidee/flowreel @playwright/test tsx
npx playwright install chromium
npm run flowreel -- --local      # once the project files are wired (see "Then follow" below)
```

To try an unreleased change, install it from a clone of this repository,
as a **copy**:

```bash
# 1. Build the runtime once, in the clone.
git clone https://github.com/Confidee/flowreel.git
cd flowreel/runtime
npm ci
npm run build

# 2. In your project: keep file: installs as copies, then install.
#    (Appends the line only when it is missing, on a line of its own.)
grep -qxF 'install-links=true' .npmrc 2>/dev/null || printf '\ninstall-links=true\n' >> .npmrc
npm install --save-dev <path to the clone>/runtime @playwright/test tsx
```

Or run `npm pack` in `runtime/` after the build and install the tarball it
writes. **Do not install the folder as a plain link** (npm's default for a
path without `install-links`): the linked runtime then resolves
`@playwright/test` from the clone, not from your project, and Playwright
stops with "Requiring @playwright/test second time". The `.npmrc` line keeps
every later `npm install` a copy too, which `--install-links` on one command
does not.

Then follow
[Getting started: wire it by hand](docs/getting-started.md#8-wire-it-by-hand-no-plugin),
or start from [`examples/minimal/`](examples/minimal/), a tiny notes app
with three flows and a narrated video.

## Documentation

| Guide                                                | Read it when                                                   |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| [Getting started](docs/getting-started.md)           | you are setting flowreel up for the first time                 |
| [Concepts](docs/concepts.md)                         | you want the mental model: plans, features, policies, the gate |
| [Configuration](docs/configuration.md)               | you are editing `flowreel.config.ts` or environment variables  |
| [Writing flows](docs/writing-flows.md)               | you are writing or reviewing a flow                            |
| [Adapters](docs/adapters.md)                         | you are connecting flowreel to your app, mail, database, brand |
| [Narration and videos](docs/narration-and-videos.md) | you want to change what the videos show or say                 |
| [Pipeline and gates](docs/pipeline-and-gates.md)     | you are wiring flowreel into CI or reading exit codes          |
| [Safety](docs/safety.md)                             | you want to know what flowreel refuses to do, and why          |
| [Troubleshooting](docs/troubleshooting.md)           | a run failed and the message did not make it obvious           |
| [Claude Code plugin](docs/plugin.md)                 | you want to know exactly what the plugin runs on your machine  |
| [Installing the plugin](docs/team-install.md)        | you are installing the plugin, or enabling it for a project    |
| [Architecture](docs/design/architecture.md)          | you want the parts, the interfaces and the principles          |
| [Design decisions](docs/design/decisions.md)         | you want to know why flowreel works the way it does            |

## Packages in this repository

| Part                                                                | Path                                   | What it is                                                                                                               |
| ------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `@confidee/flowreel`                                                | [runtime/](runtime/)                   | The engine: TypeScript, ESM, Node >= 20, peer `@playwright/test` >= 1.56                                                 |
| `@confidee/flowreel/rails-inertia`, `@confidee/flowreel/mail-graph` | [runtime/](runtime/)                   | Optional stack adapters, as subpath exports: the Inertia props reader and the seam client; the Microsoft 365 mail driver |
| `flowreel` Claude Code plugin                                       | [plugin/](plugin/)                     | Skills, agents and a read-only prerequisite check around the runtime                                                     |
| `flowreel` Agent Skill                                              | [skills/flowreel/](skills/flowreel/)   | The plugin's workflows as one standard Agent Skill, for any agent that reads the format; generated from `plugin/`        |
| Example app                                                         | [examples/minimal/](examples/minimal/) | A tiny notes app with three flows and a narrated video, no Rails                                                         |
| Docs                                                                | [docs/](docs/)                         | The guides above, the architecture and the design decisions                                                              |

## Who uses it

flowreel was extracted from the release testing of
[Confidee](https://confidee.com), its first user, which plugs in through an
adapter like any other project.

## Contributing, security, conduct

- [CONTRIBUTING.md](CONTRIBUTING.md): how to build, test and propose changes.
- [SECURITY.md](SECURITY.md): how to report a vulnerability, and the
  security posture.
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md): the Contributor Covenant.
- [CHANGELOG.md](CHANGELOG.md): what changed in each version.
- [RELEASING.md](RELEASING.md): how a version is published.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
Copyright 2026 Confidee GmbH. Created and maintained by Feti Jashari.

The flowreel name and logo belong to Confidee GmbH and are not licensed
under Apache-2.0, which grants no trademark rights (its section 6). You may
use them to refer to flowreel; see [assets/brand](assets/brand/README.md).
