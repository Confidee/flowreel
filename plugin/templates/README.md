# flowreel templates

What `/flowreel:init` copies into a project. The folder mirrors the
target layout (`flowreel.config.ts` at the project root, the rest under
`e2e/flowreel/`); `skills/init/reference/scaffold.md` maps every file.
Two shapes: with the feature tour (the base files) and without it (the
tour-only files left out, each `*.no-tour.ts` variant written under its
base name).

- Every `TODO(flowreel)` marks a value the project fills in (hosts, ports,
  the sign-in page, seeded accounts, brand).
- The templates contain no secrets: `e2e/flowreel/env.example` shows only
  the shape of the staging settings.
- They are the project's own code once copied: no license header, change
  them freely, but keep the safety rules their comments describe.

`tsconfig.json` here belongs to the plugin, not to a project: it lets an
editor and ESLint typecheck the files in place against the runtime source
(the `*.no-tour.ts` variants then resolve against the tour shape's files).
`/flowreel:init` never copies it or this README. The check that counts is
`bash plugin/scripts/check-templates.sh` (from the repository root): it assembles
both shapes exactly as init writes them, typechecks each and runs each
one's unit suite.
