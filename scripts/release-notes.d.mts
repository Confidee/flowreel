// SPDX-License-Identifier: Apache-2.0

// Types for release-notes.mjs, so runtime/test/release-notes.spec.ts can
// import it.

export declare function packageName(root?: string): string
export declare function changelogSection(
  changelog: string,
  version: string,
): string | null
export declare function releaseNotes(
  tag: string,
  changelog: string,
  name: string,
): string
