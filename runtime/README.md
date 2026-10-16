<img alt="" src="https://raw.githubusercontent.com/Confidee/flowreel/main/assets/brand/flowreel-mint-symbol-light.svg" width="56" height="56">

# @confidee/flowreel

The flowreel runtime: deterministic Playwright flows that double as
narrated, branded videos, with a development-then-staging release gate.

> Status: 0.x, pre-release. See the
> [project README](https://github.com/Confidee/flowreel#readme) and the
> [docs](https://github.com/Confidee/flowreel/tree/main/docs).

- ESM, Node >= 20, peer dependency `@playwright/test` >= 1.56, no other
  runtime dependencies.
- Loads with `import` everywhere, and with `require()` on Node 20.19+ or
  22.12+ (require of ES modules). Playwright compiles a project's test
  files to CommonJS unless its package.json has `"type": "module"`, so on
  older Node set `"type": "module"` in the consuming project.
- Entry points: `@confidee/flowreel` (everything below), `/core`,
  `/mail`, `/video`, `/voice`, `/cli`, `/config` (defineConfig, target
  allowlist with a loopback-only local host, secrets file, createConfig),
  `/app` (AppAdapter, personas, sign-in/out, keepalive), `/run` (run ids,
  texts, the cleanup rules; the cleanup fixture stays project-side for
  now), `/pipeline` (the development -> staging gate, DbIsolation, runner)
  and `/tour` (TourManifest, feature(), catalogue tripwire, tourFixtures(),
  tourModuleFrom()), `/reporter` (SummaryReporter, ModuleDescriptor, the
  status rules) and `/demos` (DemoCatalogue, demoPublisher); adapters on `/rails-inertia` (InertiaPropsReader,
  seamSignIn, HttpSeamMailDriver, DEFAULT_SEAM_PATHS) and `/mail-graph`
  (GraphMailDriver). `/tour`'s static tripwire takes the
  project's own `typescript` module as an argument (typed structurally), so
  neither the runtime nor its published types depend on it.

## Develop

```bash
npm test          # browser-free unit tests (Playwright test runner)
npm run test:coverage  # the same with the 95% coverage gate (c8)
npm run typecheck # src + test
npm run build     # tsc -> dist/
npm run smoke:exports  # after build: every entry point via import and require
npm run check     # typecheck, test:coverage, build, smoke:exports
```

Run these in `runtime/` after `npm ci`. The leak tripwire that `npm test`
runs first scans the whole repository, so run it from a full clone of
[Confidee/flowreel](https://github.com/Confidee/flowreel).

## License

Apache-2.0 (see LICENSE and NOTICE).
