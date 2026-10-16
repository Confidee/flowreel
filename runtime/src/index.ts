// SPDX-License-Identifier: Apache-2.0

// @confidee/flowreel: deterministic Playwright flows that double as
// narrated, branded videos. The root entry exports the core, the mail
// contract, the video composer, the voice engines and the commands; the
// stack adapters live on their own subpaths (./rails-inertia, ./mail-graph).

export * from "./core/index.js"
export * from "./mail/index.js"
export * from "./video/index.js"
export * from "./voice/index.js"
export * from "./cli/index.js"
export * from "./config/index.js"
export * from "./app/index.js"
export * from "./run/index.js"
export * from "./pipeline/index.js"
export * from "./tour/index.js"
