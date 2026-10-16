## What and why

<!-- One conceptual change per pull request. Link the issue it closes. -->

## What I ran, and what I observed

<!-- Commands and their results, not what you expect to happen. -->

- [ ] `npm run check` in `runtime/` (typecheck, leak tripwire + unit tests with the 95% coverage gate, build, export smoke test)
- [ ] `bash plugin/scripts/check-templates.sh`, if the plugin's templates or the runtime's API changed
- [ ] `npm run test:qa` in `examples/minimal/`, if run behaviour changed
- [ ] `npm run format:check` at the repository root
- [ ] `claude plugin validate --strict ./plugin` and `claude plugin validate --strict .`, if the plugin or the marketplace changed

## Checklist

- [ ] Tests in the same change; a bug fix ships its regression test.
- [ ] A line in `CHANGELOG.md` under `[Unreleased]` (**BREAKING:** prefix where it applies).
- [ ] Docs updated for any change to behaviour, configuration, environment variables, exit codes, safety rules or plugin commands.
- [ ] Every shell command a skill or agent may run is listed in `docs/plugin.md`.
- [ ] No verdict-deciding logic outside Playwright assertions; no safety rule weakened.
- [ ] New source files carry the SPDX header.
