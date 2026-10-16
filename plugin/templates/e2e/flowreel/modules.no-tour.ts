import { join } from "node:path"

import { resultsDir } from "@confidee/flowreel/config"
import { type DemoCatalogue, demoPublisher } from "@confidee/flowreel/demos"
import type {
  RoundTripModule,
  SummaryReporterOptions,
} from "@confidee/flowreel/reporter"
import { produceVideo, videoPaceFor } from "@confidee/flowreel/video"

import { DEMOS_DIR, E2E_FLOWREEL, flowreel } from "../../flowreel.config"

import { loadRun } from "./adapter"
import { videoKit } from "./brand"

// The project's module as the summary reporter, the videos and the demos
// read it: the round trip ("smoke", the release gate: one test in one
// project; this project has no feature tour), the demo catalogue and the
// summary reporter's options. The video kit (brand, card copy, narration)
// is in ./brand.ts.

const ROOT = process.cwd()

export const SMOKE: RoundTripModule & Required<Pick<RoundTripModule, "demo">> =
  {
    kind: "round-trip",
    name: "smoke",
    project: "smoke",
    planFile: join(E2E_FLOWREEL, "plans", "smoke.md"),
    // "| S1 open | …": the plan's step table lists every step id.
    planStepPattern: /^\|\s*(S\d+ [^|]*?)\s*\|/gm,
    verdictCopy: {
      passed: "Every smoke step passed.",
      notInRun: "The smoke flow was not part of this run.",
      skipped: "smoke test skipped",
    },
    demo: {
      file: "00-smoke.mp4",
      shows: "TODO(flowreel): what the round trip shows, in one sentence.",
    },
  }

export const DEMO_CATALOGUE: DemoCatalogue = {
  dir: DEMOS_DIR,
  runIdPattern: /^(?:loc|stg)-\d{8}-\d{4}-[0-9a-f]{4}$/,
  runDir: (runId) => resultsDir(flowreel, runId),
  developmentTarget: "local",
  roundTrip: SMOKE,
  readme: {
    heading: "Demo videos (latest)",
    notice:
      "Internal only until reviewed: a staging run may show staging data.",
    updatedBy: "flowreel",
    runsFolder: "flowreel-results/<run id>/",
    refreshCommand: "npm run flowreel:demos -- <RUN_ID>",
  },
}

export const demos = demoPublisher(DEMO_CATALOGUE)

/** The summary reporter's options (e2e/flowreel/reporter.ts). */
export function reporterOptions(): SummaryReporterOptions {
  return {
    modules: [SMOKE],
    config: flowreel,
    repoRoot: ROOT,
    setupLocation: "e2e/flowreel/global-setup.ts:1",
    configuredTarget: () => loadRun().target,
    // What summary.json records about the configuration: never a secret.
    describeConfig: () => {
      const run = loadRun()
      return { target: run.target, module: run.module, baseURL: run.baseURL }
    },
    videoPace: () => videoPaceFor("round-trip", process.env),
    produceVideo: (req) => produceVideo(req, videoKit()),
    publishDemos: (runDir, options) =>
      demos.publishDemos(runDir, undefined, undefined, options),
  }
}
