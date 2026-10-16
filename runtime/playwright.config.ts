// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "@playwright/test"

// Browser-free unit tests for the runtime: no web server, no target config,
// no credentials. Only the video renderer launches a browser, and no test
// here calls it.
export default defineConfig({
  testDir: "./test",
  testMatch: "*.spec.ts",
  fullyParallel: true,
  retries: 0,
  outputDir: "./test-results",
  reporter: [["list"]],
})
