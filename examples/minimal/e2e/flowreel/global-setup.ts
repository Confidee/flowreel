// SPDX-License-Identifier: Apache-2.0

import { createGlobalSetup } from "@confidee/flowreel/app"

import config from "../../flowreel.config"

import { loadRun, notesApp, runPersonas } from "./adapter"

// Signs every persona in ONCE for the whole run (never retried) and hands
// each session to the workers in FLOWREEL_STATE_<PERSONA>; nothing is
// written to disk and no flow signs in.

export default createGlobalSetup({
  load: () => runPersonas(loadRun()),
  adapter: notesApp,
  logPrefix: config.logPrefix,
})
