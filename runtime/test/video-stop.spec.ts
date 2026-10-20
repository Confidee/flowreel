// SPDX-License-Identifier: Apache-2.0

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

import { chromium } from "@playwright/test"
import { expect, test } from "@playwright/test"

import { probeDuration } from "../src/video/ffmpeg.js"
import { renderPngs } from "../src/video/render.js"
import { produceTourVideos } from "../src/video/tour-video.js"
import { produceVideo } from "../src/video/run-video.js"
import { mediaSignal, withMediaSignal } from "../src/video/stop.js"
import { runTool } from "../src/voice/voice.js"
import { createVideoKit } from "../src/video/kit.js"

import { installFakeBrowser } from "./fake-browser.js"

// A stopped video composition: the stop signal reaches every tool through
// withMediaSignal (ffmpeg / ffprobe, the voice engine, the card renderer's
// browser), and the producers pass a request's own signal down.

test.describe.configure({ mode: "serial" })

const sleeper = `setTimeout(() => {}, 10000)`

test("the media signal is the composition's own, through every await, and none outside", async () => {
  expect(mediaSignal()).toBeUndefined()
  const stop = new AbortController()
  const seen = await withMediaSignal(stop.signal, async () => {
    await new Promise((r) => setTimeout(r, 1))
    return mediaSignal()
  })
  expect(seen).toBe(stop.signal)
  expect(mediaSignal()).toBeUndefined()
  expect(await withMediaSignal(undefined, () => Promise.resolve(7))).toBe(7)
})

test("a tool run by the voice engine stops with the composition", async () => {
  const stop = new AbortController()
  const started = Date.now()
  const run = withMediaSignal(stop.signal, () =>
    runTool(process.execPath, ["-e", sleeper]),
  )
  setTimeout(() => stop.abort(), 50)
  await expect(run).rejects.toThrow(`${process.execPath} stopped`)
  expect(Date.now() - started).toBeLessThan(5000)
  // Already stopped: never started.
  await expect(
    withMediaSignal(stop.signal, () => runTool("/nonexistent/tool", [])),
  ).rejects.toThrow("/nonexistent/tool stopped")
})

test.describe("ffmpeg and ffprobe", () => {
  let dir: string
  let savedPath: string | undefined
  test.beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "flowreel-stop-tools-"))
    const tool = join(dir, "ffprobe")
    writeFileSync(tool, `#!${process.execPath}\n${sleeper}\n`)
    chmodSync(tool, 0o755)
    savedPath = process.env.PATH
    process.env.PATH = `${dir}${delimiter}${savedPath ?? ""}`
  })
  test.afterAll(() => {
    process.env.PATH = savedPath
    rmSync(dir, { recursive: true, force: true })
  })

  test("a running probe stops with the composition; a stopped one never starts", async () => {
    const stop = new AbortController()
    const run = withMediaSignal(stop.signal, () => probeDuration("a.webm"))
    setTimeout(() => stop.abort(), 50)
    await expect(run).rejects.toThrow("ffprobe stopped")
    await expect(
      withMediaSignal(stop.signal, () => probeDuration("a.webm")),
    ).rejects.toThrow("ffprobe stopped")
  })
})

test.describe("the card renderer", () => {
  test("a stopped composition launches no browser", async () => {
    const { log, restore } = installFakeBrowser()
    const stop = new AbortController()
    stop.abort()
    try {
      await expect(
        withMediaSignal(stop.signal, () => renderPngs([])),
      ).rejects.toThrow("card rendering stopped")
    } finally {
      restore()
    }
    expect(log.launches).toBe(0)
  })

  test("a stop while the browser starts closes it and ends the render", async () => {
    const { log, restore } = installFakeBrowser()
    const stop = new AbortController()
    try {
      const run = withMediaSignal(stop.signal, () =>
        renderPngs([{ html: "<p>x</p>", path: "/never.png" }]),
      )
      stop.abort()
      await expect(run).rejects.toThrow("card rendering stopped")
    } finally {
      restore()
    }
    expect(log.shots).toEqual([])
    expect(log.closed).toContain("browser")
  })

  test("a stop during the render closes the browser at once", async () => {
    const closed: string[] = []
    const stop = new AbortController()
    const original = chromium.launch
    chromium.launch = (() =>
      Promise.resolve({
        newContext: () =>
          Promise.resolve({
            newPage: () =>
              Promise.resolve({
                setContent: () => {
                  stop.abort()
                  return Promise.reject(new Error("Target closed"))
                },
                screenshot: () => Promise.resolve(Buffer.alloc(0)),
              }),
            close: () => Promise.resolve(),
          }),
        close: () => {
          closed.push("browser")
          return closed.length > 1
            ? Promise.resolve()
            : Promise.reject(new Error("already closing"))
        },
      })) as unknown as typeof chromium.launch
    try {
      await expect(
        withMediaSignal(stop.signal, () =>
          renderPngs([{ html: "<p>x</p>", path: "/never.png" }]),
        ),
      ).rejects.toThrow("Target closed")
    } finally {
      chromium.launch = original
    }
    // Once by the stop (its failure ignored), once by the render's finally.
    expect(closed).toEqual(["browser", "browser"])
  })
})

test("the producers run under the request's own signal", async () => {
  const stop = new AbortController()
  stop.abort()
  const kit = createVideoKit()
  const env = { FLOWREEL_VIDEO: "off" }
  // Video off: no tool runs either way; the signal is simply passed down.
  expect(
    await produceVideo(
      {
        module: "orders",
        runId: "r1",
        target: "local",
        dir: "/tmp/none",
        startedAt: new Date(),
        verdict: "PASS",
        verdictReason: "",
        flow: null,
        table: [],
        latenciesMs: {},
        signal: stop.signal,
      },
      kit,
      env,
    ),
  ).toMatchObject({ produced: false })
  expect(
    await produceTourVideos(
      {
        runId: "r1",
        target: "local",
        pace: "qa",
        dir: "/tmp/none",
        startedAt: new Date(),
        verdict: "PASS",
        features: [],
        signal: stop.signal,
      },
      kit,
      { module: "tour", areas: [], startPersona: "agent" } as never,
      env,
    ),
  ).toMatchObject({ produced: false })
})
