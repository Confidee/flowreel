<!-- Generated from plugin/skills/demos/SKILL.md in the flowreel repository (by its sync-agent-skill.mjs). Edit the source there, then run `npm run sync:agent-skill`. -->

# /flowreel:demos

Copies one run's videos into the demos folder (`latest/`, the scaffold's
`flowreel-demos/latest/`) under their fixed numbered names and rewrites
its `README.md` and `demos.json`. A development demo-pace run does this
automatically; this publishes a given run on purpose (a staging run too).

Arguments: the user's arguments (one run id, `loc-…` or `stg-…`; never a path).

## 1. Check the run first (read-only)

Read `<results>/<RUN_ID>/summary.json` (`results` in
`flowreel.config.ts`):

- `pace.pace` must be `demo`: a qa-pace run is refused by the command
  (fast and silent videos are not demos). Say so instead of running it.
- `verdict`: publishing a FAIL replaces a passing video with a failing
  one. Say so and ask before going on.
- `target` `staging`: its videos may show staging data. Say that the
  demos folder is then internal-only until reviewed, and ask.
- Which files it would publish (`video`, `tourVideo`) and what is in
  `latest/` now (`demos.json`).

## 2. Publish (after a yes)

Find the project's demos command: Grep for `demosCli(` and the
`package.json` script that runs that file (the scaffold's:
`npm run flowreel:demos -- <RUN_ID>`). Run it once. Exit codes: 0
published, 1 nothing published (its reason is printed), 64 usage.

## 3. Report

The files copied and their names in `latest/`, the README's notice line,
and an offer to open the folder (`open <dir>` on macOS). Remind the user
that demo videos may show the target's data: share them only as the
README notice says.

## Never

- Never copy, rename or delete files in `latest/` by hand; never edit
  `demos.json` or the README directly.
- Never speed up, cut or re-encode a video; never publish from a qa-pace
  run.
- Never commit the demos folder unless the user asks.
