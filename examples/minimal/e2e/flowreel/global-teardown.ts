// SPDX-License-Identifier: Apache-2.0

import { createGlobalTeardown } from "@confidee/flowreel/app"

import config from "../../flowreel.config"

import { loadRun, notesApp, runPersonas } from "./adapter"

// Signs every persona out at the end of the run, pass or fail: traces and
// the HTML report hold the session cookies, which are dead after this.

export default createGlobalTeardown({
  load: () => runPersonas(loadRun()),
  adapter: notesApp,
  logPrefix: config.logPrefix,
})
