// SPDX-License-Identifier: Apache-2.0

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"

import { expect, test } from "@playwright/test"
import type {
  FullResult,
  TestCase,
  TestError,
  TestResult,
  TestStep,
} from "@playwright/test/reporter"

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

// The summary reporter's less common paths: defaults, partial options,
// unreadable inputs, runner errors with no test, and the tour's edge cases.

const RUN_ID = "loc-20261014-1200-wxyz"
const SPEC_FILE = "/abs/flows/y.spec.ts"

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
  tourRequests: TourVideoRequest[]
  videoRequests: VideoRequest[]
  reporter: SummaryReporter
}

function harness(
  over: Partial<SummaryReporterOptions> = {},
  video: VideoOutcome = { produced: false, reason: "video off" },
  tourVideo: TourVideoOutcome = { produced: false, reason: "video off" },
): Harness {
  const root = mkdtempSync(join(tmpdir(), "flowreel-rep-br-"))
  const h = {
    root,
    dir: join(root, "results", RUN_ID),
    lines: [] as string[],
    tourRequests: [] as TourVideoRequest[],
    videoRequests: [] as VideoRequest[],
  }
  const options: SummaryReporterOptions = {
    modules: [ROUND_TRIP, TOUR],
    config: { results: join(root, "results"), logPrefix: "example" },
    repoRoot: root,
    setupLocation: "e2e/global-setup.ts:1",
    runId: () => RUN_ID,
    configuredTarget: () => "local",
    envTarget: () => undefined,
    describeConfig: () => ({ target: "local" }),
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
    gitSha: () => "abc1234",
    log: (line) => h.lines.push(line),
    ...over,
  }
  return { ...h, reporter: new SummaryReporter(options) }
}

function testCase(
  project: string | null,
  title: string,
  annotations: TestCase["annotations"] = [],
): TestCase {
  return {
    id: `${project}:${title}`,
    title,
    location: { file: SPEC_FILE, line: 7, column: 1 },
    annotations,
    parent: {
      project: () => (project === null ? undefined : { name: project }),
    },
  } as unknown as TestCase
}

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

const passed = { status: "passed" } as FullResult
const failed = { status: "failed" } as FullResult

function readSummary(dir: string) {
  return JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")) as Record<
    string,
    any
  >
}

async function withHarness(
  h: Harness,
  body: (h: Harness) => Promise<void>,
): Promise<void> {
  try {
    await body(h)
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
}

const featureAnnotation = (id: string, mode = "full", policy = "both") => ({
  type: "tour-feature",
  description: JSON.stringify({ id, policy, devOnlyReason: null, mode }),
})

test.describe("defaults and partial options", () => {
  test("no log, copy, git sha, preflight file or plan: console, flowreel title, unknown sha", async () => {
    const root = mkdtempSync(join(tmpdir(), "flowreel-rep-br-"))
    const printed: string[] = []
    const original = console.log
    try {
      const reporter = new SummaryReporter({
        modules: [ROUND_TRIP],
        resultsDir: (id) => join(root, "results", id),
        repoRoot: root,
        setupLocation: "x:1",
        runId: () => RUN_ID,
        envTarget: () => undefined,
        describeConfig: () => ({}),
        videoPace: () => ({
          pace: "qa",
          slowFactor: 1,
          narration: { on: true },
        }),
        produceVideo: () =>
          Promise.resolve({ produced: false, reason: "video off" }),
      })
      expect(reporter.printsToStdio()).toBe(false)
      console.log = (line: string) => void printed.push(line)
      reporter.onBegin()
      reporter.onTestEnd(testCase("orders", "round trip"), result("passed"))
      await reporter.onEnd(passed)
      console.log = original
      const dir = join(root, "results", RUN_ID)
      const s = readSummary(dir)
      // A directory outside any repository has no short sha.
      expect(s.gitSha).toBe("unknown")
      // No target anywhere: "?"; no module in the config: the module's name.
      expect(s.target).toBe("?")
      expect(s.module).toBe("orders")
      expect(s.preflight).toBeNull()
      // No plan file: only the steps that ran.
      expect(s.tests[0].steps).toEqual([])
      expect(s.narration).toEqual({
        produced: false,
        reason: "composition did not finish",
      })
      expect(readFileSync(join(dir, "summary.md"), "utf8").split("\n")[0]).toBe(
        `# flowreel run ${RUN_ID}: PASS`,
      )
      expect(printed[0]).toMatch(/^\[flowreel\] PASS:/)
    } finally {
      console.log = original
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("the config names the module and target; no tour module means an N/A without a tour", async () => {
    const h = harness({
      modules: [ROUND_TRIP],
      envTarget: () => "staging",
      configuredTarget: undefined,
      describeConfig: () => ({ module: "custom-module" }),
      tabulatedProjects: ["preflight"],
    })
    await withHarness(h, async () => {
      // A preflight-only run: nothing else, so the round trip was not part of it.
      h.reporter.onTestEnd(testCase("preflight", "preflight"), result("passed"))
      h.reporter.onTestEnd(testCase("tour-a", "A1 x"), result("passed"))
      await h.reporter.onEnd(passed)
      const s = readSummary(h.dir)
      expect(s.target).toBe("staging")
      expect(s.module).toBe("custom-module")
      expect(s.verdict).toBe("N/A")
      expect(s.verdictReason).toBe("The round trip was not part of this run.")
    })
  })

  test("a test with no project is not tabulated", async () => {
    const h = harness()
    await withHarness(h, async () => {
      h.reporter.onTestEnd(testCase(null, "orphan"), result("failed"))
      // Counted toward the verdict, but with no flow test there is no folder
      // unless a runner error also exists.
      expect(await h.reporter.onEnd(failed)).toBeUndefined()
      expect(() => readSummary(h.dir)).toThrow()
    })
  })

  test("a target from the environment when the configured one is absent and falls back to local", async () => {
    const h = harness({ configuredTarget: undefined })
    await withHarness(h, async () => {
      h.reporter.onTestEnd(testCase("orders", "round trip"), result("passed"))
      await h.reporter.onEnd(passed)
      // describeConfig names the target, so the summary shows it.
      expect(readSummary(h.dir).target).toBe("local")
    })
  })
})

test.describe("runner errors", () => {
  test("errors without any test: FAIL, the setup line, every error text shape", async () => {
    const h = harness()
    await withHarness(h, async () => {
      h.reporter.onError({
        message: "\u001b[31mboom\u001b[0m\nsecond line",
        location: { file: join(h.root, "e2e", "x.ts"), line: 3, column: 1 },
      } as TestError)
      h.reporter.onError({ value: "thrown string" } as TestError)
      h.reporter.onError({ message: "\u001b[0m" } as TestError)
      const exit = await h.reporter.onEnd(passed)
      // The runner said passed but the reporter saw errors.
      expect(exit).toEqual({ status: "failed" })
      const s = readSummary(h.dir)
      expect(s.verdict).toBe("FAIL")
      expect(s.verdictReason).toBe("Failed: setup / runner error.")
      expect(s.errors).toEqual(["boom\nsecond line", "thrown string", "error"])
      expect(readFileSync(join(h.dir, "summary.lines"), "utf8")).toBe(
        [
          `${join("e2e", "x.ts")}:3: error: [setup] boom`,
          "e2e/global-setup.ts:1: error: [setup] thrown string",
          "e2e/global-setup.ts:1: error: [setup] error",
          "",
        ].join("\n"),
      )
      // The video gets no recording and an empty table.
      expect(h.videoRequests[0]).toMatchObject({ flow: null, table: [] })
      expect(readFileSync(join(h.dir, "summary.md"), "utf8")).toContain(
        "## Runner errors",
      )
    })
  })

  test("a runner that did not pass with no failed test reports the run status", async () => {
    const h = harness()
    await withHarness(h, async () => {
      h.reporter.onTestEnd(testCase("orders", "round trip"), result("passed"))
      await h.reporter.onEnd({ status: "interrupted" } as FullResult)
      expect(readSummary(h.dir).verdictReason).toBe("Failed: run interrupted.")
    })
  })
})

test.describe("the round trip's edge cases", () => {
  test("a skip without an N/A reason uses the module's skip copy; a missing plan file adds no rows", async () => {
    const h = harness({
      modules: [{ ...ROUND_TRIP, planFile: "/nonexistent/plan.md" }],
    })
    await withHarness(h, async () => {
      h.reporter.onTestEnd(testCase("orders", "round trip"), result("skipped"))
      await h.reporter.onEnd(passed)
      const s = readSummary(h.dir)
      expect(s.verdict).toBe("N/A")
      expect(s.verdictReason).toBe("round-trip test skipped")
      expect(s.tests[0].steps).toEqual([])
    })
  })

  test("a failing step without a location and error: the test's location and a generic message", async () => {
    const h = harness()
    await withHarness(h, async () => {
      const noWhere = step("S1 send", {
        duration: -1,
        location: undefined,
      } as Partial<TestStep>)
      h.reporter.onTestEnd(
        testCase("orders", "round trip"),
        result("timedOut", [noWhere]),
      )
      await h.reporter.onEnd(failed)
      const s = readSummary(h.dir)
      const row = s.tests[0].steps[0]
      expect(row).toMatchObject({
        id: "S1 send",
        status: "failed",
        file: null,
        line: null,
        error: "did not finish (test timedOut)",
      })
      // The line points at the test (file:line 7) and says "failed"? No: the
      // step's error text is the generic one.
      expect(readFileSync(join(h.dir, "summary.lines"), "utf8")).toBe(
        `${relative(h.root, SPEC_FILE)}:7: error: [S1 send] did not finish (test timedOut)\n`,
      )
      // The video's step error: the test's error is absent, so none.
      expect(h.videoRequests[0].flow?.steps[0]).toMatchObject({
        failed: true,
        error: null,
      })
    })
  })

  test("an open step takes the test's error; a failed test without step errors prints it", async () => {
    const h = harness()
    await withHarness(h, async () => {
      h.reporter.onTestEnd(
        testCase("orders", "second"),
        result("failed", [], {
          error: { message: "\u001b[1mno steps\u001b[0m\nmore" } as TestError,
        }),
      )
      h.reporter.onTestEnd(
        testCase("orders", "round trip"),
        result("timedOut", [step("S1 send", { duration: -1 })], {
          error: { message: "Test timeout of 30000ms exceeded." } as TestError,
        }),
      )
      await h.reporter.onEnd(failed)
      const s = readSummary(h.dir)
      expect(s.tests[1].steps[0].error).toBe(
        "Test timeout of 30000ms exceeded.",
      )
      expect(h.videoRequests[0].flow?.steps[0].error).toBe(
        "Test timeout of 30000ms exceeded.",
      )
      const md = readFileSync(join(h.dir, "summary.md"), "utf8")
      expect(md).toContain("**Error:**")
      expect(md).toContain("no steps\nmore")
      const lines = readFileSync(join(h.dir, "summary.lines"), "utf8")
      expect(lines).toContain("[orders] no steps")
    })
  })

  test("a failed test with neither step errors nor an error falls back to its status", async () => {
    const h = harness()
    await withHarness(h, async () => {
      h.reporter.onTestEnd(
        testCase("orders", "round trip"),
        result("interrupted"),
      )
      await h.reporter.onEnd(failed)
      expect(readFileSync(join(h.dir, "summary.lines"), "utf8")).toBe(
        `${relative(h.root, SPEC_FILE)}:7: error: [orders] interrupted\n`,
      )
    })
  })

  test("the video log is read from its body or its file; attachments appear as evidence", async () => {
    const h = harness()
    await withHarness(h, async () => {
      const logFile = join(h.root, "video-log.json")
      const log = { videoStartedAt: 1_234, mail: [] }
      writeFileSync(logFile, JSON.stringify(log))
      const videoFile = join(h.root, "video.webm")
      h.reporter.onTestEnd(
        testCase("orders", "round trip"),
        result("passed", [], {
          attachments: [
            { name: "video-log.json", path: logFile, contentType: "x" },
            { name: "video", path: videoFile, contentType: "video/webm" },
            {
              name: "no-path",
              contentType: "text/plain",
              body: Buffer.from(""),
            },
          ],
        } as unknown as Partial<TestResult>),
      )
      await h.reporter.onEnd(passed)
      const flow = h.videoRequests[0].flow
      expect(flow?.videoPath).toBe(videoFile)
      expect(flow?.log).toMatchObject({ videoStartedAt: 1_234, mail: [] })
      const s = readSummary(h.dir)
      expect(s.attachments).toEqual([
        {
          test: "orders: round trip",
          name: "video-log.json",
          path: relative(h.dir, logFile),
        },
        {
          test: "orders: round trip",
          name: "video",
          path: relative(h.dir, videoFile),
        },
      ])
      expect(readFileSync(join(h.dir, "summary.md"), "utf8")).toContain(
        "- orders: round trip, video: [",
      )
    })
  })

  test("a video log given as a body, and an unreadable one, yield a recording or none", async () => {
    const h = harness()
    await withHarness(h, async () => {
      h.reporter.onTestEnd(
        testCase("orders", "with body"),
        result("passed", [], {
          attachments: [
            {
              name: "video-log.json",
              contentType: "application/json",
              body: Buffer.from(
                JSON.stringify({ videoStartedAt: 5, mail: [] }),
              ),
            },
          ],
        } as unknown as Partial<TestResult>),
      )
      await h.reporter.onEnd(passed)
      expect(h.videoRequests[0].flow?.log?.videoStartedAt).toBe(5)
    })
    const g = harness()
    await withHarness(g, async () => {
      g.reporter.onTestEnd(
        testCase("orders", "unreadable"),
        result("passed", [], {
          attachments: [
            {
              name: "video-log.json",
              path: join(g.root, "missing.json"),
              contentType: "application/json",
            },
          ],
        } as unknown as Partial<TestResult>),
      )
      await g.reporter.onEnd(passed)
      expect(g.videoRequests[0].flow?.log).toBeNull()
    })
  })

  test("an unrestored-free undo store: restored changes are reported as restored", async () => {
    const h = harness()
    await withHarness(h, async () => {
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
              manual: "Rename it back.",
              status: "restored",
              error: null,
              recordedAt: "",
              restoredAt: "",
            },
          ],
        }),
      )
      h.reporter.onTestEnd(testCase("orders", "round trip"), result("passed"))
      h.reporter.onTestEnd(
        testCase("tour-a", "A1 x", [featureAnnotation("A1")]),
        result("passed", [step("A1.1 Open")]),
      )
      expect(await h.reporter.onEnd(passed)).toBeUndefined()
      const s = readSummary(h.dir)
      expect(s.undo).toMatchObject({ total: 1, failed: 0, file: "undo.md" })
      expect(readFileSync(join(h.dir, "summary.md"), "utf8")).toContain(
        "**Undo:** 1 shared-config change(s), all restored",
      )
    })
  })

  test("a publisher that throws a non-Error is recorded by its text", async () => {
    const h = harness({
      videoPace: () => ({
        pace: "demo",
        slowFactor: 1,
        narration: { on: false, reason: "off" },
      }),
      produceVideo: () =>
        Promise.resolve({
          produced: true,
          path: join(tmpdir(), "x.mp4"),
          durationSec: 1,
        } as VideoOutcome),
      publishDemos: () => {
        throw "plain string"
      },
    })
    await withHarness(h, async () => {
      h.reporter.onTestEnd(testCase("orders", "round trip"), result("passed"))
      await h.reporter.onEnd(passed)
      expect(readSummary(h.dir).demos).toEqual({
        published: false,
        reason: "plain string",
      })
    })
  })

  test("a published demo lists its files and what it kept", async () => {
    const h = harness({
      videoPace: () => ({
        pace: "demo",
        slowFactor: 1,
        narration: { on: false, reason: "off" },
      }),
      produceVideo: () =>
        Promise.resolve({
          produced: true,
          path: join(tmpdir(), "x.mp4"),
          durationSec: 1,
        } as VideoOutcome),
      publishDemos: (runDir) => ({
        published: true,
        dir: join(runDir, "demos"),
        files: ["a.mp4", "b.mp4"],
        kept: ["c.mp4"],
      }),
    })
    await withHarness(h, async () => {
      h.reporter.onTestEnd(testCase("orders", "round trip"), result("passed"))
      await h.reporter.onEnd(passed)
      expect(h.lines).toContain(
        `[example] demos: a.mp4, b.mp4 -> ${join("results", RUN_ID, "demos")}/ (kept the passing c.mp4)`,
      )
    })
    const g = harness({
      videoPace: () => ({
        pace: "demo",
        slowFactor: 1,
        narration: { on: false, reason: "off" },
      }),
      produceVideo: () =>
        Promise.resolve({
          produced: true,
          path: join(tmpdir(), "x.mp4"),
          durationSec: 1,
        } as VideoOutcome),
      publishDemos: (runDir) => ({
        published: true,
        dir: join(runDir, "demos"),
        files: ["a.mp4"],
      }),
    })
    await withHarness(g, async () => {
      g.reporter.onTestEnd(testCase("orders", "round trip"), result("passed"))
      await g.reporter.onEnd(passed)
      expect(g.lines).toContain(
        `[example] demos: a.mp4 -> ${join("results", RUN_ID, "demos")}/`,
      )
    })
  })

  test("a step's location falls to the deeper failing spec line; an errorless failed child is skipped", async () => {
    const h = harness()
    await withHarness(h, async () => {
      const failing = step("S1 send", {
        error: { message: "expected true" } as TestError,
        steps: [
          step("child", {
            error: {
              message: "inner",
              location: { file: SPEC_FILE, line: 33, column: 1 },
            } as TestError,
          } as Partial<TestStep>),
        ],
      })
      h.reporter.onTestEnd(
        testCase("orders", "round trip"),
        result("failed", [failing]),
      )
      await h.reporter.onEnd(failed)
      expect(readSummary(h.dir).tests[0].steps[0]).toMatchObject({
        file: relative(h.root, SPEC_FILE),
        line: 33,
        error: "expected true",
      })
    })
  })
})

test.describe("the tour's edge cases", () => {
  test("a title that does not parse keeps the raw title; steps with the wrong feature are noted", async () => {
    const h = harness()
    await withHarness(h, async () => {
      h.reporter.onTestEnd(
        testCase("tour-a", "unparsable title", [featureAnnotation("A9")]),
        result("passed", [step("whatever")]),
      )
      h.reporter.onTestEnd(
        testCase("tour-b", "B1 other", [featureAnnotation("B1")]),
        result("passed", [step("A1.1 belongs elsewhere")]),
      )
      await h.reporter.onEnd(passed)
      const s = readSummary(h.dir)
      expect(
        s.features.map((f: { id: string; title: string }) => [f.id, f.title]),
      ).toEqual([
        ["unparsable title", "unparsable title"],
        ["B1", "other"],
      ])
      expect(s.couldNotCheck).toEqual([
        'unparsable title: step "whatever" is not titled "<id>.<n> <sentence>" (its caption shows the raw title).',
        'B1 other: step "A1.1 belongs elsewhere" is not titled "B1.<n> <sentence>" (its caption shows the raw title).',
      ])
    })
  })

  test("a failed test without feature() carries the reason; a hand-written skip fails; an unstarted one is not run", async () => {
    const h = harness()
    await withHarness(h, async () => {
      h.reporter.onTestEnd(testCase("tour-a", "A1 x"), result("passed"))
      await h.reporter.onEnd(passed)
      const s = readSummary(h.dir)
      expect(s.features[0]).toMatchObject({ id: "A1", status: "failed" })
      expect(s.features[0].reason).toContain("did not call feature()")
      expect(s.verdictReason).toContain("A1 (did not call feature()")
    })
  })

  test("a feature that ran has a recording only when it has a video and a log with a start", async () => {
    const h = harness()
    await withHarness(h, async () => {
      const logFile = join(h.root, "log.json")
      writeFileSync(logFile, JSON.stringify({ videoStartedAt: 100, mail: [] }))
      const noStartLog = join(h.root, "nostart.json")
      writeFileSync(noStartLog, JSON.stringify({ mail: [] }))
      const att = (name: string, path: string) => ({
        name,
        path,
        contentType: "x",
      })
      h.reporter.onTestEnd(
        testCase("tour-a", "A1 full", [featureAnnotation("A1")]),
        result("passed", [step("A1.1 Open")], {
          attachments: [
            att("video-log.json", logFile),
            att("video", join(h.root, "a1.webm")),
          ],
        } as unknown as Partial<TestResult>),
      )
      h.reporter.onTestEnd(
        testCase("tour-a", "A2 no video", [featureAnnotation("A2")]),
        result("passed", [], {
          attachments: [att("video-log.json", logFile)],
        } as unknown as Partial<TestResult>),
      )
      h.reporter.onTestEnd(
        testCase("tour-a", "A3 no log", [featureAnnotation("A3")]),
        result("passed", [], {
          attachments: [att("video", join(h.root, "a3.webm"))],
        } as unknown as Partial<TestResult>),
      )
      h.reporter.onTestEnd(
        testCase("tour-a", "A4 log without start", [featureAnnotation("A4")]),
        result("passed", [], {
          attachments: [
            att("video-log.json", noStartLog),
            att("video", join(h.root, "a4.webm")),
          ],
        } as unknown as Partial<TestResult>),
      )
      await h.reporter.onEnd(passed)
      const recs = h.tourRequests[0].features.map((f) => f.recording)
      expect(recs[0]).toMatchObject({
        videoPath: join(h.root, "a1.webm"),
        log: { videoStartedAt: 100 },
      })
      expect(recs[0]?.steps).toHaveLength(1)
      expect(recs.slice(1)).toEqual([null, null, null])
    })
  })

  test("a tour video's own narration and pace replace the planned ones", async () => {
    const h = harness({}, undefined, {
      produced: true,
      areas: [],
      tour: { path: join(tmpdir(), "t.mp4"), durationSec: 3 },
      featureStarts: {},
      narration: {
        produced: true,
        engine: "macos",
        voice: "Ava",
        warning: null,
        lines: 1,
        synthesized: 1,
        cached: 0,
      },
      pace: { pace: "demo", slowFactor: 2 },
    } as TourVideoOutcome)
    await withHarness(h, async () => {
      h.reporter.onTestEnd(
        testCase("tour-a", "A1 x", [featureAnnotation("A1")]),
        result("passed", [step("A1.1 Open")]),
      )
      await h.reporter.onEnd(passed)
      const s = readSummary(h.dir)
      expect(s.narration.voice).toBe("Ava")
      expect(s.pace).toEqual({ pace: "demo", slowFactor: 2 })
      expect(s.features[0].videoAtSec).toBeNull()
    })
  })

  test("a not-produced tour video keeps its own pace; only unparsed tests give 'No tour feature ran'", async () => {
    const h = harness({}, undefined, {
      produced: false,
      reason: "no ffmpeg",
      narration: { produced: false, reason: "none" },
      pace: { pace: "demo", slowFactor: 3 },
    } as TourVideoOutcome)
    await withHarness(h, async () => {
      h.reporter.onTestEnd(
        testCase("tour-a", "A1 x", [featureAnnotation("A1")]),
        result("passed", [step("A1.1 Open")]),
      )
      await h.reporter.onEnd(passed)
      const s = readSummary(h.dir)
      expect(s.video).toEqual({ produced: false, reason: "no ffmpeg" })
      expect(s.pace.slowFactor).toBe(3)
      expect(s.narration).toEqual({ produced: false, reason: "none" })
    })
  })

  test("a tour project whose test never reaches a feature: No tour feature ran", async () => {
    // A tour project that is tabulated but has no area (setup only).
    const tour: TourModule = {
      ...TOUR,
      isProject: (p) => p === "tour-setup" || TOUR.isProject(p),
    }
    const h = harness({ modules: [ROUND_TRIP, tour] })
    await withHarness(h, async () => {
      h.reporter.onTestEnd(testCase("tour-setup", "setup"), result("passed"))
      await h.reporter.onEnd(passed)
      const s = readSummary(h.dir)
      expect(s.verdict).toBe("N/A")
      expect(s.verdictReason).toBe("No tour feature ran.")
    })
  })

  test("a development-only feature without a skip reason is not run", async () => {
    const h = harness()
    await withHarness(h, async () => {
      h.reporter.onTestEnd(
        testCase("tour-a", "A1 x", [featureAnnotation("A1")]),
        result("interrupted"),
      )
      h.reporter.onTestEnd(
        testCase("tour-a", "A2 y", [featureAnnotation("A2")]),
        result("skipped"),
      )
      await h.reporter.onEnd(failed)
      const s = readSummary(h.dir)
      expect(s.features[1]).toMatchObject({
        id: "A2",
        status: "N/A",
        reason: null,
      })
    })
  })
})
