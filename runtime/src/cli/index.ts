// SPDX-License-Identifier: Apache-2.0

// Command implementations. Each returns an exit code and never calls
// process.exit, so a project's own entry point (or the flowreel binary,
// later) decides how to run it.

export * from "./demos.js"
