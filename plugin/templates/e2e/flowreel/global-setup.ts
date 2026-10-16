import { createGlobalSetup } from "@confidee/flowreel/app"

import { flowreel } from "../../flowreel.config"

import { appAdapter, loadRun, runPersonas } from "./adapter"

// Development stage: appAdapter.prepareLocal(), then ONE sign-in per
// distinct persona session (never retried), handed to the workers as
// FLOWREEL_STATE_<PERSONA> (JSON in the env, never on disk). Staging signs
// in through a browser launched here, outside any test, so no trace ever
// records the password.

export default createGlobalSetup({
  load: () => runPersonas(loadRun()),
  adapter: appAdapter,
  logPrefix: flowreel.logPrefix,
})
