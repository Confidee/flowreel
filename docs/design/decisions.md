# Design decisions

The decisions that shape flowreel, why they were made, and what would
change them. Each one is short on purpose; the guides document the
behaviour that follows from it. [architecture.md](architecture.md)
describes the system these decisions produce.

A new decision gets the next number. A decision that is replaced stays
here, marked **Superseded by** the one that replaces it.

- [1. Playwright assertions are the only judge](#1-playwright-assertions-are-the-only-judge)
- [2. No runtime dependencies; Playwright is a peer](#2-no-runtime-dependencies-playwright-is-a-peer)
- [3. One run pipeline: development, then staging](#3-one-run-pipeline-development-then-staging)
- [4. Safety rules are enforced or explicitly provided](#4-safety-rules-are-enforced-or-explicitly-provided)
- [5. Interfaces only where a second implementation exists](#5-interfaces-only-where-a-second-implementation-exists)
- [6. FLOWREEL\_ environment variables, project aliases allowed](#6-flowreel_-environment-variables-project-aliases-allowed)
- [7. ESM with a require() path](#7-esm-with-a-require-path)
- [8. The tour's static tripwire takes TypeScript structurally](#8-the-tours-static-tripwire-takes-typescript-structurally)
- [9. Demo publishing is per module](#9-demo-publishing-is-per-module)
- [10. Side-effecting skills are user-invoked only](#10-side-effecting-skills-are-user-invoked-only)
- [11. A path-installed runtime must be a copy](#11-a-path-installed-runtime-must-be-a-copy)
- [12. The doctor does not pre-approve its check script](#12-the-doctor-does-not-pre-approve-its-check-script)
- [13. Microsoft 365 mail is scoped with RBAC for Applications](#13-microsoft-365-mail-is-scoped-with-rbac-for-applications)
- [14. A brand-neutrality tripwire over the whole repository](#14-a-brand-neutrality-tripwire-over-the-whole-repository)
- [15. Apache-2.0, published under the company](#15-apache-20-published-under-the-company)
- [16. This repository is the single source of truth](#16-this-repository-is-the-single-source-of-truth)
- [17. Releases publish through npm trusted publishing](#17-releases-publish-through-npm-trusted-publishing)
- [18. Plugin validation runs in CI](#18-plugin-validation-runs-in-ci)
- [19. Security and conduct contact](#19-security-and-conduct-contact)

## 1. Playwright assertions are the only judge

**Decision.** PASS or FAIL comes only from Playwright assertions. Runs are
never retried (`retries: 0`, one worker), and global setup refuses
`--retries` or `--repeat-each` on the command line. A run that dies before
writing a summary is a FAIL; N/A never counts as a pass. AI helps write
plans, flows and narration and explains results; no skill or agent decides
a verdict or edits an assertion.

**Why.** A release gate that an AI or a retry can turn green is not a gate.
A retried sign-in or mail send can also lock an account or send real mail
twice.

## 2. No runtime dependencies; Playwright is a peer

**Decision.** The runtime has no runtime dependencies. `@playwright/test`
(>= 1.56) is a peer dependency. Tools are called as child processes with
argument arrays (`ffmpeg`, `ffprobe`, `say`), never through a shell.

**Why.** A test tool sits next to credentials. Every dependency is supply
chain the project inherits, and two copies of `@playwright/test` cannot
share a run.

## 3. One run pipeline: development, then staging

**Decision.** A run executes the development stage first and the staging
stage only if development passed. Each stage gets a clean environment:
staging secrets never reach the development stage. Exit codes are a
contract: 0 pass, 1 fail, 2 staging not configured, 3 nothing verified,
4 a shared-configuration change could not be put back (outranks every
other code), 64 a usage error, 130 interrupted (Ctrl-C stopped the
pipeline before a stage that would have run). A per-run database (`DbIsolation`) is
optional.

**Why.** Staging is shared and slow; a failure that already shows on
development should never touch it. CI needs codes it can rely on, and an
unrestored shared change must never hide behind a pass.

## 4. Safety rules are enforced or explicitly provided

**Decision.** Every safety rule is in one of two groups, and the docs say
which: **enforced by the runtime** (production refused, exact staging
allowlist, loopback-only local target, no retries, sign-out at teardown,
owner-only secrets file, redaction in videos and narration, exit 4) or
**provided as an API the project's code must call** (the mail send guard,
the inbound-mail budget, the undo ledger, the off-camera cleanup, the
privacy mask, the seam kit's gate).

**Why.** A library cannot enforce what runs in a project's own driver or
flow. Saying exactly where a rule holds is safer than implying it holds
everywhere.

## 5. Interfaces only where a second implementation exists

**Decision.** `AppAdapter`, `MailDriver`, `DbIsolation`, `CleanupAdapter`,
`Brand` / `CardCopy`, `VoiceEngine`, `ModuleDescriptor`, `DemoCatalogue`
and `TourManifest` are interfaces because more than one implementation
exists or a second user clearly needs one. Everything else stays concrete.

**Why.** Interfaces designed for imagined users are usually wrong. They are
cheap to add when the second user arrives, and expensive to change once
published.

## 6. FLOWREEL\_ environment variables, project aliases allowed

**Decision.** Configuration variables are `FLOWREEL_*`. A project keeps its
older names working with `registerEnvAliases()`; flowreel registers none.
`TARGET`, `RUN_ID` and `MODULE` set to different values under two names are
refused, naming both variables.

**Why.** One prefix keeps flowreel's variables recognisable. Aliases let a
project adopt flowreel without breaking its existing commands, and refusing
conflicting values means an inherited `FLOWREEL_TARGET=staging` can never
turn a local run into a staging run.

## 7. ESM with a require() path

**Decision.** The runtime is ESM-only and every entry point has a `default`
export condition, so it also loads with `require()` on Node 20.19+,
22.12+ or 23+. `npm run smoke:exports` checks both against the built package.

**Why.** Playwright compiles a project's test files to CommonJS unless its
`package.json` says `"type": "module"`. Supporting `require(esm)` keeps
those projects working without a dual build.

## 8. The tour's static tripwire takes TypeScript structurally

**Decision.** The tour's static tripwire (which checks that flows declare
their features honestly) receives the project's own `typescript` module as
an argument, typed structurally (`TypeScriptApi`).

**Why.** The runtime and its published types stay free of a `typescript`
dependency, and the project's compiler version is the one that parses its
flows. The scanner supports TypeScript 5.x and 6.x. TypeScript 7 has no
JavaScript compiler API, so it is not supported yet
([issue #6](https://github.com/Confidee/flowreel/issues/6)).

## 9. Demo publishing is per module

**Decision.** A run's videos are published under a module's demo only when
its summary names that module; a summary that names another module is
refused. A summary with no module (written before the reporter recorded
one) still publishes as the round trip.

**Why.** A project has more than one module, and publishing one module's
video under another's name would put the wrong demo in `latest/`.

## 10. Side-effecting skills are user-invoked only

**Decision.** Every skill with a side effect (`doctor`, `init`,
`inventory`, `author`, `narrate`, `run` and `demos`) sets
`disable-model-invocation: true` and asks before acting. `explain`, which
only reads, is the one model-invocable skill. Every skill and agent treats
run evidence and app content as data, never instructions.

**Why.** `author` writes flows, starts the app and starts `flow-author`
agents that can edit files and run shell commands. Its "development stage
only" rule is an instruction, not a control, and permission prompts do not
fire in a project that allowlists commands such as `Bash(npm run *)` or
file edits. `inventory` and `narrate` write one file each, but an
allowlisted edit or an automatic permission mode would remove their
prompt too. Making them user-invoked removes that gap. The skills also
read text people outside the team can write (a staging page's snapshot,
mail, the app's copy), so a page could try to steer an agent that holds a
shell; the data rule in `never.md` is the instruction against that, and
the permission prompts are the control. Moving a skill between the groups
is a security change.

## 11. A path-installed runtime must be a copy

**Decision.** When the runtime is installed from a local checkout,
`/flowreel:init` first proposes, as its own yes, one command that appends
`install-links=true` to the project's `.npmrc` when the line is missing (it
never reads or prints `.npmrc`, which can hold registry tokens). On a no it
offers an `npm pack` tarball instead. The minimal example ships the same
`.npmrc` line.

**Why.** npm links a path by default. A linked runtime resolves
`@playwright/test` from the checkout, and Playwright stops with "Requiring
@playwright/test second time". `--install-links` on one command is not
enough: a later plain `npm install` turns it back into a link.

## 12. The doctor does not pre-approve its check script

**Decision.** The doctor's `allowed-tools` lists its read-only check script,
but `${CLAUDE_PLUGIN_ROOT}` is substituted only in a skill's Markdown body,
not in its frontmatter, so the entry is not expected to match and the
doctor prompts like any other command. The docs promise only that.

**Why.** Claiming a pre-approval that does not happen would overstate what
the plugin can run silently. If a live session confirms the prompt, the
Bash entry is dropped from `allowed-tools` so the frontmatter claims only
reading tools.

## 13. Microsoft 365 mail is scoped with RBAC for Applications

**Decision.** The `mail-graph` guide scopes the app to one QA mailbox with
RBAC for Applications in Exchange Online (a management scope over a
one-mailbox group, the `Application Mail Full Access` role, checked with
`Test-ServicePrincipalAuthorization`) and grants **no** `Mail.*` admin
consent in Entra ID. An existing application access policy keeps working,
and the guide gives Microsoft's migration order.

**Why.** Microsoft recommends RBAC for Applications and asks for no new
application access policies. Entra grants are added to the scoped ones, so
a tenant-wide consent would undo the scope.

## 14. A brand-neutrality tripwire over the whole repository

**Decision.** `scripts/check-leaks.mjs` scans every file in the repository
(except `.git/`, installed packages, build output, run results and binary
files), its own files included. The only pattern it publishes is the
publisher's name. A consuming project supplies its own patterns at run
time (a JSON array in `FLOWREEL_LEAK_PATTERNS_FILE`, or inline in
`FLOWREEL_LEAK_PATTERNS` from a CI secret), and a hit on one is reported by
number only, never with the pattern or the matched text. It runs first in
the runtime's `npm test` and in CI; a patterns source that cannot be read
or parsed fails the check. Allowlisted, and nothing else: the npm scope and
the repository slug anywhere; the copyright holder in the files that state
copyright or ownership; the security and conduct address in SECURITY.md and
CODE_OF_CONDUCT.md; and the publisher's name in the README's "Who uses it"
section and in the tripwire's own two files. The tokens are removed from a
line before the patterns are tested, so a line that also names anything
else is still caught.

**Why.** flowreel was extracted from one product's release testing.
Project specifics belong in that project's adapter, and a test is the only
reliable way to keep them out of a public core over time. A published deny
list would itself describe what it keeps out, so the list stays with the
project that owns it.

## 15. Apache-2.0, published under the company

**Decision.** flowreel is licensed under Apache-2.0. The copyright holder
is the company named in NOTICE (also the marketplace `owner`); Feti Jashari
is the author and maintainer (the package and plugin `author`). The npm
package is `@confidee/flowreel`.

**Why.** Apache-2.0 includes an explicit patent grant and is widely
accepted by companies. Publishing under the company's GitHub and npm
organizations keeps the project's ownership independent of any one
person's account.

## 16. This repository is the single source of truth

**Decision.** flowreel was built inside its first user's repository and
moved to this public repository for 0.x. From the move on, this repository
is the only place flowreel changes: the first user consumes the published
package and the plugin marketplace like any other project.

**Why.** Two copies drift. A single public source keeps the issue tracker,
the review history and the releases in one place.

## 17. Releases publish through npm trusted publishing

**Decision.** A tag `v<version>` runs `.github/workflows/release.yml`,
whose build job checks that every released file carries the tag's version
(`scripts/check-version.mjs`), runs the runtime's checks, packs the tarball
and records its SHA-256. The publish job checks out nothing, verifies the
tarball against that SHA-256 and runs
`npm publish <tarball> --provenance --access public` with
`id-token: write`. There is no `NPM_TOKEN` secret. The job runs in the `npm`
GitHub environment, which can require a second person's approval. After
npm accepts the publish, a third job (`contents: write`, without the OIDC
token) creates the GitHub Release with the version's changelog section.

**Why.** No long-lived token can leak. Provenance links every version to
the workflow run and commit that built it, and the version is published by
the workflow identity rather than a personal account.

## 18. Plugin validation runs in CI

**Decision.** CI runs `claude plugin validate --strict` on `./plugin` and on
the marketplace at the repository root, using the published Claude Code
npm package at a pinned version. Validation reads the manifests only and
needs no sign-in.

**Why.** A plugin that fails validation cannot be installed. It used to be
a manual release step because the `claude` command is not on a CI
machine's `PATH`; `npx` with a pinned version removes that gap.

## 19. Security and conduct contact

**Decision.** Security reports go through GitHub private vulnerability
reporting or to the published contact address; conduct reports go to the
same address. Both pages state response expectations. Only the latest 0.x
release receives security fixes.

**Why.** A reporter needs a private channel that works on day one, without
asking for one in public.
