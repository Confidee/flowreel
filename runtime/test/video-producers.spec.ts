// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "@playwright/test"

import { ffmpegProblem } from "../src/video/ffmpeg.js"
import { createVideoKit } from "../src/video/kit.js"
import {
  type CombinedRequest,
  type CombinedStage,
  comparisonData,
  featureComparison,
  produceCombinedTourVideo,
  produceCombinedVideo,
  stageReel,
  stageTourBody,
  tourLabel,
} from "../src/video/pipeline-video.js"
import type { VideoLogData } from "../src/video/recorder.js"
import {
  REEL_FILE,
  type VideoRequest,
  produceVideo,
  readReel,
  videoBlocker,
  videoFileName,
} from "../src/video/run-video.js"
import { type TimelineInput, buildTimeline } from "../src/video/timeline.js"
import {
  STANDIN_SEC,
  TITLE_SEC,
  TOUR_VIDEO_MANIFEST,
  type TourFeatureRecord,
  type TourVideoArea,
  areaVideoName,
  cardHoldSec,
  cardKey,
  cardLineData,
  featureSegments,
  placeSegments,
  planAreaVideo,
  planTourVideo,
  produceTourVideos,
  readTourVideoManifest,
  reelInput,
  scoreRows,
  sortFeatures,
  tourVideoName,
} from "../src/video/tour-video.js"

// The run, tour and pipeline video producers: their pure planning (what is
// cut where, what each card says) and that they never throw. Composing a
// real MP4 needs ffmpeg and a browser and is covered by the host project's
// end-to-end runs.

const kit = createVideoKit()

const dirs: string[] = []
const tracked = (dir: string) => {
  dirs.push(dir)
  return dir
}
test.afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// One flow's run video
// ---------------------------------------------------------------------------

const flow = (
  overrides: Partial<NonNullable<VideoRequest["flow"]>> = {},
): NonNullable<VideoRequest["flow"]> => ({
  status: "passed",
  videoPath: "/r/video.webm",
  log: { videoStartedAt: 1_000, mail: [] },
  steps: [{ id: "R1 inbound", startMs: 2_000, durationMs: 500, failed: false }],
  ...overrides,
})

const request = (f: VideoRequest["flow"] = flow()): VideoRequest => ({
  module: "orbit",
  runId: "loc-20261013-1200-abcd",
  target: "local",
  dir: "/nonexistent/flowreel-video",
  startedAt: new Date(0),
  verdict: "PASS",
  verdictReason: "Every step passed.",
  flow: f,
  table: [],
  latenciesMs: {},
})

test.describe("videoBlocker", () => {
  const cases: [string, VideoRequest, Record<string, string>, string | null][] =
    [
      ["off", request(), { FLOWREEL_VIDEO: "off" }, "FLOWREEL_VIDEO=off"],
      ["not run", request(null), {}, "the orbit test did not run"],
      [
        "skipped",
        request(flow({ status: "skipped" })),
        {},
        "the orbit test was skipped",
      ],
      [
        "no recording",
        request(flow({ videoPath: null })),
        {},
        "no page recording was attached",
      ],
      ["no log", request(flow({ log: null })), {}, "no video timing log"],
      [
        "no anchor",
        request(flow({ log: { videoStartedAt: null, mail: [] } })),
        {},
        "no video timing log",
      ],
      ["no steps", request(flow({ steps: [] })), {}, "no step was recorded"],
      ["ready (failed run too)", request(flow({ status: "failed" })), {}, null],
    ]
  for (const [name, req, env, reason] of cases) {
    test(name, () => {
      expect(videoBlocker(req, env)).toBe(reason)
    })
  }

  test("file names", () => {
    expect(videoFileName("orbit", "loc-1")).toBe("orbit-loc-1.mp4")
    expect(tourVideoName("orbit-tour", "loc-1")).toBe("orbit-tour-loc-1.mp4")
    expect(areaVideoName("B", "loc-1")).toBe("tour-b-loc-1.mp4")
  })
})

test.describe("produceVideo never throws", () => {
  test("video off: the reason, the narration decision and the pace", async () => {
    await expect(
      produceVideo(request(), kit, { FLOWREEL_VIDEO: "off" }),
    ).resolves.toEqual({
      produced: false,
      reason: "FLOWREEL_VIDEO=off",
      narration: {
        produced: false,
        reason:
          "off unless FLOWREEL_NARRATION=on (the macOS voices are licensed for personal, non-commercial use only)",
      },
      pace: { pace: "qa", slowFactor: 1 },
    })
  })

  test("a non-Error rejection still becomes a reason", async () => {
    test.skip(ffmpegProblem() !== null, "needs ffmpeg to get past the blocker")
    let reads = 0
    const log = {
      get videoStartedAt() {
        if (reads++ === 0) return 1_000
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw "boom\nsecond line"
      },
      mail: [],
    } as VideoLogData
    await expect(
      produceVideo(request(flow({ log })), kit, {}),
    ).resolves.toMatchObject({ produced: false, reason: "boom" })
  })
})

// ---------------------------------------------------------------------------
// Tour videos
// ---------------------------------------------------------------------------

const AREAS: TourVideoArea[] = [
  { letter: "A", title: "Lists" },
  { letter: "F", title: "Admin" },
  { letter: "G", title: "Ledger" },
]

const rec = (start: number): NonNullable<TourFeatureRecord["recording"]> => ({
  videoPath: "/v.webm",
  log: {
    videoStartedAt: start,
    mail: [],
    personas: [{ persona: "admin", at: start + 4_000 }],
  },
  steps: [
    { id: "X.1 a", startMs: start + 1_000, durationMs: 2_000, failed: false },
    { id: "X.2 b", startMs: start + 3_500, durationMs: 3_000, failed: false },
  ],
})

const feature = (
  id: string,
  status: TourFeatureRecord["status"],
  extra: Partial<TourFeatureRecord> = {},
): TourFeatureRecord => ({
  id,
  title: `${id.toLowerCase()}-slug`,
  area: id[0],
  policy: "both",
  mode: "full",
  status,
  reason: null,
  durationMs: 5_000,
  recording: status === "dev-only" || status === "N/A" ? null : rec(1_000_000),
  ...extra,
})

const features = [
  feature("A10", "passed"),
  feature("A2", "failed"),
  feature("G1", "dev-only", { policy: "dev", reason: "append-only ledger" }),
  feature("F3", "view-only", { policy: "view" }),
  feature("A5", "N/A", { reason: "N/A: skipped" }),
]

test.describe("tour video plan", () => {
  test("features sort by the catalogue's area order, then number", () => {
    expect(sortFeatures(features, AREAS).map((f) => f.id)).toEqual([
      "A2",
      "A5",
      "A10",
      "F3",
      "G1",
    ])
    // Another catalogue order, another sort.
    const reversed = [...AREAS].reverse()
    expect(sortFeatures(features, reversed).map((f) => f.id)).toEqual([
      "G1",
      "F3",
      "A2",
      "A5",
      "A10",
    ])
  })

  test("each feature: title + reel, a stand-in, or the view card + reel", () => {
    const kinds = (f: TourFeatureRecord) =>
      featureSegments(f).map((s) =>
        s.kind === "reel"
          ? "reel"
          : `${s.card.kind === "feature" ? s.card.card : s.card.kind}:${s.durationSec}`,
      )
    expect(kinds(feature("A1", "passed"))).toEqual([
      `title:${TITLE_SEC}`,
      "reel",
    ])
    expect(kinds(features[2])).toEqual([`dev-only:${STANDIN_SEC}`])
    expect(kinds(features[3])).toEqual([`view:${STANDIN_SEC}`, "reel"])
    expect(kinds(features[4])).toEqual([`not-run:${STANDIN_SEC}`])
    expect(kinds(feature("A1", "failed", { recording: null }))).toEqual([
      `not-run:${STANDIN_SEC}`,
    ])
  })

  test("an area video and the full tour", () => {
    const name = (s: ReturnType<typeof planAreaVideo>[number]) =>
      s.kind === "reel"
        ? `reel:${s.feature}`
        : s.card.kind === "area-chapter"
          ? `chapter:${s.card.area}`
          : s.card.kind === "feature"
            ? `${s.card.card}:${s.card.feature}`
            : s.card.kind
    expect(planAreaVideo("A", features, AREAS).map(name)).toEqual([
      "area-intro",
      "title:A2",
      "reel:A2",
      "not-run:A5",
      "title:A10",
      "reel:A10",
      "area-scoreboard",
    ])
    const { segments, body } = planTourVideo(features, AREAS)
    expect(segments.map(name)).toEqual([
      "tour-intro",
      "chapter:A",
      "title:A2",
      "reel:A2",
      "not-run:A5",
      "title:A10",
      "reel:A10",
      "chapter:F",
      "view:F3",
      "reel:F3",
      "chapter:G",
      "dev-only:G1",
      "tour-summary",
      "tour-scoreboard",
    ])
    expect(body).toEqual(segments.slice(1, -2))
  })

  test("feature start times use the encoded card lengths and the real reels", () => {
    const { segments } = planTourVideo(features, AREAS)
    expect(
      placeSegments(segments, { A2: 10, A10: 20, F3: 7 }).features,
    ).toEqual({ A2: 6, A5: 17.5, A10: 20.5, F3: 44, G1: 56 })
    const cardSec: Record<string, number> = {}
    for (const segment of segments) {
      if (segment.kind === "card" && segment.durationSec === TITLE_SEC) {
        cardSec[cardKey(segment)] = 1.52
      }
    }
    const placed = placeSegments(segments, { A2: 10, A10: 20, F3: 7 }, cardSec)
    expect(placed.features).toEqual({
      A2: 6,
      A5: 17.52,
      A10: 20.52,
      F3: 44.04,
      G1: 56.04,
    })
    expect(placed.durationSec).toBe(67.04)
  })

  test("a reel's timeline starts with the configured persona", () => {
    const input = reelInput(rec(1_000_000), 10, "operator")
    expect(input.steps.map((s) => [s.startSec, s.endSec])).toEqual([
      [1, 3],
      [3.5, 6.5],
    ])
    expect(buildTimeline(input, { bookends: false }).personas).toEqual([
      { persona: "operator", fromSec: 0.5, toSec: 4 },
      { persona: "admin", fromSec: 4, toSec: 8 },
    ])
  })

  test("scoreboard rows and card line facts", () => {
    expect(scoreRows(features, 1, AREAS).map((r) => r.id)).toEqual([
      "A2",
      "A5",
      "A10",
      "F3",
      "G1",
    ])
    expect(
      cardLineData({ kind: "area-intro", area: "F" }, features, "local", AREAS),
    ).toEqual({ kind: "area-intro", area: "F", title: "Admin", count: 1 })
    expect(
      cardLineData({ kind: "tour-intro" }, features, "staging", AREAS),
    ).toEqual({ kind: "tour-intro", count: 5, areas: 3, target: "staging" })
    expect(
      cardLineData({ kind: "tour-summary" }, features, "local", AREAS),
    ).toEqual({ kind: "tour-summary", count: 5, passed: 2, failed: 1 })
    expect(cardHoldSec(1.5, null)).toBe(1.5)
    expect(cardHoldSec(1.5, 4)).toBeGreaterThan(4)
  })

  test("produceTourVideos never throws", async () => {
    const tour = { module: "orbit-tour", areas: AREAS, initialPersona: "agent" }
    const req = {
      runId: "loc-1",
      target: "local",
      pace: "qa" as const,
      dir: "/nonexistent",
      startedAt: new Date(0),
      verdict: "PASS",
      features,
    }
    await expect(
      produceTourVideos(req, kit, tour, { FLOWREEL_VIDEO: "off" }),
    ).resolves.toEqual({
      produced: false,
      reason: "FLOWREEL_VIDEO=off",
      narration: {
        produced: false,
        reason:
          "off unless FLOWREEL_NARRATION=on (the macOS voices are licensed for personal, non-commercial use only)",
      },
      pace: { pace: "qa", slowFactor: 1 },
    })
    await expect(
      produceTourVideos({ ...req, features: [] }, kit, tour, {}),
    ).resolves.toMatchObject({ produced: false, reason: "no tour feature ran" })
  })
})

// ---------------------------------------------------------------------------
// The pipeline's combined videos
// ---------------------------------------------------------------------------

const stage = (overrides: Partial<CombinedStage>): CombinedStage => ({
  result: { verdict: "PASS", reason: "" },
  title: "Development",
  detail: "",
  runId: "loc-1",
  dir: null,
  summary: null,
  ...overrides,
})
const combined = (
  stages: CombinedStage[],
  dir = "/nonexistent",
): CombinedRequest => ({
  module: "orbit",
  pipelineId: "pipe-1",
  dir,
  startedAt: new Date(0),
  verdict: "INCOMPLETE",
  reason: "",
  stages,
})

test.describe("comparisonData", () => {
  const cards = createVideoKit({
    copy: {
      ...kit.cards.copy,
      latencyLabels: { firstMs: "First", secondMs: "Second" },
    },
  }).cards
  const steps = (status: string, ms: number | null) => [
    { id: "R1 inbound", status, durationMs: ms },
    { id: "R2 open", status, durationMs: ms },
  ]

  test("known latencies in the copy's order; a step one stage lacks is 'not run'", () => {
    const data = comparisonData(
      combined([
        stage({
          summary: {
            tests: [{ project: "orbit", steps: steps("passed", 1_000) }],
            latenciesMs: { secondMs: 900, firstMs: 1_200 },
          },
        }),
        stage({
          title: "Staging",
          result: { verdict: "FAIL", reason: "" },
          runId: "stg-1",
          summary: {
            tests: [
              {
                project: "orbit",
                steps: [{ id: "R1 inbound", status: "failed", durationMs: 9 }],
              },
            ],
            latenciesMs: { customHop: "n/a" },
          },
        }),
      ]),
      cards,
    )
    expect(data.rows[0].cells).toEqual([
      { status: "passed", durationMs: 1_000 },
      { status: "failed", durationMs: 9 },
    ])
    expect(data.rows[1].cells[1]).toEqual({
      status: "not run",
      durationMs: null,
    })
    expect(data.latencies).toEqual([
      { key: "firstMs", label: "First", values: [1_200, null] },
      { key: "secondMs", label: "Second", values: [900, null] },
      { key: "customHop", label: "customHop", values: [null, null] },
    ])
  })

  test("a summary of an unexpected shape, or a stage that did not run, has no data", () => {
    const odd = (summary: unknown) =>
      stage({ summary: summary as CombinedStage["summary"] })
    expect(
      comparisonData(
        combined([
          odd({ tests: "x", latenciesMs: "fast" }),
          odd({ tests: [null] }),
        ]),
        cards,
      ).rows,
    ).toEqual([])
    const skipped = comparisonData(
      combined([
        stage({
          result: { verdict: "skipped", reason: "" },
          summary: { tests: [{ project: "orbit", steps: steps("passed", 1) }] },
        }),
      ]),
      cards,
    )
    expect(skipped.rows).toEqual([])
    expect(skipped.stages[0].runId).toBeNull()
  })
})

test.describe("stage reels", () => {
  const input: TimelineInput = {
    videoDurationSec: 30,
    steps: [
      { id: "R1 inbound", startSec: 2, endSec: 6, status: "passed" },
      { id: "R2 open", startSec: 6, endSec: 10, status: "passed" },
    ],
    mail: [{ atSec: 3 }],
  }
  const reelFiles = {
    appVideo: "test-results/orbit/video.webm",
    frame: "video/frame.png",
    captions: ["video/caption-1.png", "video/caption-2.png"],
    emails: ["video/email-1.png"],
  }
  const all = [
    reelFiles.appVideo,
    reelFiles.frame,
    ...reelFiles.captions,
    ...reelFiles.emails,
  ]
  function runDir(reel: unknown, files: string[] = []): string {
    const dir = tracked(mkdtempSync(join(tmpdir(), "flowreel-reel-")))
    for (const file of files) {
      mkdirSync(join(dir, file, ".."), { recursive: true })
      writeFileSync(join(dir, file), "")
    }
    if (reel !== undefined) {
      mkdirSync(join(dir, "video"), { recursive: true })
      writeFileSync(
        join(dir, REEL_FILE),
        typeof reel === "string" ? reel : JSON.stringify(reel),
      )
    }
    return dir
  }
  const ran = (dir: string | null): CombinedStage =>
    stage({
      result: { verdict: "PASS", reason: "Passed." },
      dir,
      summary: { video: { produced: true } },
    })

  test("readReel: absolute paths inside the run folder, else null", () => {
    const dir = runDir({ input, ...reelFiles })
    expect(readReel(dir)).toEqual({
      input,
      appVideo: join(dir, reelFiles.appVideo),
      frame: join(dir, reelFiles.frame),
      captions: reelFiles.captions.map((c) => join(dir, c)),
      emails: reelFiles.emails.map((e) => join(dir, e)),
    })
    for (const bad of [
      undefined,
      "{ not json",
      { ...reelFiles },
      { input, ...reelFiles, appVideo: "/etc/passwd" },
      { input, ...reelFiles, emails: ["video/../../email-1.png"] },
      { input, ...reelFiles, captions: [1] },
    ]) {
      expect(readReel(runDir(bad))).toBeNull()
    }
  })

  test("stageReel: a stage that did not run, no video, no reel, a mismatch, a missing file", () => {
    expect(
      stageReel(
        stage({
          result: { verdict: "not run", reason: "not run (development FAIL)" },
        }),
      ).note,
    ).toBe("development FAIL")
    expect(
      stageReel(
        stage({
          result: { verdict: "FAIL", reason: "Failed." },
          summary: { video: { produced: false, reason: "ffmpeg not found" } },
        }),
      ).note,
    ).toBe("Failed. No recording: ffmpeg not found.")
    const good = runDir({ input, ...reelFiles }, all)
    expect(stageReel(ran(good)).note).toBeNull()
    expect(stageReel(ran(runDir(undefined, all))).note).toBe(
      "Passed. No recording: the run left no reel.",
    )
    expect(
      stageReel(
        ran(
          runDir(
            { input, ...reelFiles, captions: ["video/caption-1.png"] },
            all,
          ),
        ),
      ).note,
    ).toBe("Passed. No recording: the reel does not match its timeline.")
    expect(
      stageReel(
        ran(
          runDir(
            { input, ...reelFiles },
            all.filter((f) => f !== reelFiles.appVideo),
          ),
        ),
      ).note,
    ).toBe("Passed. No recording: a recording file is missing.")
  })

  test("stageTourBody and the tour manifest", () => {
    const dir = tracked(mkdtempSync(join(tmpdir(), "flowreel-tour-")))
    mkdirSync(join(dir, "video", "tour"), { recursive: true })
    writeFileSync(join(dir, "video", "tour", "A1-reel.mp4"), "")
    writeFileSync(
      join(dir, TOUR_VIDEO_MANIFEST),
      JSON.stringify({
        runId: "loc-1",
        target: "local",
        body: [{ file: "video/tour/A1-reel.mp4", durationSec: 3 }],
        features: [],
        narrated: true,
      }),
    )
    expect(readTourVideoManifest(dir)?.bodyFiles).toEqual([
      join(dir, "video", "tour", "A1-reel.mp4"),
    ])
    const tourStage = (summary: unknown) =>
      stage({
        result: { verdict: "PASS", reason: "Passed." },
        dir,
        summary: summary as CombinedStage["summary"],
      })
    expect(stageTourBody(tourStage({ tourVideo: { produced: true } }))).toEqual(
      {
        files: [join(dir, "video", "tour", "A1-reel.mp4")],
        note: null,
        narrated: true,
      },
    )
    expect(
      stageTourBody(
        tourStage({ tourVideo: { produced: false, reason: "off" } }),
      ).note,
    ).toBe("Passed. No tour video: off.")
  })

  test("featureComparison: every feature, in the catalogue's area order", () => {
    const summary = (list: unknown[]) =>
      ({ features: list }) as unknown as CombinedStage["summary"]
    const f = (id: string, status: string) => ({
      id,
      title: id,
      area: id[0],
      status,
      durationMs: 1,
    })
    const data = featureComparison(
      combined([
        stage({ summary: summary([f("G1", "passed"), f("A2", "passed")]) }),
        stage({
          title: "Staging",
          result: { verdict: "FAIL", reason: "" },
          summary: summary([f("A2", "failed")]),
        }),
      ]),
      AREAS,
    )
    expect(data.stages).toEqual(["Development", "Staging"])
    expect(data.rows.map((r) => r.id)).toEqual(["A2", "G1"])
    expect(data.rows[1].cells[1]).toEqual({
      status: "not run",
      durationMs: null,
    })
    expect(tourLabel("orbit-tour")).toBe("orbit tour")
  })

  test("the combined videos never throw", async () => {
    await expect(
      produceCombinedVideo(combined([]), kit, { FLOWREEL_VIDEO: "off" }),
    ).resolves.toEqual({
      produced: false,
      reason: "FLOWREEL_VIDEO=off",
      narration: { produced: false, reason: "no stage video was narrated" },
    })
    await expect(
      produceCombinedTourVideo(
        combined([]),
        kit,
        { module: "orbit-tour", areas: AREAS },
        { FLOWREEL_VIDEO: "off" },
      ),
    ).resolves.toMatchObject({ produced: false, reason: "FLOWREEL_VIDEO=off" })
    test.skip(ffmpegProblem() !== null, "needs ffmpeg to get past the check")
    const file = join(runDir(undefined, ["blocker"]), "blocker")
    const outcome = await produceCombinedVideo(
      combined([], join(file, "pipe")),
      kit,
      {},
    )
    expect(outcome).toHaveProperty("reason", expect.stringContaining("ENOTDIR"))
  })
})
