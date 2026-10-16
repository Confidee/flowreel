import {
  assertSafeBaseUrl,
  createConfig,
  localWebServer,
  reportDir,
  resultsDir,
  settleEnvValue,
} from "@confidee/flowreel/config"
import { envValue } from "@confidee/flowreel/core"
import { makeRunId } from "@confidee/flowreel/run"
import { APP_VIEWPORT, videoEnabled } from "@confidee/flowreel/video"
import { defineConfig, devices } from "@playwright/test"

import { flowreel } from "../../flowreel.config"

import { loadRun } from "./adapter"

// One Playwright config, two targets (FLOWREEL_TARGET=local | staging), one
// module (the "smoke" round trip; this project has no feature tour). The
// module and the run id are settled here, in the runner process, so workers
// and the reporter inherit them. flowreel fixes what must not vary: retries
// 0, one worker, trace + video + screenshot of everything, results in
// flowreel-results/<RUN_ID>/.

const env = process.env
settleEnvValue(env, "MODULE", () => flowreel.modules.default)
const run = loadRun(env)
const baseURL = assertSafeBaseUrl(run.baseURL, run.target, flowreel.targets)
const runId = settleEnvValue(env, "RUN_ID", () => makeRunId(run.target))
const video = videoEnabled(env)
const browser = {
  ...devices["Desktop Chrome"],
  ...(video ? { viewport: { ...APP_VIEWPORT } } : {}),
}
const slowMo = envValue(env, "SLOW_MO")

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
