// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "@playwright/test"

import { demosCli } from "../src/cli/demos.js"
import { TimeoutError } from "../src/core/errors.js"
import { poll } from "../src/core/poll.js"
import { fileCounter, nextRoundRobin } from "../src/run/counter.js"

// Defaults and edges of the small helpers: the console defaults of the
// demos command, poll's real clock, and the counter's non-ENOENT failure.

function capture() {
  const lines = { log: [] as string[], error: [] as string[] }
  const log = console.log
  const error = console.error
  console.log = (line: string) => lines.log.push(String(line))
  console.error = (line: string) => lines.error.push(String(line))
  return {
    lines,
    restore() {
      console.log = log
      console.error = error
    },
  }
}

test.describe("demos command defaults", () => {
  const base = {
    parseRunIdArg: (raw: string | undefined) => raw ?? null,
    publish: () => ({
      published: true as const,
      files: ["a.mp4", "b.mp4"],
      dir: "/repo/demos/latest",
    }),
    rootDir: "/repo",
    usage: "Usage: demos <RUN_ID>",
  }

  test("writes the outcome line to console.log and failures to console.error", () => {
    const out = capture()
    try {
      expect(demosCli(["r1"], base)).toBe(0)
      expect(
        demosCli(["r1"], {
          ...base,
          publish: () => ({ published: false as const, reason: "no videos" }),
        }),
      ).toBe(1)
      expect(demosCli([], base)).toBe(64)
    } finally {
      out.restore()
    }
    expect(out.lines.log).toEqual([
      "[demos] r1: a.mp4, b.mp4 -> demos/latest/ (README.md updated)",
    ])
    expect(out.lines.error).toEqual([
      "[demos] r1: nothing published (no videos)",
      "Usage: demos <RUN_ID>",
    ])
  })
})

test.describe("poll with the real clock", () => {
  test("returns the value, with the default sleep between attempts", async () => {
    let attempts = 0
    const value = await poll(
      () =>
        Promise.resolve(
          ++attempts < 3 ? { observed: "warming" } : { value: "ready" },
        ),
      { waitingFor: "ready", timeoutMs: 5_000, initialIntervalMs: 1 },
    )
    expect(value).toBe("ready")
    expect(attempts).toBe(3)
  })

  test("times out with the last observation, using the default clock", async () => {
    const error = await poll(
      () => Promise.resolve({ observed: "still cold" }),
      {
        waitingFor: "the kettle",
        timeoutMs: 20,
        initialIntervalMs: 5,
      },
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TimeoutError)
    expect((error as Error).message).toContain("the kettle")
    expect((error as Error).message).toContain("still cold")
  })
})

test.describe("poll intervals", () => {
  test("the delay doubles up to the maximum and never overshoots the deadline", async () => {
    let now = 0
    const slept: number[] = []
    const error = await poll(() => Promise.resolve({ observed: "waiting" }), {
      waitingFor: "x",
      timeoutMs: 20_000,
      initialIntervalMs: 3_000,
      maxIntervalMs: 7_000,
      sleep: (ms) => {
        slept.push(ms)
        now += ms
        return Promise.resolve()
      },
      now: () => now,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TimeoutError)
    expect(slept).toEqual([3_000, 6_000, 7_000, 4_000])
  })

  test("an attempt that throws is not retried", async () => {
    let attempts = 0
    await expect(
      poll(
        () => {
          attempts++
          return Promise.reject(new Error("HTTP 500"))
        },
        { waitingFor: "x", timeoutMs: 1_000, sleep: () => Promise.resolve() },
      ),
    ).rejects.toThrow("HTTP 500")
    expect(attempts).toBe(1)
  })
})

test.describe("fileCounter", () => {
  test("an unreadable counter that is not merely missing is an error, not a silent restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "flowreel-counter-"))
    try {
      expect(() => fileCounter(dir).read()).toThrow(/EISDIR/)
      expect(() => nextRoundRobin(["a", "b"], fileCounter(dir))).toThrow(
        /EISDIR/,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("creates its folder on first write and rotates", () => {
    const dir = mkdtempSync(join(tmpdir(), "flowreel-counter-"))
    try {
      const path = join(dir, "nested", "n")
      const store = fileCounter(path)
      expect(store.read()).toBeUndefined()
      expect(nextRoundRobin(["a", "b"], store)).toBe("a")
      expect(nextRoundRobin(["a", "b"], store)).toBe("b")
      expect(nextRoundRobin(["a", "b"], store)).toBe("a")
      expect(readFileSync(path, "utf8")).toBe("1")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
