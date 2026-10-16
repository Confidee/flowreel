<img alt="flowreel" src="https://raw.githubusercontent.com/Confidee/flowreel/main/assets/brand/flowreel-mint-horizontal-light.svg" width="320">

# @confidee/flowreel

The flowreel runtime: deterministic Playwright flows that double as
narrated, branded videos, with a development-then-staging release gate.

[![Watch the 76-second flowreel demo (sound on)](https://raw.githubusercontent.com/Confidee/flowreel/main/assets/demo/flowreel-demo-thumbnail.jpg)](https://github.com/Confidee/flowreel#readme)

<sub>Watch the 76-second demo, sound on, at the top of the
[project README](https://github.com/Confidee/flowreel#readme).</sub>

> Status: 0.x; APIs may change between minor versions. See the
> [project README](https://github.com/Confidee/flowreel#readme) and the
> [docs](https://github.com/Confidee/flowreel/tree/main/docs).

- ESM, Node >= 20, peer dependency `@playwright/test` >= 1.56, no other
  runtime dependencies.
- Loads with `import` everywhere, and with `require()` on Node 20.19+,
  22.12+ or 23+ (require of ES modules). Playwright compiles a project's test
  files to CommonJS unless its package.json has `"type": "module"`, so on
  older Node set `"type": "module"` in the consuming project.
- Entry points: `@confidee/flowreel` (everything below except `/reporter`,
  `/demos` and the two adapters), `/core`,
  `/mail`, `/video`, `/voice`, `/cli`, `/config` (defineConfig, target
  allowlist with a loopback-only local host, secrets file, createConfig),
  `/app` (AppAdapter, personas, sign-in/out, keepalive), `/run` (run ids,
  texts, the cleanup rules; the cleanup fixture stays project-side for
  now), `/pipeline` (the development -> staging gate, DbIsolation, runner)
  and `/tour` (TourManifest, feature(), catalogue tripwire, tourFixtures(),
  tourModuleFrom()), `/reporter` (SummaryReporter, ModuleDescriptor, the
  status rules) and `/demos` (DemoCatalogue, demoPublisher); adapters on
  `/rails-inertia` (InertiaPropsReader, seamSignIn, HttpSeamMailDriver,
  DEFAULT_SEAM_PATHS) and `/mail-graph` (GraphMailDriver). `/tour`'s static
  tripwire takes the project's own `typescript` module as an argument
  (typed structurally), so neither the runtime nor its published types
  depend on it. The scanner supports TypeScript 5.x and 6.x; TypeScript 7
  is not supported yet
  ([issue #6](https://github.com/Confidee/flowreel/issues/6)).

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
