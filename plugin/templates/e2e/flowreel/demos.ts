import { demosCli } from "@confidee/flowreel/cli"

import { demos } from "./modules"

// `npm run flowreel:demos -- <RUN_ID>`: copies a demo-pace run's videos into
// flowreel-demos/latest/ under their fixed names and rewrites its README.
// A qa-pace run is refused.

process.exit(
  demosCli(process.argv.slice(2), {
    parseRunIdArg: (raw) => demos.parseRunIdArg(raw),
    publish: (runId) => demos.publishDemos(demos.runDirOf(runId)),
    rootDir: process.cwd(),
    usage: "Usage: npm run flowreel:demos -- <RUN_ID>",
  }),
)
