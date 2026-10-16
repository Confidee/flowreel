#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

// Prints the GitHub Release notes for a version: an install line, then that
// version's section of CHANGELOG.md. Run by the release workflow after the
// npm publish succeeded (it creates the GitHub Release), and locally to
// preview them:
//
//   node scripts/release-notes.mjs v0.2.0   the notes on stdout; exit 1 when
//                                           the tag is malformed or the
//                                           changelog has no such section

import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/** The package name, from runtime/package.json. */
export function packageName(root = ROOT) {
  return JSON.parse(readFileSync(resolve(root, "runtime/package.json"), "utf8"))
    .name
}

/**
 * The body of `## [<version>] - YYYY-MM-DD` in a Keep a Changelog file, up
 * to the next `## ` heading, trimmed; null when there is no such section.
 */
export function changelogSection(changelog, version) {
  const lines = changelog.split("\n")
  const heading = new RegExp(
    `^## \\[${version.replace(/\./g, "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}\\s*$`,
  )
  const start = lines.findIndex((line) => heading.test(line))
  if (start === -1) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.startsWith("## "))
  const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim()
  return body
}

/** The release notes for a tag v<version>; throws on a bad tag or section. */
export function releaseNotes(tag, changelog, name) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error(`the tag must look like v1.2.3; got "${tag}"`)
  }
  const version = tag.slice(1)
  const section = changelogSection(changelog, version)
  if (section === null) {
    throw new Error(
      `CHANGELOG.md has no "## [${version}] - YYYY-MM-DD" section`,
    )
  }
  const npm = `https://www.npmjs.com/package/${name}/v/${version}`
  return [
    `Install: \`npm install --save-dev ${name}@${version}\` ([npm](${npm}), published by the release workflow with a provenance attestation).`,
    "",
    section,
    "",
  ].join("\n")
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (invokedDirectly) {
  try {
    const changelog = readFileSync(resolve(ROOT, "CHANGELOG.md"), "utf8")
    process.stdout.write(
      releaseNotes(process.argv[2] ?? "", changelog, packageName()),
    )
  } catch (error) {
    console.error(`release-notes: ${error.message}`)
    process.exit(1)
  }
}
