<!-- Generated from plugin/skills/init/SKILL.md in the flowreel repository (by its sync-agent-skill.mjs). Edit the source there, then run `npm run sync:agent-skill`. -->

# /flowreel:init

Adds flowreel to this project from the plugin's templates. Nothing is
written or installed until the user has seen the plan and said yes.

Arguments: the user's arguments (`--tour` also scaffolds the feature tour;
`--adapter` names a stack adapter to wire in).

## 1. Look first (read-only)

- Run `/flowreel:doctor`'s check if the user has not: `bash
scripts/check-prereqs.sh --report`.
- Read `package.json` (scripts, devDependencies, `"type"`), `.gitignore`,
  any `tsconfig.json`, and how the app starts in development (its dev
  script, Procfile, README).
- **ESM check.** The runtime is ESM-only. If package.json has no
  `"type": "module"` and the check reports Node below 20.19 (20.x) / 22.12
  (22.x), or 21.x, the scaffold will fail with `ERR_REQUIRE_ESM`: say so
  in the plan (step 3) and let the user choose between upgrading Node and
  adding `"type": "module"` (which changes how every `.js` file in the
  project loads). Change nothing for this without that choice. Details:
  [references/scaffold.md](references/scaffold.md), "Node.js and ESM".
- Glob for an existing setup: `flowreel.config.ts`, `e2e/flowreel/**`,
  a Playwright config. **If flowreel files already exist, stop and show
  what is there**; never overwrite a project file. Offer to add only the
  missing pieces, each as a diff.
- Find the app's sign-in page (route, form labels, sign-out request, CSRF
  cookie) and the production / staging hosts from its config, so the
  questions below come with proposed answers.

## 2. Ask (one short round)

Propose an answer for each from what you read; let the user correct:

1. Staging origin (exact `https://host`, no path) and every production
   host name (refused for every target, even if listed).
2. A free local port range for the development stage, and the command
   that starts the app in test mode on a given port.
3. Sign-in: the page path, the email / password labels, the submit button,
   the sign-out request; a test-only sign-in endpoint if the app has one
   (else the form is used locally too).
4. Personas (default `user`, `admin`) and their seeded development
   accounts. Staging personas must be dedicated QA accounts.
5. Modules: the round trip's name (default `smoke`) and whether to add the
   feature tour (`--tour`).
6. Product name and primary colour for the video cards.

## 3. Show the plan, then wait for yes

List exactly what will change (the file map is in
[references/scaffold.md](references/scaffold.md)):

- the files to create, from the templates (SKILL.md, "Templates", says where they come from);
- `package.json`: devDependencies (`@confidee/flowreel`, `tsx`, and
  `@playwright/test` if missing) and the scripts `flowreel`,
  `flowreel:demos` and `flowreel:unit`;
- any ESM finding from step 1, with the user's choice still open;
- `.gitignore`: `flowreel-results/`, `flowreel-demos/`, `.flowreel/`;
- `.npmrc`: the line `install-links=true`, only if the runtime will come
  from a local checkout (step 5), so npm copies it instead of linking it.

Ask: "Create these files and edit package.json / .gitignore?" Do nothing
until the user says yes. A no to one part skips only that part.

## 4. Scaffold

- Copy each template with Read + Write to its target path, filling in the
  answers from step 2 (the `TODO(flowreel)` markers say where). Keep every
  other line as the template has it: the safety rules in the comments are
  part of the contract.
- Without `--tour` (the default): skip every "tour only" file and write
  the four `*.no-tour.ts` variants under their base names
  (`flowreel.config.no-tour.ts` -> `flowreel.config.ts`, and
  `playwright.config`, `modules`, `pipeline` in `e2e/flowreel/`), as the
  scaffold reference's "Without the tour" says. With `--tour`: the base
  files, and never a `*.no-tour.ts` file.
- Edit `package.json` and `.gitignore` with Edit (never rewrite them).
- Never copy `templates/tsconfig.json` or `templates/README.md`: they
  belong to the plugin. Copy `rails-seam-kit.md` (to
  `e2e/flowreel/rails-seam-kit.md`) only for a Rails app.

## 5. Install (asks again)

Show the command and ask before running it. The runtime comes from npm,
or from a local clone for an unreleased change or when the registry
cannot be reached:

- first ask whether to check the registry:
  `npm view @confidee/flowreel version` sends a request to the
  project's configured npm registry, so it is a yes of its own. On a no,
  go straight to the next item. If it answers, show the version it found
  and propose `npm i -D @confidee/flowreel tsx` (plus
  `@playwright/test` if missing);
- otherwise ask where the runtime comes from (a local clone of the
  flowreel repository: `npm i -D <path to the clone>/runtime` after
  `npm run build` in its `runtime/`, or a tarball from `npm pack` there). Both `npm run build` and `npm pack`
  run in that checkout, so each needs its own yes. Never guess a registry
  or a URL.
- **A local checkout must be installed as a copy.** npm links a path by
  default, and a linked runtime stops Playwright with "Requiring
  @playwright/test second time". Before the path install, propose this
  command as its own yes (it adds the line only when it is missing and
  never prints the file):
  `grep -qxF 'install-links=true' .npmrc 2>/dev/null || printf '\ninstall-links=true\n' >> .npmrc`.
  If the user says no, do not run the path install: offer the `npm pack`
  tarball instead. A tarball install needs no `.npmrc` change.

Then, only if the doctor reported Chromium missing and only after a yes,
`npx playwright install chromium` (macOS) or `npx playwright install
--with-deps chromium` (Linux: it installs system libraries with sudo; say
so before asking).

## 6. Verify (no side effects)

- `npx playwright test --config e2e/flowreel/playwright.config.ts --list`
  loads the config and lists the flows without signing in or starting a
  server. Report its output.
- `npm run flowreel:unit`: the browser-free unit suite (narration keys
  against step titles; with the tour, CATALOGUE.md against its mirror).
- A type check only if the project already has `typescript`: its own
  typecheck script, or `npx tsc -p <its tsconfig> --noEmit` when that
  tsconfig covers `e2e/`. Never `npx tsc` without `typescript` installed
  (it downloads an unrelated `tsc` package).

## 7. Next

Tell the user what is left (every `TODO(flowreel)` you could not answer,
listed by file), then: `/flowreel:inventory <module>` to build a feature
catalogue, `/flowreel:author <module>` to write flows, and
`/flowreel:run smoke --local` for the first green run. For a Rails app,
point to `templates/rails-seam-kit.md` (copied as
`e2e/flowreel/rails-seam-kit.md`) for the test-only seams.

## Never

- Never overwrite or delete an existing file; never edit files outside
  the plan the user approved.
- Never write a real password, token or staging secret into any file
  (`env.example` only shows the shape); never read `.env*` files or
  `.npmrc` (it can hold registry tokens): the `.npmrc` command in step 5
  only appends one line.
- Never run an install, `git` command or the app's database tasks without
  a yes for that exact command.
