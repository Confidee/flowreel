// SPDX-License-Identifier: Apache-2.0

// @confidee/flowreel/rails-inertia: the adapter for Rails apps rendered
// with Inertia. The Inertia props reader (the initial page from the script
// element or the legacy data-page attribute, X-Inertia requests, partial
// reloads for deferred props, the one-time 409 asset-version retry) and the
// client of the test-seam protocol (sign-in, delivered mail, the job drain,
// inbound mail) that the Rails seam kit in the plugin's templates/rails
// implements. See docs/adapters.md "rails-inertia".

export * from "./inertia.js"
export * from "./seam.js"
