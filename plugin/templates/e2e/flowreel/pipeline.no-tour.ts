import { relative } from "node:path"

import { resultsDir } from "@confidee/flowreel/config"
import {
  type PipelineSpec,
  configProblemOf,
  runPipelineCli,
  stageLabel,
} from "@confidee/flowreel/pipeline"
import { makePipelineId, makeRunId } from "@confidee/flowreel/run"
import {
  type StageSummary,
  produceCombinedVideo,
} from "@confidee/flowreel/video"

import { type Module, flowreel } from "../../flowreel.config"

import { isStagingSecret, loadRun } from "./adapter"
import { videoKit } from "./brand"

// `npm run flowreel -- [--local | --staging-only] [--headed] [--no-video]
// [--narration on|off] [--deadline 25m]`. Stage 1 "development" runs on the local server;
// stage 2 "staging" runs ONLY after a development PASS. Each stage is its
// own Playwright child with its own run id and a clean env (only staging
// gets the secrets); nothing is ever retried. Results:
// flowreel-results/<PIPELINE_ID>/pipeline.{md,json} plus each stage's run
// folder. Exit codes: 0 pass, 1 fail, 2 staging not configured, 3 N/A,
// 4 undo failed (manual action), 64 bad arguments, 130 stopped (Ctrl-C, a
// CI's stop signal or --deadline). This project has no feature tour, so
// --area and --pace are refused.

const ROOT = process.cwd()

const noTour = (): never => {
  throw new Error("This project has no feature tour (--area, --pace).")
}

const spec: PipelineSpec<Module, StageSummary> = {
  modules: flowreel.modules.names,
  defaultModule: flowreel.modules.default,
  tourModules: [],
  parseAreas: noTour,
  parsePace: noTour,
  isSecret: isStagingSecret,
  repoRoot: ROOT,
  playwrightConfig: "e2e/flowreel/playwright.config.ts",
  usage:
    "Usage: npm run flowreel -- [--local | --staging-only] [--headed] [--no-video] [--narration on|off] [--deadline 25m]",
  resultsDir: (id) => resultsDir(flowreel, id),
  makeRunId: (target) => makeRunId(target),
  makePipelineId: () => makePipelineId(),
  stageInfo: {
    development: {
      title: "Development",
      detail: "Local test server · test data",
      target: "local",
    },
    staging: {
      title: "Staging",
      detail: "Staging server",
      target: "staging",
    },
  },
  projects: () => ["smoke"],
  stagingConfigProblem(env) {
    try {
      loadRun(env)
      return null
    } catch (error) {
      return configProblemOf(error)
    }
  },
  // A fresh database per development run (optional), e.g. over a clone
  // script that prints `export NAME=value` lines:
  //   db: {
  //     modules: ["smoke"],
  //     keyPrefix: "smoke",
  //     isolation: commandDbIsolation({ command: "bin/db-clone", cwd: ROOT,
  //       parse: (out) => Object.fromEntries([...out.matchAll(
  //         /^export (\w+)=(.*)$/gm)].map((m) => [m[1], m[2]])) }),
  //   },
  report: {
    markdown(doc, _request, dir) {
      const rel = (path: string | null) =>
        path ? relative(dir, `${ROOT}/${path}`) : "—"
      return [
        `# Pipeline ${doc.pipelineId}: ${doc.verdict}`,
        "",
        doc.verdictReason,
        "",
        "| Stage | Verdict | Run | Summary |",
        "| --- | --- | --- | --- |",
        ...doc.stages.map(
          (s) =>
            `| ${s.stage} | ${stageLabel(s)} | ${s.runId ?? "—"} | ${rel(s.summary)} |`,
        ),
        "",
      ].join("\n")
    },
    compose: (request, env) => produceCombinedVideo(request, videoKit(), env),
  },
}

runPipelineCli(spec)
