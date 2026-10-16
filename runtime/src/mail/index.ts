// SPDX-License-Identifier: Apache-2.0

// The mail contract, the pure matcher and the staging send guard. No driver
// lives here: the HTTP seam driver (development) ships on the rails-inertia
// subpath and the Graph driver (staging) on the mail-graph subpath; both
// implement MailDriver.

export * from "./types.js"
export * from "./match.js"
export * from "./guard.js"
