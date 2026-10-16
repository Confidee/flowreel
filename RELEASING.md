# Releasing flowreel

How a version of `@confidee/flowreel` and the `flowreel` plugin is
published, and the one-time setup the repository and npm need before the
first release. Maintainers only.

- [How a release works](#how-a-release-works)
- [Cutting a release](#cutting-a-release)
- [Before the first release](#before-the-first-release)
- [Open documentation checks](#open-documentation-checks)

## How a release works

- **One version everywhere.** `runtime/package.json`,
  `plugin/.claude-plugin/plugin.json`, the `flowreel` entry in
  `.claude-plugin/marketplace.json`, `examples/minimal/package.json` (and
  its lockfile's copy of the runtime) carry the same version, and
  `CHANGELOG.md` has a `## [<version>] - <YYYY-MM-DD>` section for it.
  `runtime/test/release.spec.ts` checks this on every test run, and
  `npm run check:version -- v<version>` (at the repository root) checks it
  against a tag.
- **A tag publishes.** Pushing a tag `v<version>` runs
  [.github/workflows/release.yml](.github/workflows/release.yml) in two
  jobs. `build` (no OIDC token) refuses a tag whose commit is not on
  `main`, checks the tag against every version, installs the runtime's dev
  dependencies with `npm ci --ignore-scripts`, runs the typecheck, tests,
  build and export smoke test, and packs the tarball, recording its
  SHA-256. `publish` checks out nothing and installs no dependencies: it
  downloads that tarball, checks its SHA-256 and runs
  `npm publish <tarball> --provenance --access public`.
- **No npm token.** Only the `publish` job can request an OIDC token
  (`permissions: id-token: write`); it authenticates with npm trusted
  publishing on Node 24, with its bundled npm when that is 11.5.1 or later
  and otherwise a pinned npm 11.21.1. No `NPM_TOKEN` secret exists. npm
  records the workflow, not a person, as the publisher, and publishes a
  provenance attestation that links the version to this repository, the
  workflow run and the commit.
- **A second person approves.** The publish job runs in the `npm` GitHub
  environment. With required reviewers on that environment, the run waits
  after the build job, until another maintainer approves it; the run's
  summary shows the tarball's SHA-256.
- **The plugin ships with the repository.** Plugin users get the new
  version with `/plugin marketplace update flowreel`; nothing is uploaded
  for the plugin.

## Cutting a release

1. On a branch, set the new version (semver; 0.x while pre-release: a
   minor bump for new features or breaking changes, a patch bump for
   fixes):

   ```bash
   (cd runtime && npm version <version> --no-git-tag-version)
   # then edit the version in plugin/.claude-plugin/plugin.json,
   # .claude-plugin/marketplace.json and examples/minimal/package.json
   (cd runtime && npm ci && npm run build)
   (cd examples/minimal && npm install)   # refreshes the lockfile's runtime copy
   ```

2. In `CHANGELOG.md`, rename `## [Unreleased]` to
   `## [<version>] - <today>` and add a new empty `## [Unreleased]` above
   it.
3. Run the checks locally and say what you observed in the pull request:

   ```bash
   (cd runtime && npm run check)
   bash plugin/scripts/check-templates.sh
   (cd examples/minimal && npm run typecheck && npm run test:qa)
   npm run format:check && npm run check:version -- v<version>
   ```

4. Open the pull request; merge it when CI is green and it is reviewed.
5. Tag the merge commit on `main` and push the tag:

   ```bash
   git switch main && git pull --ff-only
   git tag -a v<version> -m "flowreel <version>"
   git push origin v<version>
   ```

6. Approve the `Release` run in the Actions tab (the `npm` environment).
7. Check the result:

   ```bash
   npm view @confidee/flowreel@<version> version dist.attestations
   ```

   The package page on npmjs.com shows a "Provenance" section that names
   this repository and the workflow run.

8. Create a GitHub release for the tag with the changelog section as its
   notes.

If the release workflow fails before `npm publish`, fix the problem on
`main`, delete the tag (`git push origin :refs/tags/v<version>` and
`git tag -d v<version>`) and tag again. Once a version is on npm it cannot
be published again: fix forward with the next patch version.

## Before the first release

These steps need the owner, or the GitHub and npm web interfaces. None of
them can be done from this repository's files.

### Version

- The first public version is **0.2.0**. 0.1.0 was an internal release
  that was never published to npm; skipping it keeps an internal install
  and the public package from sharing a version number. The changelog
  keeps the 0.1.0 section as history. If the release slips past the date
  in the `## [0.2.0]` heading, update the date before tagging.

### GitHub repository settings

1. Create the public repository **Confidee/flowreel** (empty: no README,
   license or `.gitignore`), then push `main` from this clone. Under
   Settings -> General -> **Social preview**, upload
   `assets/brand/flowreel-social-preview-1280x640.png`.
2. **Private vulnerability reporting:** Settings -> Advanced Security (or
   "Code security") -> enable **Private vulnerability reporting**.
   SECURITY.md and the issue chooser link to it.
3. **Discussions:** enable them (Settings -> General -> Features) and keep
   three categories: **Announcements** (maintainers post, releases), **Q&A**
   (answers can be marked) and **Ideas**; delete the others. The issue
   chooser's "Questions and ideas" link points there, so issues stay for
   reproducible bugs and concrete feature requests.
4. **Dependabot:** enable Dependabot alerts and security updates. Version
   updates are configured in `.github/dependabot.yml`.
5. **Branch protection for `main`** (a ruleset): require a pull request
   with at least one approval, require the CI checks to pass
   (`Runtime, templates and example (Node 20)`, `(Node 22)`, `(Node 24)`,
   `(Node 26)`, `Formatting`, `Plugin and marketplace validation`; they
   appear for selection after the first CI run), block force pushes and
   deletion.
6. **Tag protection:** a tag ruleset for `v*` so only maintainers can
   create, update or delete release tags. (The release workflow also
   refuses a tag whose commit is not on `main`.)
7. **The `npm` environment:** Settings -> Environments -> New environment
   `npm`. Add **required reviewers** (a second maintainer), allow
   deployments from tags matching `v*` only, and do not add any secrets.
8. **Actions:** Settings -> Actions -> General: keep the default
   `GITHUB_TOKEN` permission read-only; require approval for workflows from
   first-time contributors.
9. Confirm that the contact address in SECURITY.md is monitored for flowreel
   security and conduct reports, and that the response targets in
   SECURITY.md (acknowledge within 3 business days, assess within 10, fix
   within 90 days) and CODE_OF_CONDUCT.md are ones the team can keep.
10. Add a second maintainer as a repository admin, so the project does not
    depend on one account.
11. **The leak tripwire's project patterns:** add a repository secret
    `FLOWREEL_LEAK_PATTERNS` holding the first user's patterns as a JSON
    array (see the header of `scripts/check-leaks.mjs`). CI and the
    release build pass it to the tripwire; it is not passed to workflows
    from forks, which check the publisher's name only. A hit is reported
    by pattern number only.

### npm: the organization, the first publish and the trusted publisher

An npm organization owns the scope of `@confidee/flowreel`. Keep
two-factor authentication on for every owner, and keep at least two
owners who are different people.

**What we know** (npm documentation, read 2026-10-16):

- Trusted publishing needs npm CLI 11.5.1 or later and Node 22.14.0 or
  later. The release workflow's publish job uses Node 24 and checks its
  npm version (installing npm 11.21.1 only when the bundled one is older).
- A trusted publisher is configured per package (npmjs.com -> the package
  -> Settings -> Trusted publishing, or `npm trust github` from npm
  11.15.0). For GitHub Actions it takes the owner and repository
  (`Confidee/flowreel`), the workflow **file name** (`release.yml`, not a
  path) and, optionally, the environment (`npm`). If any of these does not
  match the run exactly, the publish fails, often with a misleading
  `E404 Not Found`.
- `npm trust` documents that **the package must already exist on the
  registry**. The website's instructions also start from the package's
  settings page.
- A newly created trusted-publisher configuration must complete its first
  successful publish **within 2 days**, or it expires and must be deleted
  and created again.
- Configurations created after 2026-09-03 automatically allow
  `npm stage publish` (a staged publish a maintainer then approves). The
  release workflow runs `npm publish`, so the configuration must also allow
  **publish** (`--allow-publish` with `npm trust`, or the matching option
  on the website). Switching the workflow to `npm stage publish` instead is
  a valid choice if every release should also be approved on npm.
- Provenance is generated automatically for a public package published
  from a public GitHub repository, and `repository.url` in
  `runtime/package.json` must match the repository exactly (it does:
  `git+https://github.com/Confidee/flowreel.git`; a test keeps it so).
- After trusted publishing works, npm recommends Settings -> Publishing
  access -> **"Require two-factor authentication and disallow tokens"**.
  Trusted publishing keeps working.

**What we do not know:** whether npmjs.com lets you create a trusted
publisher for a package name that has never been published (the
documentation does not say; the CLI says no), and exactly which account
details npm shows on a manually published version. Our understanding is
that a version published from a personal login records that npm account
(name and, in the registry metadata, its email) as the publisher; verify
with `npm view @confidee/flowreel@<version> _npmUser` after the first
publish.

**So the first publish most likely needs one manual step.** Two ways:

- **A. Placeholder first (recommended).** An org owner publishes a minimal
  placeholder from their machine, then configures the trusted publisher,
  and the first real version goes through the workflow with provenance:
  1. In an empty folder, a `package.json` with `"name": "@confidee/flowreel"`,
     `"version": "0.0.1"`, `"license": "Apache-2.0"`, the same
     `repository` as `runtime/package.json`, and a README saying it is a
     placeholder and to use the next version. Then
     `npm publish --access public` (asks for the 2FA code).
  2. Within the next 2 days: configure the trusted publisher
     (`Confidee/flowreel` / `release.yml` / environment `npm`, allow
     publish), then cut the first real release with the steps above.
  3. `npm deprecate @confidee/flowreel@0.0.1 "Placeholder; use 0.2.0 or later."`
  4. Turn on "Require two-factor authentication and disallow tokens".

  Only the placeholder carries a personal publisher record, and every real
  version has provenance.

- **B. Real version first.** An org owner builds the release locally from
  the tagged commit and runs `npm publish --access public` in `runtime/`
  (without `--provenance`: a local machine cannot produce it). Then configure the trusted publisher; every later version
  goes through the workflow. The first real version then has no provenance
  and a personal publisher record.

If npm's website does accept a trusted publisher for a not-yet-published
name when you try it, skip the manual step entirely: configure it, then
tag.

### Claude Code

- CI validates the plugin and the marketplace with
  `npx --yes @anthropic-ai/claude-code@2.1.301 plugin validate --strict`.
  The version is pinned in `.github/workflows/ci.yml`; Dependabot does not
  update it, so bump it by hand now and then.
- Optional, later: submit the plugin to Anthropic's plugin directory.

## Open documentation checks

These are marked `TODO(verify)` in the docs. None blocks a release; each
needs a real environment to close:

- `docs/team-install.md`: a sparse install from GitHub
  (`--sparse .claude-plugin plugin`) once the repository is public.
- `docs/pipeline-and-gates.md`: run the GitHub Actions examples in a real
  workflow.
- `docs/adapters.md`: replay the Microsoft 365 RBAC for Applications steps
  in a test tenant.
- `docs/getting-started.md`: add the tour to an existing round-trip
  scaffold with `/flowreel:init --tour`, and document the diffs.
- Design decision 12: observe in a live session whether the doctor prompts
  for its check script.

List them with `grep -rn "TODO(verify)" --exclude-dir=node_modules .`.
