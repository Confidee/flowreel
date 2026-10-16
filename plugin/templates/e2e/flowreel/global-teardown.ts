import { createGlobalTeardown } from "@confidee/flowreel/app"

import { flowreel } from "../../flowreel.config"

import { appAdapter, loadRun, runPersonas } from "./adapter"

// Signs every persona out, pass or fail: traces and the HTML report record
// the session cookie, which must be dead before anyone opens them. A failed
// sign-out is a loud warning, never a test failure.

export default createGlobalTeardown({
  load: () => runPersonas(loadRun()),
  adapter: appAdapter,
  logPrefix: flowreel.logPrefix,
})
