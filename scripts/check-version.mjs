#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

// Checks that a release tag names the version every released file carries:
// the runtime package, the plugin manifest, the marketplace entry, the
// example (and its lockfile's copy of the runtime) and a dated section of
// the changelog. Run by the release workflow before it publishes, and
// locally before tagging (see RELEASING.md).
//
//   node scripts/check-version.mjs v0.2.0   exit 0 when every file says
//                                           0.2.0, 1 with one line per
//                                           mismatch
//   node scripts/check-version.mjs          checks the files agree, and
//                                           prints the version

import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const json = (path) => JSON.parse(readFileSync(resolve(ROOT, path), "utf8"))

const runtime = json("runtime/package.json").version
const market = json(".claude-plugin/marketplace.json").plugins?.find(
  (plugin) => plugin.name === "flowreel",
)
const found = {
  "runtime/package.json": runtime,
  "plugin/.claude-plugin/plugin.json": json("plugin/.claude-plugin/plugin.json")
    .version,
  ".claude-plugin/marketplace.json (plugin flowreel)": market?.version,
  "examples/minimal/package.json": json("examples/minimal/package.json")
    .version,
  "examples/minimal/package-lock.json (@confidee/flowreel)": json(
    "examples/minimal/package-lock.json",
  ).packages?.["node_modules/@confidee/flowreel"]?.version,
}

const tag = process.argv[2]
if (tag !== undefined && !/^v\d+\.\d+\.\d+$/.test(tag)) {
  console.error(`check-version: the tag must look like v1.2.3; got "${tag}".`)
  process.exit(1)
}
const expected = tag === undefined ? runtime : tag.slice(1)

const problems = Object.entries(found)
  .filter(([, version]) => version !== expected)
  .map(([file, version]) => `${file}: ${version ?? "(missing)"}`)

const changelog = readFileSync(resolve(ROOT, "CHANGELOG.md"), "utf8")
const heading = new RegExp(
  `^## \\[${expected.replace(/\./g, "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}$`,
  "m",
)
if (!heading.test(changelog)) {
  problems.push(`CHANGELOG.md: no "## [${expected}] - YYYY-MM-DD" section`)
}

if (problems.length > 0) {
  console.error(`check-version: expected ${expected} everywhere:`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}
console.log(`check-version: ${expected} everywhere`)
