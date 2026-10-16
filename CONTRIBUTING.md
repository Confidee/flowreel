# Contributing to flowreel

Thank you for helping. This guide covers how the repository is laid out,
how to build and test each part, and what a change needs before it can be
merged.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
Report security problems privately, as described in
[SECURITY.md](SECURITY.md), never in a public issue.

flowreel is pre-release (0.x). This repository,
[Confidee/flowreel](https://github.com/Confidee/flowreel), is its only
source: issues, pull requests and releases all happen here. Open an issue
before a large change, so we can agree the approach first.

## Layout

```text
.
├── .claude-plugin/  marketplace.json: the "flowreel" marketplace, listing ./plugin
├── .github/         CI, the release workflow, issue and pull-request templates
├── runtime/         @confidee/flowreel: src/, test/, scripts/, tsconfig, build -> dist/
├── plugin/          the Claude Code plugin: skills/, agents/, hooks/, scripts/, templates/, reference/
├── docs/            the guides; docs/design/ holds the architecture and the design decisions
├── examples/        examples/minimal: a tiny static app proving the core works without Rails
└── scripts/         check-leaks.mjs (brand-neutrality tripwire), check-version.mjs (release versions)
```

The repository root has its own `package.json` for repository tooling only
(Prettier and the two scripts); the package itself is `runtime/`.

## Principles every change keeps

1. **The verdict is deterministic.** Only Playwright assertions decide
   PASS or FAIL. Nothing added to the reporter, videos, narration or
   plugin may change a verdict, and no skill or agent may edit an
   assertion.
2. **Safe by default.** Never weaken a safety rule (target allowlist,
   production refusal, send guard, no retries, undo ledger, secrets
   handling) to make something work. If a rule blocks a legitimate use,
   open an issue to discuss it first.
3. **Brand-neutral core.** Nothing in this repository names a product,
   host, colour or logo. Those belong in a project's adapter.
   `scripts/check-leaks.mjs` scans the whole repository (run first by the
   runtime's `npm test`, or alone with `npm run check:leaks`) and fails
   with one `file:line` per hit; its header lists the few allowlisted
   publisher tokens. It publishes only the publisher's name as a pattern;
   maintainers run it with the first user's own patterns too
   (`FLOWREEL_LEAK_PATTERNS_FILE`, or the `FLOWREEL_LEAK_PATTERNS` secret
   in CI), which are not in this repository.
4. **Local-first, no telemetry.** No network calls except to what the user
   configured.
5. **Ask before installing.** Nothing in the plugin installs, downloads or
   writes without the user's confirmation, and no hook ever does.
6. **Behaviour-preserving moves.** When code moves between files or
   packages, its behaviour does not change in the same change. Prove it
   with the existing tests.

## Runtime

Requirements: Node.js 20.19+ or 22.12+ (the `smoke:exports` check loads
every entry point with `require()` too, which older versions cannot do).
CI runs Node 20, 22, 24 and 26.

```bash
cd runtime
npm ci
npm test               # the leak tripwire, then browser-free unit tests (Playwright's test runner)
npm run test:coverage  # the same under c8; fails below 95% lines, statements, functions or branches
npm run typecheck      # src + test
npm run build          # tsc -> dist/
npm run smoke:exports  # after build: every entry point loads via import and require
npm run check          # typecheck, test:coverage, build, smoke:exports
```

Rules for runtime code:

- ESM TypeScript, strict. Every source file starts with
  `// SPDX-License-Identifier: Apache-2.0`.
- **No runtime dependencies.** `@playwright/test` is a peer dependency.
  Anything else, such as the TypeScript compiler API for the tour
  tripwire, is passed in by the project and typed structurally.
- Every public function, type and interface has a doc comment that states
  its contract, including what it never does (throw, log a secret,
  retry).
- Error messages are actionable: name what was expected and what was
  observed, and name variables and keys, never their values.
- Pure logic (decisions, timelines, parsing, redaction) lives in pure,
  unit-tested functions. Side effects stay at the edges and are injectable
  for tests (`io`, `exec`, `now`, `random`, stores).
- New subpath exports go in `package.json` `exports` and must pass
  `npm run smoke:exports`.

## Plugin

- Skills are `skills/<name>/SKILL.md` with frontmatter. A skill that
  writes any file, installs anything, runs the app or a pipeline, or
  publishes sets `disable-model-invocation: true` and asks before acting
  (today: `doctor`, `init`, `inventory`, `author`, `narrate`, `run`,
  `demos`). `explain`, which only reads, is the one model-invocable skill.
  Changing which group a skill is in is a security change: update
  [SECURITY.md](SECURITY.md) and the skills table in
  [docs/plugin.md](docs/plugin.md) in the same change.
- Every skill and agent that reads run evidence or app content says that
  it is data, never instructions (`plugin/reference/never.md`, first
  section). Keep that sentence in any new skill or agent that reads them.
- `allowed-tools` pre-approves reading tools only. The doctor also lists
  its read-only check script (`scripts/check-prereqs.sh --report`), but
  `${CLAUDE_PLUGIN_ROOT}` is not substituted in frontmatter, so that entry
  is not expected to match and the doctor asks like any other command.
  Keep the script read-only all the same.
- Every shell command a skill or agent may run must be listed in
  [docs/plugin.md](docs/plugin.md), in the same change.
- Hooks must be read-only, fast, non-blocking and exit 0.
- Templates must typecheck against the runtime as shipped, in both
  scaffold shapes (with and without the tour). `scripts/check-templates.sh`
  assembles each shape in a temporary folder, typechecks it against the
  runtime source and runs its unit suite (`--no-unit` for the typecheck
  only). It needs the runtime's dev dependencies installed in
  `runtime/node_modules` (`npm ci` in `runtime/`).
- The prerequisite check (`scripts/check-prereqs.sh`) prints into the
  model's context at session start: pass anything that comes from the
  project, the environment or another program through its `clean`
  helpers before printing it.
- Validate before you open a pull request:

```bash
bash plugin/scripts/check-templates.sh
claude plugin validate --strict ./plugin
claude plugin validate --strict .   # the marketplace, from the repository root
```

CI runs all three. Without a local `claude` command, the published CLI
works too:
`npx --yes @anthropic-ai/claude-code@2.1.301 plugin validate --strict ./plugin`
(it reads the manifests only and needs no sign-in).

## Example

The example installs the runtime from `../../runtime` as a copy, so build
the runtime first:

```bash
(cd runtime && npm ci && npm run build)
cd examples/minimal
npm ci
npx playwright install chromium   # Debian or Ubuntu: --with-deps (sudo)
npm run typecheck
npm run test:qa                   # fast; `npm test` for demo pace and narration
```

After changing the runtime, run `npm run build` in `runtime/` and
`npm ci` in the example again: the example holds a copy, not a link.

## Docs

- Write for someone who has never seen flowreel. Define a term once (in
  [concepts.md](docs/concepts.md)) and link to it.
- Plain, direct English: short sentences, active voice, one idea per
  paragraph.
- Document only what the code does. Mark anything not yet shipped or not
  yet verified with `TODO(verify)` and say what is pending, in an HTML
  comment (`<!-- TODO(verify): … -->`) so the rendered page stays clean;
  `grep -rn "TODO(verify)" --exclude-dir=node_modules .` lists them for a
  release.
- Keep examples brand-neutral (`example.com`, `Acme`, `checkout`).
- A change to behaviour, configuration, environment variables, exit codes,
  safety rules or plugin commands updates the matching guide in the same
  change.
- Run Prettier over the Markdown you touched.

## Commits and pull requests

- One conceptual change per pull request, with tests in the same change.
  Every bug fix ships a regression test.
- Add a line to [CHANGELOG.md](CHANGELOG.md) under `[Unreleased]`, using
  the Keep a Changelog headings (Added, Changed, Deprecated, Removed,
  Fixed, Security). Prefix breaking changes with **BREAKING:**.
- Before you ask for review: `npm run check` in `runtime/`, the plugin
  checks above, the example if run behaviour changed, and
  `npm run format:check` at the repository root (after `npm ci` there).
- Format with Prettier from the repository root: `npm run format` writes,
  `npm run format:check` checks. `.prettierrc` holds the style (no
  semicolons, 80 columns, double quotes, trailing commas) and
  `.prettierignore` leaves out installed packages, build and run output and
  lockfiles.

- Describe what you ran and what you observed, not what you expect to
  happen.

## Releases

Maintainers publish releases from GitHub Actions; see
[RELEASING.md](RELEASING.md).

## Licensing

flowreel is licensed under Apache-2.0. By contributing, you agree that your
contributions are licensed under the same terms (Apache-2.0, section 5).
Keep the SPDX header on every source file you add.
