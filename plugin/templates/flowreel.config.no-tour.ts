import { join, resolve } from "node:path"

import { defineConfig } from "@confidee/flowreel/config"

// flowreel's configuration for this project: where a run may point, the
// modules a pipeline can run, the personas, where secrets and results live.
// Scaffolded by /flowreel:init; every "TODO(flowreel)" is yours to fill in.
//
// Safety rules this file feeds (enforced by the runtime, never by habit):
//   - a local run may only use a loopback host and a port in the range;
//   - a staging run may only use one of the exact `staging` origins;
//   - a host `isProductionHost` accepts is refused for every target, even
//     when listed;
//   - the target comes from FLOWREEL_TARGET in the process env only, never
//     from the secrets file, and a local run never reads that file.

/** TODO(flowreel): your staging origin (https, no path). */
export const STAGING_ORIGIN = "https://staging.example.com"

/** TODO(flowreel): every production host name (lower case). */
const PRODUCTION_HOSTS = new Set(["example.com", "www.example.com"])

export const flowreel = defineConfig({
  logPrefix: "flowreel",
  targets: {
    // TODO(flowreel): a free port range for the development stage's server.
    local: { host: "localhost", portMin: 3300, portMax: 3399 },
    staging: [STAGING_ORIGIN],
    isProductionHost: (host) => PRODUCTION_HOSTS.has(host),
  },
  // The round trip ("smoke", the release gate); this project has no
  // feature tour. Rename it together with e2e/flowreel/modules.ts.
  modules: { names: ["smoke"], default: "smoke" },
  // Every persona, in sign-in order. Locally they are the seeded development
  // accounts (e2e/flowreel/adapter.ts); on staging they come from
  // FLOWREEL_<PERSONA>_EMAIL / FLOWREEL_<PERSONA>_PASSWORD.
  personas: ["user", "admin"],
  secrets: {
    // Outside the repository, owner-only (chmod 600): the runtime refuses a
    // file other users can read. Process env overrides it.
    file: (home) => join(home, ".config", "flowreel", "staging.env"),
    baseUrlKey: "FLOWREEL_BASE_URL",
    template: "e2e/flowreel/env.example",
    envHint: "e.g. injected by a password manager for one run",
  },
  // Per-run evidence: flowreel-results/<RUN_ID>/ (git-ignored; it holds
  // session cookies in traces). Resolved against the working directory:
  // run flowreel from the project root (the npm scripts do).
  results: "flowreel-results",
  // Your own older names for flowreel's variables, if any:
  // envAliases: { TARGET: ["E2E_TARGET"] },
})

export type Module = (typeof flowreel.modules.names)[number]
export type PersonaKey = (typeof flowreel.personas)[number]

/** The flowreel folder (run flowreel from the project root). */
export const E2E_FLOWREEL = resolve("e2e", "flowreel")

/** Where a demo-pace run's videos are published (git-ignored). */
export const DEMOS_DIR = resolve("flowreel-demos", "latest")
