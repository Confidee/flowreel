// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "@playwright/test"

import { renderPngs } from "../src/video/render.js"

import { installFakeBrowser } from "./fake-browser.js"

test.describe.configure({ mode: "serial" })

let dir: string
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "flowreel-render-"))
})
test.afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

test("renders each job at Full HD in one unrecorded context, then closes", async () => {
  const { log, restore } = installFakeBrowser()
  try {
    await renderPngs([
      { html: "<p>card</p>", path: join(dir, "a.png") },
      { html: "<p>overlay</p>", path: join(dir, "b.png"), transparent: true },
    ])
  } finally {
    restore()
  }
  expect(log.launches).toBe(1)
  // Laid out at 1280x720, painted at 1.5x; no recording, trace or session.
  expect(log.contexts).toEqual([
    { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5 },
  ])
  expect(log.contents).toEqual([
    { html: "<p>card</p>", options: { waitUntil: "load" } },
    { html: "<p>overlay</p>", options: { waitUntil: "load" } },
  ])
  expect(log.shots).toEqual([
    { path: join(dir, "a.png"), omitBackground: false },
    { path: join(dir, "b.png"), omitBackground: true },
  ])
  expect(existsSync(join(dir, "b.png"))).toBe(true)
  expect(log.closed).toEqual(["context", "browser"])
})

test("no jobs still opens and closes the browser", async () => {
  const { log, restore } = installFakeBrowser()
  try {
    await renderPngs([])
  } finally {
    restore()
  }
  expect(log.shots).toEqual([])
  expect(log.closed).toEqual(["context", "browser"])
})

test("a failing screenshot closes the browser and rethrows", async () => {
  const bad = join(dir, "bad.png")
  const { log, restore } = installFakeBrowser({ failShotAt: bad })
  try {
    await expect(
      renderPngs([
        { html: "<p>1</p>", path: join(dir, "ok.png") },
        { html: "<p>2</p>", path: bad },
        { html: "<p>3</p>", path: join(dir, "never.png") },
      ]),
    ).rejects.toThrow("screenshot failed")
  } finally {
    restore()
  }
  expect(log.shots.map((s) => s.path)).toEqual([join(dir, "ok.png")])
  expect(log.closed).toEqual(["browser"])
})
