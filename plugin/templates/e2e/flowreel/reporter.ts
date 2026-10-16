import { SummaryReporter } from "@confidee/flowreel/reporter"

import { reporterOptions } from "./modules"

// Writes flowreel-results/<RUN_ID>/summary.{md,json,lines}, composes the
// run's videos and, after a development demo-pace run, publishes them to
// flowreel-demos/latest/. It reports the verdict; only the Playwright
// assertions decide it.

export default class FlowreelReporter extends SummaryReporter {
  constructor() {
    super(reporterOptions())
  }
}
