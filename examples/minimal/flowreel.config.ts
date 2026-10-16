// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { defineConfig } from "@confidee/flowreel/config"

// The example's flowreel configuration: where a run may point, what it can
// run, who it signs in as, and where its evidence goes. defineConfig()
// checks it once; everything else takes it as a parameter.

/** This folder (the example's root), wherever it is run from. */
export const EXAMPLE_DIR = fileURLToPath(new URL(".", import.meta.url))

/** Every persona, in sign-in order. */
export const PERSONAS = ["editor", "admin"] as const
export type PersonaKey = (typeof PERSONAS)[number]

/** The one module this example runs: the Notes feature tour. */
export const TOUR_MODULE = "notes-tour"

const config = defineConfig({
  logPrefix: "notes",
  targets: {
    // The development stage: the Notes server Playwright starts on this
    // machine (FLOWREEL_LOCAL_PORT picks a port in the range).
    local: {
      host: "127.0.0.1",
      portMin: 3170,
      portMax: 3199,
      defaultPort: 3179,
    },
    // A real project lists its exact staging origins here
    // ("https://staging.example.com"). This example has none, so a staging
    // run is refused before any request.
    staging: [],
    // Refused for every target, even if listed above.
    isProductionHost: (host) => host === "notes.example.com",
  },
  modules: { names: [TOUR_MODULE], default: TOUR_MODULE },
  personas: PERSONAS,
  // Staging secrets (persona passwords) would come from the process
  // environment or this owner-only (chmod 600) file outside the repository.
  // A local run never reads it.
  secrets: { file: (home) => join(home, ".config", "flowreel-example", "env") },
  results: join(EXAMPLE_DIR, "flowreel-results"),
})

export default config
