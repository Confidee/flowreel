// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { expect, test } from "@playwright/test"

import {
  changelogSection,
  packageName,
  releaseNotes,
} from "../../scripts/release-notes.mjs"

// The GitHub Release notes the release workflow creates after a publish:
// an install line, then that version's changelog section.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

const CHANGELOG = `# Changelog

## [Unreleased]

### Added

- Not released yet.

## [1.2.0] - 2026-01-02

The new version.

### Fixed

- A fix.

## [1.1.0] - 2026-01-01

- Older.
`

test("a version's section, up to the next version, without the heading", () => {
  expect(changelogSection(CHANGELOG, "1.2.0")).toBe(
    "The new version.\n\n### Fixed\n\n- A fix.",
  )
  expect(changelogSection(CHANGELOG, "1.1.0")).toBe("- Older.")
  expect(changelogSection(CHANGELOG, "1.0.0")).toBeNull()
  // The dots are literal: 1x2x0 is not 1.2.0.
  expect(changelogSection(CHANGELOG.replace("1.2.0", "1x2x0"), "1.2.0")).toBe(
    null,
  )
  // An undated heading (still being written) is not a release.
  expect(changelogSection("## [1.3.0]\n\n- Draft.\n", "1.3.0")).toBeNull()
})

test("the notes: the install line, then the section", () => {
  expect(releaseNotes("v1.2.0", CHANGELOG, "@scope/pkg")).toBe(
    [
      "Install: `npm install --save-dev @scope/pkg@1.2.0` ([npm](https://www.npmjs.com/package/@scope/pkg/v/1.2.0), published by the release workflow with a provenance attestation).",
      "",
      "The new version.",
      "",
      "### Fixed",
      "",
      "- A fix.",
      "",
    ].join("\n"),
  )
})

test("a malformed tag or a missing section is refused", () => {
  expect(() => releaseNotes("1.2.0", CHANGELOG, "p")).toThrow(
    'the tag must look like v1.2.3; got "1.2.0"',
  )
  expect(() => releaseNotes("v1.2.0-rc.1", CHANGELOG, "p")).toThrow(
    "the tag must look like v1.2.3",
  )
  expect(() => releaseNotes("v9.9.9", CHANGELOG, "p")).toThrow(
    'CHANGELOG.md has no "## [9.9.9] - YYYY-MM-DD" section',
  )
})

test("the repository's own changelog has notes for the released version", () => {
  const { version } = JSON.parse(
    readFileSync(resolve(ROOT, "runtime/package.json"), "utf8"),
  ) as { version: string }
  const changelog = readFileSync(resolve(ROOT, "CHANGELOG.md"), "utf8")
  const notes = releaseNotes(`v${version}`, changelog, packageName(ROOT))
  expect(notes).toContain(`@${version}\``)
  expect(notes).not.toContain("## [")
})
