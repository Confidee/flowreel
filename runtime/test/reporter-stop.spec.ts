// SPDX-License-Identifier: Apache-2.0

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "@playwright/test"
import type { FullResult } from "@playwright/test/reporter"

import {
  type AppAdapter,
  createGlobalSetup,
  createGlobalTeardown,
} from "../src/app/index.js"
import { resetRunLifecycle, runLifecycle } from "../src/app/lifecycle.js"
import {
  type RoundTripModule,
  SummaryReporter,
  type SummaryReporterOptions,
  type TourModule,
} from "../src/reporter/index.js"
import type {
  TourVideoOutcome,
  TourVideoRequest,
  VideoOutcome,
  VideoRequest,
} from "../src/video/index.js"

// The summary reporter when a run is stopped: a stop signal during video
// composition ends it (the summary says so), a deadline too close skips it,
// and the sign-out safety net signs the personas out when the global
// teardown was cut short.

test.describe.configure({ mode: "serial" })
test.afterEach(() => resetRunLifecycle())

const RUN_ID = "loc-20261019-1200-stop"

const ROUND_TRIP: RoundTripModule = {
  kind: "round-trip",
  name: "orders",
  project: "orders",
  planStepPattern: /^\|\s*(S\d+ [^|]*?)\s*\|/gm,
  verdictCopy: {
    passed: "Every round-trip step passed.",
    notInRun: "The round trip was not part of this run.",
    skipped: "round-trip test skipped",
  },
}

const TOUR: TourModule = {
  kind: "tour",
  name: "orders-tour",
  isProject: (p) => /^tour-[a-c]$/.test(p),
  areaOfProject: (p) => /^tour-([a-c])$/.exec(p)?.[1].toUpperCase() ?? null,
  parseFeatureTitle: (t) => {
    const m = /^([A-C]\d{1,2})\s+(\S.*)$/.exec(t.trim())
    return m ? { id: m[1], slug: m[2] } : null
  },
  parseStepTitle: () => null,
  featureAnnotation: "tour-feature",
  devOnlyPrefix: "development only: ",
}

/** Never settles: a composition that would run until it is stopped. */
const forever = <T>() => new Promise<T>(() => undefined)

function harness(over: Partial<SummaryReporterOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "flowreel-rep-stop-"))
  const lines: string[] = []
  const videoRequests: VideoRequest[] = []
  const tourRequests: TourVideoRequest[] = []
  const options: SummaryReporterOptions = {
    modules: [ROUND_TRIP, TOUR],
    config: { results: join(root, "results"), logPrefix: "ex" },
    repoRoot: root,
    setupLocation: "e2e/global-setup.ts:1",
    runId: () => RUN_ID,
    configuredTarget: () => "staging",
    describeConfig: () => ({ target: "staging" }),
    videoPace: () => ({
      pace: "demo",
      slowFactor: 2,
      narration: { on: true, voice: "x" } as never,
    }),
    produceVideo: (req) => {
      videoRequests.push(req)
      return Promise.resolve({ produced: false, reason: "video off" })
    },
    produceTourVideos: (req) => {
      tourRequests.push(req)
      return Promise.resolve({ produced: false, reason: "video off" })
    },
    gitSha: () => "abc1234",
    log: (line) => lines.push(line),
    ...over,
  }
  // A test worker always has a SIGINT listener of its own: say whether
  // Playwright's runner "owns" Ctrl-C right now explicitly.
  const owned = { elsewhere: false }
  class TestReporter extends SummaryReporter {
    protected override signalOwnedElsewhere(): boolean {
      return owned.elsewhere
    }
  }
  const reporter = new TestReporter(options)
  const dir = join(root, "results", RUN_ID)
  return {
    root,
    dir,
    lines,
    videoRequests,
    tourRequests,
    reporter,
    owned,
    summary: () =>
      JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")) as {
        video: { produced: boolean; reason?: string }
        narration: { produced: boolean; reason?: string }
        tourVideo: unknown
        runStatus: string
      },
    done: () => rmSync(root, { recursive: true, force: true }),
  }
}

/** A run with a runner error (enough for onEnd to write a summary). */
function failedRun(h: ReturnType<typeof harness>) {
  h.reporter.onBegin()
  h.reporter.onError({ message: "boom" })
}

/** A tour run with one feature that ran. */
function tourRun(h: ReturnType<typeof harness>) {
  h.reporter.onBegin()
  h.reporter.onTestEnd(
    {
      id: "t1",
      title: "A1 create a note",
      location: { file: "/abs/a1.spec.ts", line: 3, column: 1 },
      annotations: [],
      parent: { project: () => ({ name: "tour-a" }) },
    } as never,
    {
      status: "passed",
      duration: 10,
      steps: [],
      attachments: [],
      annotations: [
        {
          type: "tour-feature",
          description: JSON.stringify({ policy: "both", mode: "full" }),
        },
      ],
    } as never,
  )
}

/** Sets env vars for the body, then restores them. */
async function withEnv<T>(
  set: Record<string, string>,
  body: () => Promise<T>,
): Promise<T> {
  const before = Object.fromEntries(
    Object.keys(set).map((k) => [k, process.env[k]]),
  )
  Object.assign(process.env, set)
  try {
    return await body()
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

test.describe("a stop signal during video composition", () => {
  test("SIGINT ends the round trip's composition; the summary says so; the listeners are gone after", async () => {
    let seen: AbortSignal | undefined
    const h = harness({
      produceVideo: (req) => {
        seen = req.signal
        setTimeout(() => process.emit("SIGINT", "SIGINT"), 20)
        return forever<VideoOutcome>()
      },
    })
    try {
      const before = process.listenerCount("SIGINT")
      failedRun(h)
      // From onBegin on, a Ctrl-C no longer kills the process.
      expect(process.listenerCount("SIGINT")).toBeGreaterThan(before)
      await h.reporter.onEnd({ status: "interrupted" } as FullResult)
      expect(process.listenerCount("SIGINT")).toBe(before)
      expect(seen?.aborted).toBe(true)
      expect(h.summary()).toMatchObject({
        runStatus: "interrupted",
        video: {
          produced: false,
          reason: "video composition stopped (interrupted)",
        },
        narration: {
          produced: false,
          reason: "video composition stopped (interrupted)",
        },
      })
      expect(h.lines).toContain(
        "[ex] video: not produced (video composition stopped (interrupted))",
      )
    } finally {
      h.done()
    }
  })

  test("SIGTERM ends the tour's composition", async () => {
    const h = harness({
      produceTourVideos: (req) => {
        setTimeout(() => process.emit("SIGTERM", "SIGTERM"), 20)
        void req
        return forever<TourVideoOutcome>()
      },
    })
    try {
      tourRun(h)
      await h.reporter.onEnd({ status: "passed" } as FullResult)
      expect(h.summary()).toMatchObject({
        video: { reason: "video composition stopped (interrupted)" },
        tourVideo: { reason: "video composition stopped (interrupted)" },
      })
    } finally {
      h.done()
    }
  })

  test("a signal before composition starts skips it; a composer that throws still throws", async () => {
    const h = harness()
    try {
      failedRun(h)
      // The signal arrives during the sign-out safety net.
      runLifecycle().signOut = () => {
        process.emit("SIGINT", "SIGINT")
        return Promise.resolve()
      }
      await h.reporter.onEnd({ status: "failed" } as FullResult)
      expect(h.videoRequests).toEqual([])
      expect(h.summary().video.reason).toBe(
        "video composition stopped (interrupted)",
      )
    } finally {
      h.done()
    }
    const t = harness({
      produceVideo: () => Promise.reject(new Error("composer bug")),
    })
    try {
      failedRun(t)
      await expect(
        t.reporter.onEnd({ status: "failed" } as FullResult),
      ).rejects.toThrow("composer bug")
    } finally {
      t.done()
    }
  })

  test("the composer gets the signal; one that finishes is used as it is", async () => {
    const h = harness()
    try {
      failedRun(h)
      await h.reporter.onEnd({ status: "failed" } as FullResult)
      expect(h.videoRequests[0].signal).toBeInstanceOf(AbortSignal)
      expect(h.videoRequests[0].signal?.aborted).toBe(false)
      expect(h.summary().video.reason).toBe("video off")
    } finally {
      h.done()
    }
  })
})

test.describe("stop signals between Playwright's teardown and this reporter's onEnd", () => {
  test("one that lands while the other reporters finish is caught: no composition, the summary is still written", async () => {
    const h = harness()
    try {
      failedRun(h)
      // The list and HTML reporters' onEnd run here, before this one's.
      process.emit("SIGINT", "SIGINT")
      await h.reporter.onEnd({ status: "passed" } as FullResult)
      expect(h.videoRequests).toEqual([])
      expect(h.summary().video.reason).toBe(
        "video composition stopped (interrupted)",
      )
    } finally {
      h.done()
    }
  })

  test("while Playwright's runner handles Ctrl-C (the tests run), a signal is left to it", async () => {
    const h = harness()
    try {
      failedRun(h)
      h.owned.elsewhere = true
      process.emit("SIGINT", "SIGINT")
      process.emit("SIGTERM", "SIGTERM")
      h.owned.elsewhere = false
      await h.reporter.onEnd({ status: "interrupted" } as FullResult)
      expect(h.videoRequests).toHaveLength(1)
    } finally {
      h.done()
    }
  })

  test("a second Ctrl-C a second or more after the first exits 130; one sooner, or a SIGTERM, does not", async () => {
    const h = harness()
    const exits: number[] = []
    const realExit = process.exit
    process.exit = ((code: number) => {
      exits.push(code)
    }) as never
    try {
      failedRun(h)
      process.emit("SIGINT", "SIGINT")
      process.emit("SIGINT", "SIGINT")
      await new Promise((r) => setTimeout(r, 1050))
      process.emit("SIGTERM", "SIGTERM")
      expect(exits).toEqual([])
      process.emit("SIGINT", "SIGINT")
      expect(exits).toEqual([130])
      expect(h.lines).toContain("[ex] second Ctrl-C: stopping now.")
    } finally {
      process.exit = realExit
      await h.reporter.onExit()
      h.done()
    }
  })

  test("onExit removes the listeners; a second onBegin adds none twice", async () => {
    const h = harness()
    try {
      const before = process.listenerCount("SIGTERM")
      h.reporter.onBegin()
      h.reporter.onBegin()
      expect(process.listenerCount("SIGTERM")).toBe(before + 1)
      await h.reporter.onExit()
      expect(process.listenerCount("SIGTERM")).toBe(before)
    } finally {
      h.done()
    }
  })

  test("by default, Ctrl-C is the runner's while any listener but flowreel's passive ones exists", () => {
    class Probe extends SummaryReporter {
      probe() {
        return this.signalOwnedElsewhere()
      }
    }
    const root = mkdtempSync(join(tmpdir(), "flowreel-rep-probe-"))
    const saved = process.listeners("SIGINT")
    try {
      const probe = new Probe({
        modules: [ROUND_TRIP],
        resultsDir: () => root,
        repoRoot: root,
        setupLocation: "x:1",
        describeConfig: () => ({}),
        videoPace: () => ({
          pace: "qa",
          slowFactor: 1,
          narration: { on: false, reason: "off" },
        }),
        produceVideo: () => Promise.resolve({ produced: false, reason: "x" }),
      })
      process.removeAllListeners("SIGINT")
      expect(probe.probe()).toBe(false)
      probe.onBegin()
      // Its own listener is passive: still nobody else's.
      expect(probe.probe()).toBe(false)
      const other = () => undefined
      process.on("SIGINT", other)
      expect(probe.probe()).toBe(true)
      process.off("SIGINT", other)
      void probe.onExit()
    } finally {
      process.removeAllListeners("SIGINT")
      for (const listener of saved) process.on("SIGINT", listener)
      rmSync(root, { recursive: true, force: true })
    }
  })
})

test.describe("the pipeline's deadline", () => {
  test("too close: composition is skipped and says why", async () => {
    const h = harness()
    try {
      failedRun(h)
      await withEnv({ FLOWREEL_DEADLINE_AT: String(Date.now() + 30_000) }, () =>
        h.reporter.onEnd({ status: "failed" } as FullResult),
      )
      expect(h.videoRequests).toEqual([])
      expect(h.summary().video).toEqual({
        produced: false,
        reason: "skipped: not enough time before the deadline",
      })
    } finally {
      h.done()
    }
  })

  test("FLOWREEL_COMPOSE_BUDGET_SEC tunes the budget; far enough away composes", async () => {
    const h = harness()
    try {
      failedRun(h)
      await withEnv(
        {
          FLOWREEL_DEADLINE_AT: String(Date.now() + 30_000),
          FLOWREEL_COMPOSE_BUDGET_SEC: "10",
        },
        () => h.reporter.onEnd({ status: "failed" } as FullResult),
      )
      expect(h.videoRequests).toHaveLength(1)
    } finally {
      h.done()
    }
    const far = harness()
    try {
      failedRun(far)
      await withEnv(
        { FLOWREEL_DEADLINE_AT: String(Date.now() + 3_600_000) },
        () => far.reporter.onEnd({ status: "failed" } as FullResult),
      )
      expect(far.videoRequests).toHaveLength(1)
    } finally {
      far.done()
    }
  })
})

test.describe("the sign-out safety net", () => {
  test("signs the personas out when the teardown never ran, after pending restores, and says so", async () => {
    const h = harness()
    const events: string[] = []
    try {
      mkdirSync(h.dir, { recursive: true })
      const ledger = (status: string) =>
        JSON.stringify({
          runId: RUN_ID,
          entries: [{ id: "u1", seq: 1, status }],
        })
      writeFileSync(join(h.dir, "undo.json"), ledger("pending"))
      setTimeout(() => {
        events.push("restored")
        writeFileSync(join(h.dir, "undo.json"), ledger("restored"))
      }, 300)
      const state = runLifecycle()
      state.setup = Promise.resolve()
      state.signOut = () => {
        events.push("signed out")
        return Promise.resolve()
      }
      failedRun(h)
      await h.reporter.onEnd({ status: "interrupted" } as FullResult)
      expect(events).toEqual(["restored", "signed out"])
      expect(state.signedOut).toBe(true)
      expect(h.lines[0]).toBe(
        "[ex] WARNING: the global teardown did not sign the personas out (the run was stopped before it could): signing them out now.",
      )
    } finally {
      h.done()
    }
  })

  test("runs even for a run that leaves no evidence folder", async () => {
    const h = harness()
    let calls = 0
    try {
      runLifecycle().signOut = () => {
        calls++
        return Promise.resolve()
      }
      expect(
        await h.reporter.onEnd({ status: "interrupted" } as FullResult),
      ).toBeUndefined()
      expect(calls).toBe(1)
    } finally {
      h.done()
    }
  })

  test("does nothing when the teardown signed out, or nothing was registered", async () => {
    const h = harness()
    let calls = 0
    try {
      failedRun(h)
      const state = runLifecycle()
      state.signOut = () => {
        calls++
        return Promise.resolve()
      }
      state.signedOut = true
      await h.reporter.onEnd({ status: "failed" } as FullResult)
      resetRunLifecycle()
      await h.reporter.onEnd({ status: "failed" } as FullResult)
      expect(calls).toBe(0)
      expect(h.lines.some((l) => l.includes("WARNING"))).toBe(false)
    } finally {
      h.done()
    }
  })

  test("a teardown still waiting for sign-ins (cut short) is waited for, never repeated: one sign-out", async () => {
    const h = harness()
    const signOuts: string[] = []
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const hooks = {
      load: () => ({
        target: "local" as const,
        baseURL: "http://h",
        keys: ["agent"] as const,
        persona: () => ({ email: "a@example.test", password: "x" }),
      }),
      adapter: {
        signIn: async () => {
          await gate
          return { cookies: [], origins: [] }
        },
        needsBrowser: () => false,
        signOut: () => {
          signOuts.push("agent")
          return Promise.resolve({ revoked: true, detail: "ok" })
        },
        isSignedOut: () => false,
      } as AppAdapter<"agent">,
      prefix: "REPSTOP_",
      logPrefix: "ex",
    }
    const log = console.log
    console.log = () => undefined
    try {
      const setup = createGlobalSetup(hooks)()
      await new Promise((r) => setTimeout(r, 5))
      // Playwright starts the teardown, then gives up on it (cut short).
      const teardown = createGlobalTeardown(hooks)()
      failedRun(h)
      const ended = h.reporter.onEnd({ status: "interrupted" } as FullResult)
      await new Promise((r) => setTimeout(r, 30))
      release()
      await Promise.all([setup, teardown, ended])
      expect(signOuts).toEqual(["agent"])
      expect(h.lines.some((l) => l.includes("WARNING"))).toBe(false)
    } finally {
      console.log = log
      delete process.env.REPSTOP_AGENT
      h.done()
    }
  })

  test("a teardown sign-out that was cut short but finishes is not repeated", async () => {
    const h = harness()
    let calls = 0
    try {
      const state = runLifecycle()
      state.signOut = () => {
        calls++
        return Promise.resolve()
      }
      state.signOutRun = new Promise((r) => setTimeout(r, 30))
      failedRun(h)
      await h.reporter.onEnd({ status: "interrupted" } as FullResult)
      expect(calls).toBe(0)
    } finally {
      h.done()
    }
  })

  test("a pending restore that never finishes is named; a failed sign-out is a loud warning", async () => {
    const h = harness()
    try {
      mkdirSync(h.dir, { recursive: true })
      writeFileSync(
        join(h.dir, "undo.json"),
        JSON.stringify({
          runId: RUN_ID,
          entries: [
            {
              id: "u1",
              seq: 1,
              feature: "A1",
              what: "a setting",
              before: 1,
              manual: "put it back",
              status: "pending",
              error: null,
              recordedAt: "2026-10-19T12:00:00Z",
              restoredAt: null,
            },
          ],
        }),
      )
      const state = runLifecycle()
      // #26: the warning keeps the first line, never a call log.
      state.signOut = () =>
        Promise.reject(
          new Error("HTTP 500\nCall log:\n  - cookie: s=COOKIE-SECRET"),
        )
      failedRun(h)
      // A Ctrl-C during the wait ends it at once.
      setTimeout(() => process.emit("SIGINT", "SIGINT"), 50)
      await h.reporter.onEnd({ status: "interrupted" } as FullResult)
      expect(h.lines).toContain(
        "[ex] 1 shared-config restore(s) still pending; signing out anyway (undo.md lists them).",
      )
      expect(h.lines).toContain(
        "[ex] WARNING: the sign-out failed (HTTP 500): sign the personas out on staging (or wait for the session idle timeout) before sharing anything but summary.md.",
      )
      expect(h.lines.join("\n")).not.toContain("COOKIE-SECRET")
      expect(state.signedOut).toBe(false)
      const text = harness()
      try {
        resetRunLifecycle()
        runLifecycle().signOut = () => Promise.reject("plain text")
        failedRun(text)
        await text.reporter.onEnd({ status: "failed" } as FullResult)
        expect(text.lines.some((l) => l.includes("failed (plain text)"))).toBe(
          true,
        )
      } finally {
        text.done()
      }
    } finally {
      h.done()
    }
  })
})
