// SPDX-License-Identifier: Apache-2.0

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"

import type { APIRequest } from "@playwright/test"
import { expect, test } from "@playwright/test"
import type {
  FullResult,
  TestCase,
  TestResult,
  TestStep,
} from "@playwright/test/reporter"

import type { PublishOptions } from "../src/demos/index.js"
import {
  NO_FEATURE_REASON,
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

// The summary reporter driven with recorded Playwright events: no browser,
// no runner. Each test gets its own folder as the repo root.

const RUN_ID = "loc-20261014-1200-abcd"

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
  isProject: (p) => p === "tour-setup" || /^tour-[a-c]$/.test(p),
  areaOfProject: (p) => /^tour-([a-c])$/.exec(p)?.[1].toUpperCase() ?? null,
  parseFeatureTitle: (t) => {
    const m = /^([A-C]\d{1,2})\s+(\S.*)$/.exec(t.trim())
    return m ? { id: m[1], slug: m[2] } : null
  },
  parseStepTitle: (t) => {
    const m = /^([A-C]\d{1,2})\.(\d{1,2})\s+(\S.*)$/.exec(t.trim())
    return m ? { feature: m[1], n: Number(m[2]), sentence: m[3] } : null
  },
  featureAnnotation: "tour-feature",
  devOnlyPrefix: "development only: ",
}

interface Harness {
  root: string
  dir: string
  lines: string[]
  videoRequests: VideoRequest[]
  tourRequests: TourVideoRequest[]
  published: { runDir: string; options: PublishOptions }[]
  reporter: SummaryReporter
}

function harness(
  over:
    | Partial<SummaryReporterOptions>
    | ((runDir: string) => Partial<SummaryReporterOptions>) = {},
  video: VideoOutcome = { produced: false, reason: "video off" },
  tourVideo: TourVideoOutcome = { produced: false, reason: "video off" },
): Harness {
  const root = mkdtempSync(join(tmpdir(), "flowreel-reporter-"))
  const h: Omit<Harness, "reporter"> = {
    root,
    dir: join(root, "results", RUN_ID),
    lines: [],
    videoRequests: [],
    tourRequests: [],
    published: [],
  }
  const planFile = join(root, "plan.md")
  writeFileSync(
    planFile,
    [
      "| Step | What |",
      "|---|---|",
      "| S1 send | x |",
      "| S2 reply | y |",
    ].join("\n"),
  )
  const options: SummaryReporterOptions = {
    modules: [{ ...ROUND_TRIP, planFile }, TOUR],
    config: { results: join(root, "results"), logPrefix: "example" },
    tabulatedProjects: ["preflight"],
    repoRoot: root,
    preflightFile: "preflight.json",
    setupLocation: "e2e/global-setup.ts:1",
    runId: () => RUN_ID,
    configuredTarget: () => "local",
    envTarget: () => undefined,
    describeConfig: () => ({ target: "local", secret: "[redacted]" }),
    videoPace: () => ({
      pace: "qa",
      slowFactor: 1,
      narration: { on: false, reason: "narration off" },
    }),
    produceVideo: (req) => {
      h.videoRequests.push(req)
      return Promise.resolve(video)
    },
    produceTourVideos: (req) => {
      h.tourRequests.push(req)
      return Promise.resolve(tourVideo)
    },
    publishDemos: (runDir, options) => {
      h.published.push({ runDir, options })
      return { published: false, reason: "test" }
    },
    copy: { title: "Example QA" },
    gitSha: () => "abc1234",
    log: (line) => h.lines.push(line),
    ...(typeof over === "function" ? over(h.dir) : over),
  }
  try {
    return { ...h, reporter: new SummaryReporter(options) }
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

function testCase(
  project: string,
  title: string,
  annotations: TestCase["annotations"] = [],
): TestCase {
  return {
    id: `${project}:${title}`,
    title,
    location: { file: "/abs/flows/x.spec.ts", line: 10, column: 1 },
    annotations,
    parent: { project: () => ({ name: project }) },
  } as unknown as TestCase
}

const SPEC_FILE = "/abs/flows/x.spec.ts"

function step(title: string, over: Partial<TestStep> = {}): TestStep {
  return {
    title,
    category: "test.step",
    startTime: new Date(1_000),
    duration: 500,
    location: { file: SPEC_FILE, line: 20, column: 3 },
    steps: [],
    ...over,
  } as unknown as TestStep
}

function result(
  status: TestResult["status"],
  steps: TestStep[] = [],
  over: Partial<TestResult> = {},
): TestResult {
  return {
    status,
    steps,
    duration: 2_000,
    startTime: new Date(500),
    attachments: [],
    annotations: [],
    ...over,
  } as unknown as TestResult
}

const fact = (stepId: string, key: string, value: unknown) => ({
  type: "qa",
  description: JSON.stringify({ step: stepId, key, value }),
})

/** The parts of summary.json these tests read. */
interface SummaryJson {
  [key: string]: unknown
  verdict: string
  verdictReason: string
  module: string
  target: string
  config: unknown
  preflight: unknown
  video: unknown
  demos: unknown
  narration: { voice?: string }
  tests: {
    steps: {
      id: string
      status: string
      durationMs: number | null
      facts: Record<string, unknown>
    }[]
  }[]
  features: { id: string; status: string; reason: string | null }[]
}

function readSummary(dir: string): SummaryJson {
  return JSON.parse(
    readFileSync(join(dir, "summary.json"), "utf8"),
  ) as SummaryJson
}

const passed = { status: "passed" } as FullResult
const failed = { status: "failed" } as FullResult

test.describe("the round trip", () => {
  test("PASS: every plan step in the table, facts, latencies, the video request", async () => {
    const h = harness()
    try {
      h.reporter.onBegin()
      h.reporter.onTestEnd(
        testCase("orders", "round trip", [
          fact("S1 send", "latency.sendMs", 1_200),
          fact("S1 send", "subject", "Hello | world"),
          { type: "qa", description: "{not json" },
          { type: "could-not-check", description: "the bell (no push)" },
        ]),
        result("passed", [step("S1 send"), step("hook", { category: "hook" })]),
      )
      expect(await h.reporter.onEnd(passed)).toBeUndefined()
      const s = readSummary(h.dir)
      expect(s).toMatchObject({
        runId: RUN_ID,
        target: "local",
        module: "orders",
        verdict: "PASS",
        verdictReason: "Every round-trip step passed.",
        gitSha: "abc1234",
        config: { target: "local", secret: "[redacted]" },
        preflight: null,
        latenciesMs: { sendMs: 1_200 },
        couldNotCheck: ["the bell (no push)"],
        htmlReport: join("results", RUN_ID, "report", "index.html"),
        resultsDir: join("results", RUN_ID),
        video: { produced: false, reason: "video off" },
        features: [],
        undo: { total: 0, file: null, manual: [] },
        tourVideo: null,
        pace: { pace: "qa", slowFactor: 1 },
        narration: { produced: false, reason: "narration off" },
        demos: null,
      })
      expect(Object.keys(s)).toEqual([
        "runId",
        "target",
        "module",
        "verdict",
        "verdictReason",
        "runStatus",
        "startedAt",
        "finishedAt",
        "gitSha",
        "config",
        "preflight",
        "tests",
        "latenciesMs",
        "couldNotCheck",
        "errors",
        "attachments",
        "htmlReport",
        "resultsDir",
        "video",
        "features",
        "undo",
        "tourVideo",
        "pace",
        "narration",
        "demos",
      ])
      expect(
        s.tests[0].steps.map((x: { id: string; status: string }) => [
          x.id,
          x.status,
        ]),
      ).toEqual([
        ["S1 send", "passed"],
        ["S2 reply", "not run"],
      ])
      expect(s.tests[0].steps[0]).toMatchObject({
        file: relative(h.root, SPEC_FILE),
        line: 20,
        facts: { "latency.sendMs": 1_200, subject: "Hello | world" },
      })
      expect(readFileSync(join(h.dir, "summary.lines"), "utf8")).toBe("")
      const md = readFileSync(join(h.dir, "summary.md"), "utf8")
      expect(md.split("\n")[0]).toBe(`# Example QA ${RUN_ID}: PASS`)
      expect(md).toContain(
        "| S1 send | passed | 0.5s | latency.sendMs=1200; subject=Hello \\| world |",
      )
      expect(md).toContain("- sendMs: 1.2s")
      expect(md).toContain("- the bell (no push)")
      expect(md).toContain("| Video | video: not produced (video off) |")
      expect(md).toContain("| Narration | not produced (narration off) |")
      // The video gets the recording and the full table.
      expect(h.videoRequests).toHaveLength(1)
      expect(h.videoRequests[0]).toMatchObject({
        module: "orders",
        runId: RUN_ID,
        verdict: "PASS",
        flow: {
          status: "passed",
          videoPath: null,
          log: null,
          steps: [
            { id: "S1 send", durationMs: 500, failed: false, error: null },
          ],
        },
        table: [
          { id: "S1 send", status: "passed", durationMs: 500 },
          { id: "S2 reply", status: "not run", durationMs: null },
        ],
        latenciesMs: { sendMs: 1_200 },
      })
      expect(h.tourRequests).toEqual([])
      expect(h.lines).toEqual([
        `[example] PASS: Every round-trip step passed. Summary: ${join("results", RUN_ID, "summary.md")}`,
        "[example] video: not produced (video off)",
        "[example] pace: qa (slow factor 1); narration: not produced (narration off)",
      ])
    } finally {
      rmSync(h.root, { recursive: true, force: true })
    }
  })

  test("N/A: a skip with an N/A reason; plan steps are skipped", async () => {
    const h = harness()
    try {
      h.reporter.onTestEnd(
        testCase("orders", "round trip", [
          { type: "skip", description: "N/A: no mailbox configured" },
        ]),
        result("skipped"),
      )
      await h.reporter.onEnd(passed)
      const s = readSummary(h.dir)
      expect(s.verdict).toBe("N/A")
      expect(s.verdictReason).toBe("no mailbox configured")
      expect(s.tests[0].steps.map((x: { status: string }) => x.status)).toEqual(
        ["skipped", "skipped"],
      )
    } finally {
      rmSync(h.root, { recursive: true, force: true })
    }
  })

  test("N/A when only a preflight ran; the preflight JSON is embedded", async () => {
    const h = harness()
    try {
      mkdirSync(h.dir, { recursive: true })
      writeFileSync(join(h.dir, "preflight.json"), '{"ok":true}')
      h.reporter.onTestEnd(testCase("preflight", "P1"), result("passed"))
      await h.reporter.onEnd(passed)
      const s = readSummary(h.dir)
      expect(s.verdict).toBe("N/A")
      expect(s.verdictReason).toBe("The round trip was not part of this run.")
      expect(s.preflight).toEqual({ ok: true })
    } finally {
      rmSync(h.root, { recursive: true, force: true })
    }
  })

  test("FAIL: one line per failed step, the open step, runner errors at the setup location", async () => {
    const h = harness()
    try {
      h.reporter.onTestEnd(
        testCase("orders", "round trip"),
        result(
          "timedOut",
          [
            step("S1 send", {
              error: {
                message: "\u001b[31mexpected 1\u001b[39m\nreceived 2",
                location: { file: SPEC_FILE, line: 33, column: 5 },
              },
            }),
            step("S2 reply", { duration: -1 }),
          ],
          { error: { message: "Test timeout of 2000ms exceeded." } },
        ),
      )
      h.reporter.onError({ message: "global setup broke" })
      expect(await h.reporter.onEnd(failed)).toBeUndefined()
      const s = readSummary(h.dir)
      expect(s.verdict).toBe("FAIL")
      expect(s.verdictReason).toBe("Failed: orders: round trip.")
      const lines = readFileSync(join(h.dir, "summary.lines"), "utf8")
        .trim()
        .split("\n")
      expect(lines).toHaveLength(3)
      expect(lines[0]).toMatch(/x\.spec\.ts:33: error: \[S1 send\] expected 1$/)
      expect(lines[1]).toMatch(
        /x\.spec\.ts:20: error: \[S2 reply\] Test timeout of 2000ms exceeded\.$/,
      )
      expect(lines[2]).toBe(
        "e2e/global-setup.ts:1: error: [setup] global setup broke",
      )
      expect(s.tests[0].steps[1]).toMatchObject({
        status: "failed",
        // Open from 1.0 s until the test ended at 2.5 s.
        durationMs: 1_500,
      })
      expect(h.lines.slice(0, 3)).toEqual(lines)
    } finally {
      rmSync(h.root, { recursive: true, force: true })
    }
  })

  test("another project's failure counts toward the verdict without a row", async () => {
    const h = harness()
    try {
      h.reporter.onTestEnd(testCase("orders", "round trip"), result("passed"))
      h.reporter.onTestEnd(testCase("other", "x"), result("failed"))
      await h.reporter.onEnd(failed)
      const s = readSummary(h.dir)
      expect(s.verdict).toBe("FAIL")
      expect(s.verdictReason).toBe("Failed: run failed.")
      expect(s.tests).toHaveLength(1)
    } finally {
      rmSync(h.root, { recursive: true, force: true })
    }
  })

  test("no tabulated test and no error: no evidence folder", async () => {
    const h = harness()
    try {
      h.reporter.onTestEnd(testCase("other", "x"), result("passed"))
      expect(await h.reporter.onEnd(passed)).toBeUndefined()
      expect(existsSync(h.dir)).toBe(false)
      expect(h.lines).toEqual([])
    } finally {
      rmSync(h.root, { recursive: true, force: true })
    }
  })

  test("an unreadable configuration and target fall back", async () => {
    const h = harness({
      configuredTarget: () => {
        throw new Error("bad config")
      },
      envTarget: () => "staging",
      describeConfig: () => {
        throw new Error("bad config")
      },
    })
    try {
      h.reporter.onTestEnd(testCase("orders", "round trip"), result("passed"))
      await h.reporter.onEnd(passed)
      const s = readSummary(h.dir)
      expect(s.config).toEqual({ unavailable: "bad config" })
      expect(s.target).toBe("staging")
      expect(s.module).toBe("orders")
    } finally {
      rmSync(h.root, { recursive: true, force: true })
    }
  })

  test("defaults: run id and target from FLOWREEL_*, folders from the config", async () => {
    const saved = {
      FLOWREEL_RUN_ID: process.env.FLOWREEL_RUN_ID,
      FLOWREEL_TARGET: process.env.FLOWREEL_TARGET,
    }
    process.env.FLOWREEL_RUN_ID = "loc-20261014-1201-beef"
    process.env.FLOWREEL_TARGET = "staging"
    const h = harness({
      runId: undefined,
      configuredTarget: undefined,
      envTarget: undefined,
      describeConfig: () => ({}),
    })
    try {
      h.reporter.onTestEnd(testCase("orders", "round trip"), result("passed"))
      await h.reporter.onEnd(passed)
      const dir = join(h.root, "results", "loc-20261014-1201-beef")
      const s = readSummary(dir)
      expect(s.runId).toBe("loc-20261014-1201-beef")
      expect(s.target).toBe("staging")
      expect(s.htmlReport).toBe(
        join("results", "loc-20261014-1201-beef", "report", "index.html"),
      )
      expect(h.lines.at(-2)).toBe("[example] video: not produced (video off)")
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      rmSync(h.root, { recursive: true, force: true })
    }
  })

  test("without a run id it is unknown-run; explicit folders win; the prefix defaults to [flowreel]", async () => {
    const h = harness((runDir) => ({
      runId: () => undefined,
      config: undefined,
      resultsDir: (runId) => join(runDir, "..", "custom", runId),
      reportDir: (runId) => join(runDir, "..", "reports", runId),
    }))
    try {
      h.reporter.onTestEnd(testCase("orders", "round trip"), result("passed"))
      await h.reporter.onEnd(passed)
      const s = readSummary(join(h.root, "results", "custom", "unknown-run"))
      expect(s.runId).toBe("unknown-run")
      expect(s.htmlReport).toBe(
        join("results", "reports", "unknown-run", "index.html"),
      )
      expect(h.lines.at(-2)).toBe("[flowreel] video: not produced (video off)")
    } finally {
      rmSync(h.root, { recursive: true, force: true })
    }
  })

  test("the options need a config or a results folder, and one round-trip module", () => {
    expect(() => harness({ config: undefined, resultsDir: undefined })).toThrow(
      "SummaryReporter: give `config` or `resultsDir`.",
    )
    expect(() => harness({ modules: [TOUR] })).toThrow(
      'modules: expected exactly one "round-trip" module, got 0.',
    )
  })

  test("a publisher that throws: recorded as not published, never fatal", async () => {
    const h = harness((runDir) => ({
      videoPace: () => ({
        pace: "demo",
        slowFactor: 1.5,
        narration: { on: false, reason: "off" },
      }),
      produceVideo: () =>
        Promise.resolve({
          produced: true,
          path: join(runDir, "orders-x.mp4"),
          durationSec: 42,
        }),
      publishDemos: () => {
        throw new Error("disk full")
      },
    }))
    try {
      h.reporter.onTestEnd(testCase("orders", "round trip"), result("passed"))
      expect(await h.reporter.onEnd(passed)).toBeUndefined()
      const s = readSummary(h.dir)
      expect(s.verdict).toBe("PASS")
      expect(s.demos).toEqual({ published: false, reason: "disk full" })
      expect(h.lines).toContain("[example] demos: not updated (disk full)")
    } finally {
      rmSync(h.root, { recursive: true, force: true })
    }
  })

  test("a produced demo-pace video: linked, narrated, published automatically", async () => {
    const h = harness((runDir) => ({
      videoPace: () => ({
        pace: "demo",
        slowFactor: 1.5,
        narration: { on: true },
      }),
      produceVideo: () =>
        Promise.resolve({
          produced: true,
          path: join(runDir, "orders-x.mp4"),
          durationSec: 42,
          narration: {
            produced: true,
            engine: "macos",
            voice: "Ava",
            warning: null,
            lines: 3,
            synthesized: 1,
            cached: 2,
          },
          pace: { pace: "demo", slowFactor: 1.5 },
        }),
    }))
    try {
      h.reporter.onTestEnd(testCase("orders", "round trip"), result("passed"))
      await h.reporter.onEnd(passed)
      const s = readSummary(h.dir)
      expect(s.video).toEqual({
        produced: true,
        path: join("results", RUN_ID, "orders-x.mp4"),
        file: "orders-x.mp4",
        durationSec: 42,
      })
      expect(s.narration.voice).toBe("Ava")
      expect(s.demos).toEqual({ published: false, reason: "test" })
      expect(h.published).toEqual([
        { runDir: h.dir, options: { automatic: true } },
      ])
      expect(h.lines).toContain(
        "[example] pace: demo (slow factor 1.5); narration: Ava (3 lines, 1 synthesized, 2 cached). Apple licenses the macOS voices for personal, non-commercial use only (macOS licence §2F); for work or public videos, ask Apple or use another voice.",
      )
      expect(h.lines).toContain("[example] demos: not updated (test)")
    } finally {
      rmSync(h.root, { recursive: true, force: true })
    }
  })

  test("a not-produced video keeps its narration and pace in summary.json", async () => {
    const h = harness(
      {},
      {
        produced: false,
        reason: "ffmpeg missing",
        narration: { produced: false, reason: "no voice" },
        pace: { pace: "qa", slowFactor: 1 },
      },
    )
    try {
      h.reporter.onTestEnd(testCase("orders", "round trip"), result("passed"))
      await h.reporter.onEnd(passed)
      expect(readSummary(h.dir).video).toEqual({
        produced: false,
        reason: "ffmpeg missing",
        narration: { produced: false, reason: "no voice" },
        pace: { pace: "qa", slowFactor: 1 },
      })
      expect(h.published).toEqual([])
    } finally {
      rmSync(h.root, { recursive: true, force: true })
    }
  })

  test("an unrestored undo entry: listed first, and the run does not exit 0", async () => {
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
              feature: "E2",
              what: "group name",
              before: "Support",
              manual: "Rename it back to Support.",
              status: "FAILED",
              error: "500",
              recordedAt: "",
              restoredAt: null,
            },
          ],
        }),
      )
      h.reporter.onTestEnd(testCase("orders", "round trip"), result("passed"))
      expect(await h.reporter.onEnd(passed)).toEqual({ status: "failed" })
      const s = readSummary(h.dir)
      expect(s.undo).toMatchObject({ total: 1, failed: 1, file: "undo.md" })
      const md = readFileSync(join(h.dir, "summary.md"), "utf8").split("\n")
      expect(md[2]).toBe("## UNDO FAILED: manual action needed")
      expect(h.lines[0]).toBe(
        `[example] UNDO FAILED: 1 shared-config change(s) were not put back — manual action needed: ${join("results", RUN_ID, "undo.md")}`,
      )
    } finally {
      rmSync(h.root, { recursive: true, force: true })
    }
  })
})

test.describe("the tour", () => {
  const annotation = (id: string, mode = "full", policy = "both") => ({
    type: "tour-feature",
    description: JSON.stringify({ id, policy, devOnlyReason: null, mode }),
  })

  test("feature rows, the tour verdict, the tour video and its positions", async () => {
    const h = harness(
      {
        videoPace: (module) => ({
          pace: module === "orders-tour" ? "demo" : "qa",
          slowFactor: 1.5,
          narration: { on: false, reason: "off" },
        }),
      },
      undefined,
      {
        produced: true,
        areas: [{ area: "A", path: "/v/tour-a.mp4", durationSec: 10 }],
        tour: { path: "/v/tour.mp4", durationSec: 20 },
        featureStarts: { A1: 4.5 },
      },
    )
    try {
      h.reporter.onTestEnd(testCase("tour-setup", "setup"), result("passed"))
      h.reporter.onTestEnd(
        testCase("tour-a", "A1 list-views"),
        result("passed", [step("A1.1 Views list"), step("raw title")], {
          annotations: [annotation("A1")],
        }),
      )
      h.reporter.onTestEnd(
        testCase("tour-b", "B1 dev-thing", [
          annotation("B1", "full", "dev"),
          { type: "skip", description: "development only: writes mail" },
        ]),
        result("skipped", [], { annotations: [] }),
      )
      expect(await h.reporter.onEnd(passed)).toBeUndefined()
      const s = readSummary(h.dir)
      expect(s.module).toBe("orders-tour")
      expect(s.verdict).toBe("PASS")
      expect(s.verdictReason).toBe(
        "1 tour feature(s) verified, 1 development-only.",
      )
      // B1's annotation lives on the test case (no result annotations).
      expect(s.features).toEqual([
        {
          id: "A1",
          title: "list-views",
          area: "A",
          policy: "both",
          status: "passed",
          reason: null,
          durationMs: 2_000,
          videoAtSec: 4.5,
          file: relative(h.root, SPEC_FILE),
          line: 10,
        },
        expect.objectContaining({
          id: "B1",
          policy: "dev",
          status: "dev-only",
          reason: "writes mail",
          durationMs: null,
        }),
      ])
      expect(s.couldNotCheck).toEqual([
        'A1 list-views: step "raw title" is not titled "A1.<n> <sentence>" (its caption shows the raw title).',
      ])
      expect(h.tourRequests[0]).toMatchObject({
        pace: "demo",
        verdict: s.verdict,
      })
      expect(h.videoRequests).toEqual([])
      expect(s.tourVideo).toMatchObject({
        produced: true,
        tour: { file: expect.stringMatching(/tour\.mp4$/), durationSec: 20 },
      })
      expect(s.video).toMatchObject({ produced: true, durationSec: 20 })
      expect(h.published).toHaveLength(1)
      expect(h.lines).toContainEqual(
        expect.stringMatching(
          /^\[example\] area A video: .*tour-a\.mp4 \(10\.0s\)$/,
        ),
      )
    } finally {
      rmSync(h.root, { recursive: true, force: true })
    }
  })

  test("a feature that passed without feature() fails the run even when Playwright passed", async () => {
    const h = harness()
    try {
      h.reporter.onTestEnd(
        testCase("tour-a", "A2 no-policy"),
        result("passed", [step("A2.1 Something")]),
      )
      expect(await h.reporter.onEnd(passed)).toEqual({ status: "failed" })
      const s = readSummary(h.dir)
      expect(s.verdict).toBe("FAIL")
      expect(s.verdictReason).toBe(`Failed: A2 (${NO_FEATURE_REASON}).`)
      expect(s.features[0]).toMatchObject({
        status: "failed",
        reason: NO_FEATURE_REASON,
      })
    } finally {
      rmSync(h.root, { recursive: true, force: true })
    }
  })

  test("dev-only and N/A reasons; nothing verified is N/A; view-only on staging", async () => {
    const h = harness({ configuredTarget: () => "staging" })
    try {
      h.reporter.onTestEnd(
        testCase("tour-a", "A1 one", [annotation("A1")]),
        result("skipped", [], {
          annotations: [
            annotation("A1"),
            { type: "skip", description: "development only: sends mail" },
          ],
        }),
      )
      h.reporter.onTestEnd(
        testCase("tour-c", "C1 two"),
        result("skipped", [], {
          annotations: [
            annotation("C1"),
            { type: "skip", description: "N/A: not configured" },
          ],
        }),
      )
      await h.reporter.onEnd(passed)
      const s = readSummary(h.dir)
      expect(s.verdict).toBe("N/A")
      expect(s.features.map((f) => [f.status, f.reason])).toEqual([
        ["dev-only", "sends mail"],
        ["N/A", "N/A: not configured"],
      ])
    } finally {
      rmSync(h.root, { recursive: true, force: true })
    }
    const v = harness({ configuredTarget: () => "staging" })
    try {
      v.reporter.onTestEnd(
        testCase("tour-a", "A3 view"),
        result("passed", [step("A3.1 Looks")], {
          annotations: [annotation("A3", "view", "view")],
        }),
      )
      await v.reporter.onEnd(passed)
      const s = readSummary(v.dir)
      expect(s.features[0].status).toBe("view-only")
      expect(s.verdict).toBe("PASS")
    } finally {
      rmSync(v.root, { recursive: true, force: true })
    }
  })

  test("without a tour composer the tour video is not produced", async () => {
    const h = harness({ produceTourVideos: undefined })
    try {
      h.reporter.onTestEnd(
        testCase("tour-a", "A1 one"),
        result("passed", [step("A1.1 x")], { annotations: [annotation("A1")] }),
      )
      await h.reporter.onEnd(passed)
      expect(readSummary(h.dir).video).toEqual({
        produced: false,
        reason: "no tour video composer configured",
      })
    } finally {
      rmSync(h.root, { recursive: true, force: true })
    }
  })
})

test.describe("#26: a Playwright call log never reaches the summary", () => {
  const COOKIE = "SESSION-COOKIE-SECRET-1a2b"
  const FRESH = "FRESH-SESSION-COOKIE-3c4d"

  /**
   * A real Playwright request error: a context holding a session cookie
   * POSTs to a server that sets a fresh one, then never ends the body.
   */
  async function realRequestError(playwright: {
    request: APIRequest
  }): Promise<string> {
    const server = http.createServer((req, res) => {
      req.resume()
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": `_app_session=${FRESH}; Path=/; HttpOnly`,
      })
      res.write('{"ok":')
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as AddressInfo).port
    const context = await playwright.request.newContext({
      baseURL: `http://127.0.0.1:${port}`,
      storageState: {
        cookies: [
          {
            name: "_app_session",
            value: COOKIE,
            domain: "127.0.0.1",
            path: "/",
            expires: -1,
            httpOnly: true,
            secure: false,
            sameSite: "Lax",
          },
        ],
        origins: [],
      },
    })
    try {
      await context.post("/test/sign_in_as?token=QUERY-SECRET", {
        data: { email: "a@x" },
        headers: { "X-CSRF-Token": "CSRF-SECRET" },
        timeout: 300,
      })
      throw new Error("the request did not fail")
    } catch (error) {
      return (error as Error).message
    } finally {
      await context.dispose()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  const SECRETS = [COOKIE, FRESH, "QUERY-SECRET", "CSRF-SECRET", "Call log"]

  test("summary.md, summary.json and summary.lines keep the first line, never the call log", async ({
    playwright,
  }) => {
    const message = await realRequestError(playwright)
    // The premise: Playwright's own message carries every one of them.
    for (const secret of SECRETS) expect(message, secret).toContain(secret)
    const h = harness()
    try {
      h.reporter.onTestEnd(
        testCase("orders", "round trip"),
        result(
          "failed",
          [
            step("S1 send", {
              error: {
                message,
                location: { file: SPEC_FILE, line: 33, column: 5 },
              },
            }),
          ],
          { error: { message } },
        ),
      )
      h.reporter.onError({ message: `\u001b[2m${message}\u001b[22m` })
      await h.reporter.onEnd(failed)
      const written = ["summary.md", "summary.json", "summary.lines"].map(
        (file) => [file, readFileSync(join(h.dir, file), "utf8")] as const,
      )
      for (const [file, text] of written) {
        expect(text, file).toContain("Timeout 300ms exceeded")
        for (const secret of SECRETS) {
          expect(text, `${file}: ${secret}`).not.toContain(secret)
        }
      }
      for (const line of h.lines) {
        for (const secret of SECRETS) expect(line, secret).not.toContain(secret)
      }
    } finally {
      rmSync(h.root, { recursive: true, force: true })
    }
  })

  test("a URL's query string and fragment are dropped from what is kept", async () => {
    const h = harness()
    try {
      h.reporter.onTestEnd(
        testCase("orders", "round trip"),
        result("failed", [], {
          error: {
            message:
              "page.goto: net::ERR_CONNECTION_REFUSED at https://app.example.test/reset?token=RESET-SECRET#frag-SECRET\nexpected the page to load (see http://h/x?a=QUERY-2)",
          },
        }),
      )
      await h.reporter.onEnd(failed)
      const s = readFileSync(join(h.dir, "summary.json"), "utf8")
      expect(s).toContain("https://app.example.test/reset")
      expect(s).toContain("http://h/x")
      for (const secret of ["RESET-SECRET", "frag-SECRET", "QUERY-2"]) {
        expect(s, secret).not.toContain(secret)
      }
    } finally {
      rmSync(h.root, { recursive: true, force: true })
    }
  })

  test("an error without a call log is kept whole (up to 4000 characters)", async () => {
    const h = harness()
    try {
      const message = "expected 1\nreceived 2\n  at flows/x.spec.ts:33"
      h.reporter.onTestEnd(
        testCase("orders", "round trip"),
        result("failed", [], { error: { message } }),
      )
      await h.reporter.onEnd(failed)
      expect(readFileSync(join(h.dir, "summary.json"), "utf8")).toContain(
        JSON.stringify(message).slice(1, -1),
      )
    } finally {
      rmSync(h.root, { recursive: true, force: true })
    }
  })
})
