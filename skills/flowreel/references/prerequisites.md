<!-- Generated from plugin/skills/doctor/reference/prerequisites.md in the flowreel repository (by its sync-agent-skill.mjs). Edit the source there, then run `npm run sync:agent-skill`. -->

# flowreel prerequisites

What `/flowreel:doctor` checks, why flowreel needs it, and how to install
it. Required items block runs; "for videos" (`video-only`) and "for voice"
(`voice-only`) items only affect the MP4s and their narration (the verdict
never depends on them).

| Tool                                                            | Why                                        | Required?         | macOS                                              | Linux                                                     |
| --------------------------------------------------------------- | ------------------------------------------ | ----------------- | -------------------------------------------------- | --------------------------------------------------------- |
| Node.js 20.19+ / 22.12+ / 23+ (any 20+ in an ESM project)       | the runtime and its commands               | yes               | `brew install node`                                | distribution package or nvm                               |
| `@playwright/test` >= 1.56 (in the project)                     | runs and records the flows                 | yes               | `npm i -D @playwright/test`                        | same                                                      |
| Playwright Chromium                                             | the browser that is recorded               | yes               | `npx playwright install chromium`                  | `npx playwright install --with-deps chromium` (uses sudo) |
| ffmpeg + ffprobe with `libx264` and `aac`                       | composes MP4s, mixes audio, measures clips | for videos        | `brew install ffmpeg`                              | `sudo apt install ffmpeg`                                 |
| macOS `say` + a Premium voice (e.g. "Ava (Premium)")            | narration                                  | for voice (macOS) | System Settings (below)                            | not available yet: videos are silent                      |
| `psql`                                                          | a Postgres per-run database copy           | optional          | `brew install libpq && brew link --force libpq`    | `sudo apt install postgresql-client`                      |
| A Microsoft Graph app (Mail.ReadWrite + Mail.Send, one mailbox) | real mail checks on staging (`mail-graph`) | optional          | tenant admin steps in the mail-graph adapter guide | same                                                      |

## Notes per item

- **Node.js.** The runtime is ESM-only. In a project without
  `"type": "module"` Playwright loads the config and flows as CommonJS and
  `require()`s the runtime, which needs Node 20.19+ (20.x), 22.12+ (22.x)
  or 23+; 21.x never can. Older versions fail with `ERR_REQUIRE_ESM`
  (observed: 20.18.3 fails in a CommonJS project and passes in an ESM one;
  20.19.5 passes both). An ESM project runs on any 20+. A version manager
  (nvm, fnm, volta, mise, asdf) is fine; with a shim-based one the check
  reports Node as `unchecked` (see "Version managers" below). Distribution
  packages are often older than 20.19, so on Linux the check prints
  `Steps:` (no single command) instead of `Install:`; check
  `node --version` after installing.
- **@playwright/test.** flowreel declares it as a peer dependency; the
  project owns its version. An installed version older than 1.56 gets
  `npm i -D @playwright/test@latest`. After upgrading it, install the matching
  Chromium again (`npx playwright install chromium`): each Playwright
  version pins its own browser build.
- **Chromium cache.** Playwright keeps browsers in
  `~/Library/Caches/ms-playwright` (macOS), `~/.cache/ms-playwright`
  (Linux) or `$PLAYWRIGHT_BROWSERS_PATH`. With `PLAYWRIGHT_BROWSERS_PATH=0`
  they live in the project's `node_modules/playwright-core/.local-browsers`
  (older layouts: `node_modules/playwright/.local-browsers`), and the check
  looks there. The check only looks for a
  `chromium-*` folder there; a version mismatch shows up as Playwright's
  own "Executable doesn't exist" error at run time.
- **ffmpeg.** Homebrew's and most distributions' builds include `libx264`
  and `aac`. A minimal build without them makes runs report
  `video: not produced (<reason>)`.
- **Premium voice (macOS).** System Settings > Accessibility > Read & Speak
  (older macOS: Spoken Content) > System voice > Manage Voices… > English >
  download "Ava (Premium)" (or "Zoe (Premium)", "Jamie (Premium)"). Then
  `say -v '?' | grep Premium` lists it. `FLOWREEL_VOICE` picks an exact
  voice; without a Premium voice the run warns "using fallback voice" and
  narrates with a standard one.
- **Linux / CI voice.** Piper and Azure Speech engines are designed for but
  not built yet; set `FLOWREEL_VOICE_ENGINE=none` for silent videos.
- **psql.** Only when the project's `DbIsolation` clones a Postgres
  database per run. Homebrew's `libpq` is keg-only: `brew link --force
libpq` (or the `PATH` export Homebrew prints) puts `psql` on `PATH`.
- **Chromium on Linux.** `--with-deps` also installs the system libraries
  Chromium needs (through `sudo apt`); without them it does not launch on
  a fresh machine.

## What the SessionStart hook does

At session start the plugin runs the same check in its quiet mode: silent
unless the project uses flowreel (a `flowreel.config.ts` or
`e2e/flowreel.config.ts`, an `e2e/flowreel/` folder or the `@confidee/flowreel` dependency), then
one line per missing required, video-only or voice-only item, each with
its install command, then a last line pointing at `/flowreel:doctor`.
Each `Install:` value is a command on its own, safe to paste (an item
with no single command, such as the Premium voice or Node on Linux, says
`Steps:` instead); any explanation is printed on a separate `note:` line,
in report mode only.
Everything it prints that comes from the project or another program is
reduced to version / name / path characters first. It never installs,
never blocks and always exits 0. `FLOWREEL_PREREQS=off` silences it;
`FLOWREEL_PREREQS=always` runs it in any project.

## Version managers (`unchecked`)

The check never runs a program in a way that lets the project choose what
runs. It looks every tool up and runs it from `/`, not from the project.
It does not run a tool at all when the tool resolves inside the project
or to a version manager's shim: `~/.volta/bin` (or `$VOLTA_HOME/bin`), mise
or rtx `shims`, `~/.asdf/shims` (or `$ASDF_DATA_DIR/shims`),
`~/.nodenv/shims`, or proto's `~/.proto/shims` and `~/.proto/bin`. Those
shims read project files when they run. Volta reads the `package.json` pin
and `.volta/hooks.json`, which can set a download URL or run a command.
The others read `.tool-versions`, `.mise.toml` or `.prototools`, and some
install the version they name. A cloned repository could use that to run
code at session start.

Such a tool shows as `unchecked` in report mode, with the command to check
it by hand (`node --version`, `ffmpeg -hide_banner -encoders`,
`say -v '?'`). Nothing is printed for it at session start. The doctor asks
the user to run that command in the project, or offers to run it through
the normal permission prompt, which runs the project's version-manager
configuration with their consent. nvm and fnm put a real binary on `PATH`,
so the check runs and reports them as usual.
