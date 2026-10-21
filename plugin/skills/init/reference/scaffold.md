# What /flowreel:init creates

Templates live in `${CLAUDE_PLUGIN_ROOT}/templates/` and mirror the target
layout. Both shapes of the scaffold (with and without the tour) are
typechecked and their unit suites run by `scripts/check-templates.sh`
against the runtime as shipped.

## Contents

- File map
- package.json and .gitignore
- Node.js and ESM
- Without the tour
- Checking the scaffold
- With an adapter
- Placeholders to fill

## File map

| Template                                                                     | Target                           | What                                                                           | Tour only |
| ---------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------ | --------- |
| `flowreel.config.ts`                                                         | `flowreel.config.ts`             | `defineConfig()`: targets, modules, personas, secrets file, results folder     |           |
| `e2e/flowreel/adapter.ts`                                                    | same                             | `AppAdapter` (sign-in/out, health, prepareLocal), `loadRun()`, staging secrets |           |
| `e2e/flowreel/playwright.config.ts`                                          | same                             | `createConfig()`: projects per module, the local web server                    |           |
| `e2e/flowreel/global-setup.ts`, `global-teardown.ts`                         | same                             | sign in once per persona; sign every persona out                               |           |
| `e2e/flowreel/modules.ts`                                                    | same                             | module descriptors, demo catalogue, reporter options                           |           |
| `e2e/flowreel/brand.ts`                                                      | same                             | the video kit: brand (name, colours, logos), card copy, narration folder       |           |
| `e2e/flowreel/reporter.ts`                                                   | same                             | `SummaryReporter` subclass                                                     |           |
| `e2e/flowreel/pipeline.ts`                                                   | same                             | the development -> staging pipeline command                                    |           |
| `e2e/flowreel/demos.ts`                                                      | same                             | the publish-demos command                                                      |           |
| `e2e/flowreel/fixtures.ts`                                                   | same                             | the shared `test` (signed-in page, video log), `note`, `couldNotCheck`, `text` |           |
| `e2e/flowreel/flows/smoke.spec.ts`                                           | `…/flows/<round trip>.spec.ts`   | the round trip (the release gate)                                              |           |
| `e2e/flowreel/plans/smoke.md`                                                | `…/plans/<round trip>.md`        | its plan (the step table is the source of the step ids)                        |           |
| `e2e/flowreel/texts/smoke.json`                                              | `…/texts/<round trip>.json`      | every string it types                                                          |           |
| `e2e/flowreel/narration/smoke.json`                                          | `…/narration/<round trip>.json`  | what its video says                                                            |           |
| `e2e/flowreel/env.example`                                                   | same                             | the shape of the staging secrets (never real values)                           |           |
| `e2e/flowreel/unit.config.ts`, `unit/narration-keys.ts`                      | same                             | the browser-free unit suite (`npm run flowreel:unit`) and its helper           |           |
| `e2e/flowreel/unit/narration.spec.ts`                                        | same                             | the round trip's narration keys against its step titles                        |           |
| `e2e/flowreel/unit/adapter.spec.ts`                                          | same                             | the adapter's requests are bounded and never pass a call log on                |           |
| `e2e/flowreel/unit/tour.spec.ts`                                             | same                             | CATALOGUE.md against `TOUR_CATALOGUE`; each area's narration keys              | yes       |
| `e2e/flowreel/tour.ts`                                                       | same                             | tour manifest, catalogue mirror, `feature()`, the tour's `test`, `areaText()`  | yes       |
| `e2e/flowreel/CATALOGUE.md`                                                  | same                             | the feature catalogue (owner-approved policies)                                | yes       |
| `e2e/flowreel/flows/tour/setup.spec.ts`                                      | same                             | the tour's setup project                                                       | yes       |
| `e2e/flowreel/flows/tour/a-example.spec.ts`                                  | `…/flows/tour/a-<slug>.spec.ts`  | area A, one test per feature                                                   | yes       |
| `e2e/flowreel/plans/tour-a.md`, `texts/tour-a.json`, `narration/tour-a.json` | same                             | area A's plan, texts, narration                                                | yes       |
| `rails-seam-kit.md`                                                          | `e2e/flowreel/rails-seam-kit.md` | Rails apps: the test-only seams and the protocol the seam client speaks        | Rails     |

Renaming the round trip (`smoke` -> `checkout`, say) touches: the module
name in `flowreel.config.ts`, `SMOKE` in `modules.ts` (name, project,
plan file, demo file), the `smoke` project in `playwright.config.ts`,
`projects()` and the usage in `pipeline.ts`, the texts path in
`fixtures.ts`, the card title in `brand.ts`, the module name and spec path
in `unit/narration.spec.ts`, and the four files named after it.

## package.json and .gitignore

```jsonc
"scripts": {
  "flowreel": "tsx e2e/flowreel/pipeline.ts",
  "flowreel:demos": "tsx e2e/flowreel/demos.ts",
  "flowreel:unit": "playwright test --config e2e/flowreel/unit.config.ts"
},
"devDependencies": {
  "@confidee/flowreel": "<version or file: path>",
  "@playwright/test": ">=1.56",
  "tsx": "<current>"
}
```

`.gitignore`: `flowreel-results/` (credential-bearing run evidence),
`flowreel-demos/` (published videos), `.flowreel/` (the voice clip cache).

`.npmrc` (a runtime from a local checkout only): `install-links=true`,
appended by one command when the line is missing, so npm copies the
runtime instead of linking it. The file is never read (it can hold
registry tokens). A registry or tarball install leaves `.npmrc` alone.

Commands the user then has: `npm run flowreel -- --local` (development
only), `npm run flowreel` (development, then staging on a pass),
`npm run flowreel -- --module tour --area A --pace qa --local`,
`npm run flowreel:demos -- <RUN_ID>`, `npm run flowreel:unit`.

## Node.js and ESM

The runtime is ESM-only. A project whose package.json has no
`"type": "module"` loads `flowreel.config.ts` and the e2e files as
CommonJS, and Playwright then `require()`s the runtime: that needs Node
20.19+ (20.x), 22.12+ (22.x) or 23+. On an older Node it fails with
`ERR_REQUIRE_ESM` (observed with 20.18.3 in a CommonJS project; the same
scaffold passes on 20.18.3 with `"type": "module"`, and on 20.19.5 both
ways). The doctor's check applies exactly this rule.

When the Node in use is older and the project is CommonJS, tell the user
and let them choose: upgrade Node (preferred), or add `"type": "module"`.
Adding it changes how every `.js` file in the project loads, so never add
it without that explicit choice.

## Without the tour

Init's default. Leave out every "tour only" file and copy the four
`*.no-tour.ts` variants over their base names instead of the base files:

| Variant                                     | Target                              |
| ------------------------------------------- | ----------------------------------- |
| `flowreel.config.no-tour.ts`                | `flowreel.config.ts`                |
| `e2e/flowreel/playwright.config.no-tour.ts` | `e2e/flowreel/playwright.config.ts` |
| `e2e/flowreel/modules.no-tour.ts`           | `e2e/flowreel/modules.ts`           |
| `e2e/flowreel/pipeline.no-tour.ts`          | `e2e/flowreel/pipeline.ts`          |

Never copy a `*.no-tour.ts` file under its own name, and never copy one in
a tour scaffold. The variants are the base files with the tour removed:
one module, no `TOUR` imports, `videoPace` always "round-trip", and
`--area` / `--pace` refused with "This project has no feature tour".

## Checking the scaffold

- Always: `npx playwright test --config e2e/flowreel/playwright.config.ts
--list` (loads the config, signs nothing in, starts no server) and
  `npm run flowreel:unit` (browser-free).
- A type check only when the project already has `typescript` in its
  dependencies: its own typecheck script, or `npx tsc -p <its tsconfig>
--noEmit` when that tsconfig includes `e2e/`. Without `typescript`
  installed, never run `npx tsc`: it would download an unrelated package
  named `tsc`. Playwright and tsx strip types without checking them.

## With an adapter

- `rails-inertia`: the Rails seam kit (`rails-seam-kit.md`, and the kit
  itself in `templates/rails/`) and the subpath's props reader and seam
  client (`InertiaPropsReader`, `seamSignIn`, `HttpSeamMailDriver`) in
  `adapter.ts`.
- `mail-graph`: the Microsoft Graph mail driver (`GraphMailDriver`) for
  staging mail checks. The secrets it needs go into `env.example` as
  shapes only.

## Placeholders to fill

Every `TODO(flowreel)` marker: the staging origin and production hosts,
the local port range and dev-server command, the sign-in page, labels and
sign-out request, the seeded development accounts, `prepareLocal()`, the
brand name and colour, the demo descriptions, and the smoke flow's steps.
