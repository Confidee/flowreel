// SPDX-License-Identifier: Apache-2.0

import {
  createConfig,
  localWebServer,
  reportDir,
  resultsDir,
  settleEnvValue,
} from "@confidee/flowreel/config"
import { makeRunId } from "@confidee/flowreel/run"
import { PACE_SLOW_MO } from "@confidee/flowreel/tour"
import { APP_VIEWPORT, videoEnabled } from "@confidee/flowreel/video"
import { defineConfig, devices } from "@playwright/test"

import { NOTES_TOUR, currentRun, runPace } from "./e2e/flowreel/tour"
import config, { TOUR_MODULE } from "./flowreel.config"

// The example's Playwright config, built by flowreel's createConfig: never
// a retry, one worker, a trace, video and screenshot of everything, the
// evidence in flowreel-results/<RUN_ID>/ and the summary reporter. Two
// projects: tour-setup (proves the personas) and tour-a (area A's three
// features, at the run's pace). The Notes server is started for the run.
//
//   npx playwright test                       demo pace, narrated on macOS
//   FLOWREEL_PACE=qa npx playwright test      as fast as the app allows
//   FLOWREEL_VIDEO=off npx playwright test    no video at all

const env = process.env
// Settled here, in the runner, so workers and the reporter see one value.
settleEnvValue(env, "MODULE", () => TOUR_MODULE)
const run = currentRun()
const runId = settleEnvValue(env, "RUN_ID", () => makeRunId(run.target))
const video = videoEnabled(env)
const browser = {
  ...devices["Desktop Chrome"],
  // The recording lands in the video frame 1:1.
  ...(video ? { viewport: { ...APP_VIEWPORT } } : {}),
}
const port = Number(new URL(run.baseURL).port)

export default defineConfig(
  createConfig({
    target: run.target,
    baseURL: run.baseURL,
    resultsDir: resultsDir(config, runId),
    reportDir: reportDir(config, runId),
    reporter: "./e2e/flowreel/reporter.ts",
    globalSetup: "./e2e/flowreel/global-setup.ts",
    globalTeardown: "./e2e/flowreel/global-teardown.ts",
    testDir: "./e2e/flowreel/flows",
    timeout: 120_000,
    video: { on: video, size: { ...APP_VIEWPORT } },
    slowMo: 0,
    projects: [
      {
        name: NOTES_TOUR.setupProject,
        testMatch: "setup.spec.ts",
        use: browser,
      },
      ...NOTES_TOUR.areas.map((area) => ({
        name: NOTES_TOUR.projectOfArea(area.letter),
        testMatch: new RegExp(
          `/${area.letter.toLowerCase()}\\d+-[a-z0-9-]+\\.spec\\.ts$`,
        ),
        dependencies: [NOTES_TOUR.setupProject],
        // Demo pace slows every action down so the video is readable.
        use: { ...browser, launchOptions: { slowMo: PACE_SLOW_MO[runPace()] } },
      })),
    ],
    webServer: localWebServer({
      cwd: ".",
      port,
      command: `node app/server.mjs --port ${port}`,
      baseURL: run.baseURL,
      timeout: 30_000,
      // A fresh server (and fresh data) for every run.
      reuse: false,
      env: {},
    }),
  }),
)
