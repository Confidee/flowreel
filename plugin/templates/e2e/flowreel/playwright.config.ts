import {
  assertSafeBaseUrl,
  createConfig,
  localWebServer,
  reportDir,
  resultsDir,
  settleEnvValue,
} from "@confidee/flowreel/config"
import { envName, envValue } from "@confidee/flowreel/core"
import { makeRunId } from "@confidee/flowreel/run"
import { PACE_SLOW_MO, detectModule, parsePace } from "@confidee/flowreel/tour"
import { APP_VIEWPORT, videoEnabled } from "@confidee/flowreel/video"
import {
  type PlaywrightTestConfig,
  defineConfig,
  devices,
} from "@playwright/test"

import { flowreel } from "../../flowreel.config"

import { loadRun } from "./adapter"
import { TOUR } from "./tour"

// One Playwright config, two targets (FLOWREEL_TARGET=local | staging), two
// modules (the "smoke" round trip; the "tour", whose projects exist only in
// a tour run). The module and the run id are settled here, in the runner
// process, so workers and the reporter inherit them. flowreel fixes what
// must not vary: retries 0, one worker, trace + video + screenshot of
// everything, results in flowreel-results/<RUN_ID>/.

type Project = NonNullable<PlaywrightTestConfig["projects"]>[number]

const env = process.env
settleEnvValue(env, "MODULE", () =>
  detectModule(process.argv, env, {
    modules: flowreel.modules.names,
    tourModule: "tour",
    fallback: flowreel.modules.default,
    isTourProject: TOUR.isTourProject,
  }),
)
const run = loadRun(env)
const baseURL = assertSafeBaseUrl(run.baseURL, run.target, flowreel.targets)
const runId = settleEnvValue(env, "RUN_ID", () => makeRunId(run.target))
const video = videoEnabled(env)
const browser = {
  ...devices["Desktop Chrome"],
  ...(video ? { viewport: { ...APP_VIEWPORT } } : {}),
}
const slowMo = envValue(env, "SLOW_MO")
const tourSlowMo = Number(
  slowMo ??
    PACE_SLOW_MO[parsePace(envValue(env, "PACE"), envName(env, "PACE"))],
)

const tourProjects: Project[] = [
  {
    name: TOUR.setupProject,
    testDir: "./flows/tour",
    testMatch: "setup.spec.ts",
    use: browser,
  },
  ...TOUR.areas.map((area): Project => ({
    name: TOUR.projectOfArea(area.letter),
    testDir: "./flows/tour",
    testMatch: `${area.letter.toLowerCase()}-*.spec.ts`,
    dependencies: [TOUR.setupProject],
    use: { ...browser, launchOptions: { slowMo: tourSlowMo } },
  })),
]

export default defineConfig(
  createConfig({
    target: run.target,
    baseURL,
    resultsDir: resultsDir(flowreel, runId),
    reportDir: reportDir(flowreel, runId),
    reporter: "./reporter.ts",
    globalSetup: "./global-setup.ts",
    globalTeardown: "./global-teardown.ts",
    testDir: "./flows",
    timeout: 180_000,
    video: { on: video, size: { ...APP_VIEWPORT } },
    slowMo: Number(slowMo ?? (video ? 250 : 0)),
    projects: [
      {
        name: "smoke",
        testDir: "./flows",
        testMatch: "smoke.spec.ts",
        use: browser,
      },
      ...(run.module === "tour" ? tourProjects : []),
    ],
    // The development stage's own server, on the run's port. TODO(flowreel):
    // the command that starts your app in test mode on `port`, and a path
    // that answers 200 once it is up.
    webServer: localWebServer({
      cwd: "../..",
      port: Number(new URL(baseURL).port),
      command: `npm run dev -- --port ${new URL(baseURL).port}`,
      readyPath: "/",
      baseURL,
      reuse: !env.CI && !envValue(env, "DB_KEY"),
      env: {},
    }),
  }),
)
