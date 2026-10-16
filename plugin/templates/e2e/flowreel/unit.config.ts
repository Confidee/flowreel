import { defineConfig } from "@playwright/test"

// Browser-free checks of this project's flowreel files (the narration keys
// against the flows' step titles; with the tour, CATALOGUE.md against its
// mirror). No browser, no server, no target, no secrets:
// `npm run flowreel:unit`.

export default defineConfig({
  testDir: "./unit",
  testMatch: "*.spec.ts",
  retries: 0,
  outputDir: "../../flowreel-results/unit-test-results",
  reporter: [["list"]],
})
