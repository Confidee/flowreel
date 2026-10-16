// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "@playwright/test"

import { type DemosCliOptions, demosCli } from "../src/cli/demos.js"

function options(overrides: Partial<DemosCliOptions> = {}) {
  const out: string[] = []
  const err: string[] = []
  const published: string[] = []
  const opts: DemosCliOptions = {
    parseRunIdArg: (raw) => (raw && /^loc-\d+$/.test(raw) ? raw : null),
    publish: (runId) => {
      published.push(runId)
      return { published: true, files: ["01-a.mp4"], dir: "/repo/demos/latest" }
    },
    rootDir: "/repo",
    usage: "Usage: demos <RUN_ID>",
    log: (l) => out.push(l),
    error: (l) => err.push(l),
    ...overrides,
  }
  return { opts, out, err, published }
}

test("exit 64 with the usage line on a missing, bad or extra argument", () => {
  for (const argv of [[], ["nope"], ["loc-1", "loc-2"]]) {
    const { opts, err, published } = options()
    expect(demosCli(argv, opts)).toBe(64)
    expect(err).toEqual(["Usage: demos <RUN_ID>"])
    expect(published).toEqual([])
  }
})

test("exit 0 and one line with the files and the folder relative to the root", () => {
  const { opts, out, published } = options()
  expect(demosCli(["loc-1"], opts)).toBe(0)
  expect(published).toEqual(["loc-1"])
  expect(out).toEqual([
    "[demos] loc-1: 01-a.mp4 -> demos/latest/ (README.md updated)",
  ])
})

test("exit 1 with the reason when nothing was published", () => {
  const { opts, err } = options({
    publish: () => ({ published: false, reason: "a qa-pace run" }),
  })
  expect(demosCli(["loc-1"], opts)).toBe(1)
  expect(err).toEqual(["[demos] loc-1: nothing published (a qa-pace run)"])
})
