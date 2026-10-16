// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { expect, test } from "@playwright/test"

// One version everywhere a release names it: the runtime package, the
// plugin manifest, the marketplace entry, the example (and its lockfile's
// copy of the runtime), and a section of the changelog. Plus the
// repository fields npm provenance and the plugin page rely on.

const here = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(here, "../..")

const json = (path: string) =>
  JSON.parse(readFileSync(resolve(PACKAGE_ROOT, path), "utf8")) as Record<
    string,
    unknown
  >

const VERSION = json("runtime/package.json").version as string

/** The marketplace lives at the root of this repository. */
const MARKETPLACE = resolve(PACKAGE_ROOT, ".claude-plugin/marketplace.json")

/** The public repository, which npm provenance checks against. */
const REPOSITORY = "https://github.com/Confidee/flowreel"

test("the runtime version is semver", () => {
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/)
})

test("the plugin manifest carries the runtime's version", () => {
  expect(json("plugin/.claude-plugin/plugin.json").version).toBe(VERSION)
})

test("the marketplace lists the plugin at the runtime's version", () => {
  expect(existsSync(MARKETPLACE), "no .claude-plugin/marketplace.json").toBe(
    true,
  )
  const market = JSON.parse(readFileSync(MARKETPLACE, "utf8")) as {
    name: string
    plugins: { name: string; source: string; version?: string }[]
  }
  expect(market.name).toBe("flowreel")
  const entry = market.plugins.find((plugin) => plugin.name === "flowreel")
  expect(entry?.version).toBe(VERSION)
  expect(
    resolve(PACKAGE_ROOT, entry!.source),
    "the marketplace entry's source is this package's plugin",
  ).toBe(resolve(PACKAGE_ROOT, "plugin"))
})

test("the example and its lockfile carry the runtime's version", () => {
  expect(json("examples/minimal/package.json").version).toBe(VERSION)
  const lock = json("examples/minimal/package-lock.json") as {
    packages: Record<string, { version?: string }>
  }
  expect(lock.packages["node_modules/@confidee/flowreel"]?.version).toBe(
    VERSION,
  )
})

test("the changelog has a section for the version", () => {
  const changelog = readFileSync(resolve(PACKAGE_ROOT, "CHANGELOG.md"), "utf8")
  expect(changelog).toMatch(
    new RegExp(
      `^## \\[${VERSION.replace(/\./g, "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}$`,
      "m",
    ),
  )
})

test("the runtime names the public repository", () => {
  const pkg = json("runtime/package.json") as {
    repository?: { type?: string; url?: string; directory?: string }
    homepage?: string
    bugs?: { url?: string }
  }
  // npm provenance refuses a publish whose repository.url does not match
  // the repository the workflow runs in.
  expect(pkg.repository).toEqual({
    type: "git",
    url: `git+${REPOSITORY}.git`,
    directory: "runtime",
  })
  expect(pkg.homepage).toBe(`${REPOSITORY}#readme`)
  expect(pkg.bugs?.url).toBe(`${REPOSITORY}/issues`)
  expect(json("plugin/.claude-plugin/plugin.json").repository).toBe(REPOSITORY)
})
