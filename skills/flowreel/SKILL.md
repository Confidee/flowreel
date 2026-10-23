---
name: flowreel
description: Turn plain-English feature plans into deterministic Playwright end-to-end flows that double as narrated, branded demo videos, gated development then staging. Use to set flowreel up in a web app, check its prerequisites, catalogue a module's features, write flows and their narration, run the release gate locally or on staging, explain a failed run, or publish demo videos. Also use when the user mentions flowreel, @confidee/flowreel, flowreel.config.ts or e2e/flowreel/.
license: Apache-2.0
compatibility: Needs an agent that can read and write files and run shell commands; Node.js 20.19+ or 22.12+, @playwright/test 1.56+ with Chromium, and ffmpeg for videos. Installing the runtime and fetching the project templates needs network access to npm and GitHub.
metadata:
  author: Feti Jashari
  homepage: https://github.com/Confidee/flowreel
---

# flowreel

flowreel runs a web app's features as Playwright flows from plain-English
plans. One run gives a QA verdict, evidence and a narrated, branded video,
first on a disposable development copy and then, only if that passed, on
staging. The runtime is the npm package `@confidee/flowreel`; this skill is
how an agent sets it up and drives it.

Every path below is relative to this skill's folder.

## Ground rules

Read [references/never.md](references/never.md) before any workflow. In
short:

- Change nothing (no file, install, `git` command or database task) until
  the user has seen the plan and said yes to that exact step.
- Never weaken, skip or delete an assertion, a plan's expectation or an
  undo restore to make a run pass. Never call a FAIL or N/A a pass, and
  never decide the verdict: the runtime does.
- Never retry a send, a sign-in or a run on your own. Never point a run at
  a production host.
- Never read `.env*` files, the project's secrets file or `.npmrc`, and
  never write a real password, token or secret into any file.

## Pick the workflow

| The user wants to                   | Follow                                             | With                                                                                                 |
| ----------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| check the machine's prerequisites   | [references/doctor.md](references/doctor.md)       | [references/prerequisites.md](references/prerequisites.md), `bash scripts/check-prereqs.sh --report` |
| add flowreel to a project           | [references/init.md](references/init.md)           | [references/scaffold.md](references/scaffold.md), "Templates" below                                  |
| list a module's features for a tour | [references/inventory.md](references/inventory.md) | [references/catalogue-format.md](references/catalogue-format.md)                                     |
| write the flows for a module        | [references/author.md](references/author.md)       | [references/flow-api.md](references/flow-api.md)                                                     |
| write a module's narration          | [references/narrate.md](references/narrate.md)     | [references/narration-rules.md](references/narration-rules.md)                                       |
| run a module (development, staging) | [references/run.md](references/run.md)             | [references/results.md](references/results.md)                                                       |
| understand a finished run           | [references/explain.md](references/explain.md)     | [references/results.md](references/results.md)                                                       |
| publish a demo-pace run's videos    | [references/demos.md](references/demos.md)         |                                                                                                      |

The usual order for a new project: doctor, init, a first local run of the
round trip (`smoke`), then inventory, author, narrate and run for each
module.

## Reading the workflow files

The workflow files are generated from the flowreel Claude Code plugin and
keep its wording. Outside Claude Code, read them this way:

- `/flowreel:<name>` is the workflow in `references/<name>.md`. The user
  asks for it in words; there is no slash command to run.
- "the user's arguments" are what the user asked for: a module name, a run
  id, flags such as `--local` or `--pace demo`.
- A named plugin agent (`flow-author`, `run-explainer`, `catalogue-scout`)
  is work you do yourself, following `references/agent-<name>.md`.
- Read, Write, Edit, Glob, Grep and Bash are your own file, search and
  shell tools. An `allowed-tools` line in a workflow is the plugin's
  permission list, not yours: ask as your agent normally would.
- "Ask" and "wait for yes" mean stop and get an explicit yes in the chat.

## Templates

`init` copies the project templates, which are not part of this skill.
Use the templates of the runtime version the project installs, so the
scaffold and the runtime always match:

1. The version: `@confidee/flowreel`'s `version` in
   `node_modules/@confidee/flowreel/package.json` once it is installed,
   else the version the approved plan installs (`npm view
@confidee/flowreel version` asks the registry: a yes of its own).
2. With a yes (it downloads the repository), fetch that release's tag
   into a new temporary folder:
   `git clone --depth 1 --branch v<version> https://github.com/Confidee/flowreel.git <temporary folder>`.
   The templates are in `<temporary folder>/plugin/templates/`; the file
   map and which files to skip are in
   [references/scaffold.md](references/scaffold.md).
3. Copy them as `references/init.md` says (read, fill in the
   `TODO(flowreel)` answers, write). Run nothing from the clone, and
   delete the temporary folder afterwards.

## Checking prerequisites

From the project's folder, run
`bash <this skill's folder>/scripts/check-prereqs.sh --report`. It checks
Node.js, `@playwright/test`, Chromium, ffmpeg, a macOS Premium voice and
`psql` for that project (or for `$CLAUDE_PROJECT_DIR` when it is set).
It only reads, never installs and always exits 0. Its install commands
are proposals: show each one and run it only after a yes.
