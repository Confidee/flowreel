// SPDX-License-Identifier: Apache-2.0

import { SummaryReporter } from "@confidee/flowreel/reporter"

import { reporterOptions } from "./tour"

// flowreel's summary reporter for the Notes tour: writes
// flowreel-results/<RUN_ID>/summary.{md,json,lines} and composes the
// videos (one per area and the full tour) after the run. Playwright builds
// a reporter from a path, so the options are bound in this subclass.

export default class NotesReporter extends SummaryReporter {
  constructor() {
    super(reporterOptions())
  }
}
