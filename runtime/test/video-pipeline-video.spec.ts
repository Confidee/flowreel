// SPDX-License-Identifier: Apache-2.0

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"

import { expect, test } from "@playwright/test"

import { createVideoKit } from "../src/video/kit.js"
import {
  type CombinedRequest,
  type CombinedStage,
  combinedFileName,
  featureComparison,
  produceCombinedTourVideo,
  produceCombinedVideo,
  stageReel,
  stageTourBody,
} from "../src/video/pipeline-video.js"
import { SCOREBOARD_ROWS } from "../src/video/tour-cards.js"
import { CARD_LEAD_SEC } from "../src/video/timeline.js"
import { REEL_FILE } from "../src/video/run-video.js"
import { TOUR_VIDEO_MANIFEST } from "../src/video/tour-video.js"
import type { Narrator } from "../src/voice/narrator.js"

import { installFakeMedia, recordingRenderer } from "./fake-media.js"
import type { FakeMedia } from "./fake-media.js"

// produceCombinedVideo / produceCombinedTourVideo end to end against
// stand-in ffmpeg / ffprobe binaries (test/fake-media.ts) and a recording
// PNG renderer: the chapter and comparison cards, what is spliced in per
// stage, program.json, the ffmpeg argument lists, the narrated path and
// its silent fallbacks. Nothing real is encoded or rendered.

const kit = createVideoKit()
const AREAS = [
  { letter: "A", title: "Lists" },
  { letter: "G", title: "Ledger" },
]

const dirs: string[] = []
let media: FakeMedia
test.afterEach(() => {
  media?.restore()
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "flowreel-pipe-"))
  dirs.push(dir)
  return dir
}
const touch = (dir: string, file: string, content = "") => {
  mkdirSync(dirname(join(dir, file)), { recursive: true })
  writeFileSync(join(dir, file), content)
}

const narrator: Narrator = {
  clip: (text) =>
    text
      ? {
          path: `/clips/${text.length}-${text.slice(0, 6)}.wav`,
          seconds: text.length / 10,
        }
      : null,
  seconds: (text) => (text ? text.length / 10 : null),
}
const narratedKit = {
  ...kit,
  prepareNarration: () =>
    Promise.resolve({
      narrator,
      outcome: {
        produced: true as const,
        engine: "fake",
        voice: "Test",
        warning: null,
        lines: 3,
        synthesized: 3,
        cached: 0,
      },
    }),
}

// ---------------------------------------------------------------------------
// A single-flow module's pipeline
// ---------------------------------------------------------------------------

const input = {
  videoDurationSec: 30,
  steps: [
    { id: "R1 inbound", startSec: 2, endSec: 6, status: "passed" as const },
    { id: "R2 open", startSec: 6, endSec: 28, status: "passed" as const },
  ],
  mail: [{ atSec: 3 }],
}
const reelFiles = {
  appVideo: "test-results/orbit/video.webm",
  frame: "video/frame.png",
  captions: ["video/caption-1.png", "video/caption-2.png"],
  emails: ["video/email-1.png"],
}
const allReelFiles = [
  reelFiles.appVideo,
  reelFiles.frame,
  ...reelFiles.captions,
  ...reelFiles.emails,
]

/** A finished stage run folder with a reel (and optionally what it said). */
function reelRun(extra: Record<string, unknown> = {}): string {
  const dir = tmp()
  for (const file of allReelFiles) touch(dir, file)
  touch(dir, REEL_FILE, JSON.stringify({ input, ...reelFiles, ...extra }))
  return dir
}
const SAID = {
  captions: ["First step said.", "Second step said."],
  mail: ["Mail said."],
}

const stageOf = (overrides: Partial<CombinedStage> = {}): CombinedStage => ({
  result: { verdict: "PASS", reason: "Passed." },
  title: "Development",
  detail: "local",
  runId: "loc-run",
  dir: null,
  summary: { video: { produced: true } },
  ...overrides,
})
const requestOf = (stages: CombinedStage[]): CombinedRequest => ({
  module: "orbit",
  pipelineId: "pipe-run",
  dir: tmp(),
  startedAt: new Date(0),
  verdict: "PASS",
  reason: "Both passed.",
  stages,
})
const notRun = (): CombinedStage =>
  stageOf({
    title: "Staging",
    result: { verdict: "not run", reason: "not run (development FAIL)" },
    runId: null,
    summary: null,
  })

const programOf = (req: CombinedRequest) =>
  JSON.parse(readFileSync(join(req.dir, "video", "program.json"), "utf8"))

test.describe("produceCombinedVideo", () => {
  test("silent: intro, chapter + reel per stage, comparison; one composeProgram call", async () => {
    media = installFakeMedia()
    const renderer = recordingRenderer()
    const req = requestOf([
      stageOf({ dir: reelRun() }),
      stageOf({ title: "Staging", runId: "stg-run", dir: reelRun() }),
    ])
    const outcome = await produceCombinedVideo(req, kit, {}, renderer.render)
    expect(outcome).toEqual({
      produced: true,
      path: join(req.dir, "orbit-pipe-run.mp4"),
      durationSec: 10,
      narration: { produced: false, reason: "no stage video was narrated" },
    })
    expect(combinedFileName("orbit", "pipe-run")).toBe("orbit-pipe-run.mp4")
    expect(existsSync(join(req.dir, "orbit-pipe-run.mp4"))).toBe(true)

    // Cards were rendered once each; the speed badge of the long wait too.
    const names = renderer.jobs.map((j) => j.path.split("/").pop())
    expect(names.slice(0, 2)).toEqual(["intro.png", "chapter-1.png"])
    expect(names.filter((n) => n?.startsWith("stage-1-speed-"))).toHaveLength(1)
    expect(names).toContain("outro.png")
    expect(names).toContain("chapter-2.png")

    const ffmpeg = media.calls("ffmpeg")
    expect(ffmpeg).toHaveLength(1)
    expect(ffmpeg[0].args[ffmpeg[0].args.length - 1]).toBe(
      join(req.dir, "orbit-pipe-run.mp4"),
    )
    expect(ffmpeg[0].args).not.toContain("anullsrc")

    const program = programOf(req)
    expect(program.narration).toEqual([])
    expect(program.parts.map((p: { kind: string }) => p.kind)).toEqual([
      "still",
      "still",
      "reel",
      "still",
      "reel",
      "still",
    ])
    expect(program.parts[0]).toMatchObject({
      startSec: 0,
      path: "video/intro.png",
      durationSec: 4,
    })
    expect(program.parts[1]).toMatchObject({
      path: "video/chapter-1.png",
      durationSec: 2.5,
      startSec: 4,
    })
    expect(program.parts[2].appVideo).toBe(
      relative(
        req.dir,
        join(req.stages[0].dir!, "test-results/orbit/video.webm"),
      ),
    )
    expect(program.parts[2].startSec).toBe(6.5)
    expect(program.parts.at(-1)).toMatchObject({
      path: "video/outro.png",
      durationSec: 7,
    })
  })

  test("a stage with nothing to play gets its chapter card alone, with the reason", async () => {
    media = installFakeMedia()
    const renderer = recordingRenderer()
    const req = requestOf([stageOf({ dir: reelRun() }), notRun()])
    const outcome = await produceCombinedVideo(req, kit, {}, renderer.render)
    expect(outcome.produced).toBe(true)
    const program = programOf(req)
    expect(program.parts.map((p: { kind: string }) => p.kind)).toEqual([
      "still",
      "still",
      "reel",
      "still",
      "still",
    ])
    expect(program.parts[3]).toMatchObject({
      path: "video/chapter-2.png",
      durationSec: 5,
    })
    const chapter = renderer.jobs.find((j) => j.path.endsWith("chapter-2.png"))!
    expect(chapter.html).toContain("development FAIL")
  })

  test("narrated: clips on the program clock, spoken lines in program.json", async () => {
    media = installFakeMedia()
    const req = requestOf([
      stageOf({ dir: reelRun({ narration: SAID }) }),
      notRun(),
    ])
    const outcome = await produceCombinedVideo(
      req,
      narratedKit,
      {},
      recordingRenderer().render,
    )
    expect(outcome).toMatchObject({
      produced: true,
      narration: { produced: true, engine: "fake" },
    })
    const ffmpeg = media.calls("ffmpeg")
    expect(ffmpeg).toHaveLength(1)
    expect(
      ffmpeg[0].args.filter((a) => a.startsWith("/clips/")).length,
    ).toBeGreaterThan(3)
    const spoken = programOf(req).narration as { atSec: number; text: string }[]
    const texts = spoken.map((s) => s.text)
    expect(texts).toContain("First step said.")
    expect(texts).toContain("Second step said.")
    expect(texts).toContain("Mail said.")
    expect(texts).toContain(kit.narration.copy.pipeline.intro)
    expect(spoken[0].atSec).toBe(CARD_LEAD_SEC) // the intro card's lead-in
    // Nothing is said before the previous thing: times never go backwards.
    expect(spoken.map((s) => s.atSec)).toEqual(
      [...spoken.map((s) => s.atSec)].sort((a, b) => a - b),
    )
  })

  test("a narrated cut that fails is redone silent, with the reason", async () => {
    media = installFakeMedia({ fail: "/clips/" })
    const req = requestOf([stageOf({ dir: reelRun({ narration: SAID }) })])
    const outcome = await produceCombinedVideo(
      req,
      narratedKit,
      {},
      recordingRenderer().render,
    )
    expect(outcome).toMatchObject({
      produced: true,
      narration: {
        produced: false,
        reason:
          "the narrated video failed (ffmpeg failed: fake ffmpeg refused | second line)",
      },
    })
    expect(programOf(req).narration).toEqual([])
  })

  test("a non-Error from the narrated cut is still a reason", async () => {
    media = installFakeMedia()
    let renders = 0
    const outcome = await produceCombinedVideo(
      requestOf([stageOf({ dir: reelRun({ narration: SAID }) })]),
      narratedKit,
      {},
      (jobs) => {
        if (renders++ === 0) {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw "render exploded\nmore"
        }
        return recordingRenderer().render(jobs)
      },
    )
    expect(outcome).toMatchObject({
      produced: true,
      narration: {
        produced: false,
        reason: "the narrated video failed (render exploded)",
      },
    })
  })

  test("a voice that could not be prepared leaves the silent video and its reason", async () => {
    media = installFakeMedia()
    const outcome = await produceCombinedVideo(
      requestOf([stageOf({ dir: reelRun({ narration: SAID }) })]),
      {
        ...kit,
        prepareNarration: () =>
          Promise.resolve({
            narrator: null,
            outcome: { produced: false as const, reason: "no voice installed" },
          }),
      },
      {},
      recordingRenderer().render,
    )
    expect(outcome).toMatchObject({
      produced: true,
      narration: { produced: false, reason: "no voice installed" },
    })
  })

  test("FLOWREEL_NARRATION=off silences a narrated stage", async () => {
    media = installFakeMedia()
    const outcome = await produceCombinedVideo(
      requestOf([stageOf({ dir: reelRun({ narration: SAID }) })]),
      narratedKit,
      { FLOWREEL_NARRATION: "off" },
      recordingRenderer().render,
    )
    expect(outcome).toMatchObject({
      produced: true,
      narration: { produced: false, reason: "no stage video was narrated" },
    })
  })

  test("never throws: video off, no ffmpeg, a failing cut", async () => {
    media = installFakeMedia()
    const render = recordingRenderer().render
    const req = requestOf([stageOf({ dir: reelRun() })])
    await expect(
      produceCombinedVideo(req, kit, { FLOWREEL_VIDEO: "off" }, render),
    ).resolves.toMatchObject({ produced: false, reason: "FLOWREEL_VIDEO=off" })
    expect(media.calls()).toEqual([])
    media.restore()

    media = installFakeMedia({ tools: false })
    await expect(
      produceCombinedVideo(req, kit, {}, render),
    ).resolves.toMatchObject({
      produced: false,
      reason: "ffmpeg not found on PATH (install it, e.g. brew install ffmpeg)",
    })
    media.restore()

    media = installFakeMedia({ fail: "\\.mp4" })
    await expect(
      produceCombinedVideo(req, kit, {}, render),
    ).resolves.toMatchObject({
      produced: false,
      reason: "ffmpeg failed: fake ffmpeg refused | second line",
    })
  })

  test("a reel that no longer matches its timeline is dropped from the video", async () => {
    media = installFakeMedia()
    const dir = reelRun({ captions: ["video/caption-1.png"] })
    const req = requestOf([stageOf({ dir })])
    await produceCombinedVideo(req, kit, {}, recordingRenderer().render)
    expect(programOf(req).parts.map((p: { kind: string }) => p.kind)).toEqual([
      "still",
      "still",
      "still",
    ])
  })
})

// ---------------------------------------------------------------------------
// A tour's pipeline
// ---------------------------------------------------------------------------

const summaryFeature = (id: string, status: string) => ({
  id,
  title: `${id.toLowerCase()}-slug`,
  area: id[0],
  status,
  durationMs: 100,
})

/** A finished tour run folder: tour.json + its body parts. */
function tourRun(narrated = false, missing = false): string {
  const dir = tmp()
  const body = [
    "video/tour/area-A-chapter-2.mp4",
    "video/tour/A2-title-1.5.mp4",
    "video/tour/A2-reel.mp4",
  ]
  for (const file of body.slice(0, missing ? 2 : 3)) touch(dir, file)
  touch(
    dir,
    TOUR_VIDEO_MANIFEST,
    JSON.stringify({
      runId: "loc-run",
      target: "local",
      body: body.map((file) => ({ file, durationSec: 1 })),
      features: [],
      narrated,
    }),
  )
  return dir
}
const tourStage = (overrides: Partial<CombinedStage> = {}): CombinedStage =>
  stageOf({
    summary: {
      tourVideo: { produced: true },
      features: [summaryFeature("A2", "passed")],
    } as CombinedStage["summary"],
    ...overrides,
  })
const TOUR = { module: "orbit-tour", areas: AREAS }
const parts = (req: CombinedRequest) =>
  JSON.parse(readFileSync(join(req.dir, "video", "program.json"), "utf8"))
    .parts as string[]

test.describe("produceCombinedTourVideo", () => {
  test("silent: intro, chapter + the stage's tour body per stage, scoreboard", async () => {
    media = installFakeMedia()
    const renderer = recordingRenderer()
    const dir = tourRun()
    const req = requestOf([tourStage({ dir }), notRun()])
    const outcome = await produceCombinedTourVideo(
      req,
      kit,
      TOUR,
      {},
      renderer.render,
    )
    expect(outcome).toEqual({
      produced: true,
      path: join(req.dir, "orbit-pipe-run.mp4"),
      durationSec: 10,
      narration: { produced: false, reason: "no stage video was narrated" },
    })
    expect(parts(req)).toEqual([
      "video/intro.mp4",
      "video/chapter-1.mp4",
      relative(req.dir, join(dir, "video/tour/area-A-chapter-2.mp4")),
      relative(req.dir, join(dir, "video/tour/A2-title-1.5.mp4")),
      relative(req.dir, join(dir, "video/tour/A2-reel.mp4")),
      "video/chapter-2.mp4",
      "video/score-1.mp4",
    ])
    // The intro names the tour, not its module slug.
    const intro = renderer.jobs.find((j) => j.path.endsWith("intro.png"))!
    expect(intro.html).toContain("Orbit tour")
    // One scoreboard with both stages as columns.
    const score = renderer.jobs.find((j) => j.path.endsWith("score-1.png"))!
    expect(score.html).toContain("a2-slug")
    expect(score.html).toContain("Staging")
    // Stills are encoded one by one, then joined by copy without audio.
    const ffmpeg = media.calls("ffmpeg")
    const outputs = ffmpeg.map((c) =>
      c.args[c.args.length - 1].split("/").pop(),
    )
    expect(outputs).toEqual([
      "intro.mp4",
      "chapter-1.mp4",
      "chapter-2.mp4",
      "score-1.mp4",
      "orbit-pipe-run.mp4",
    ])
    const concat = ffmpeg.at(-1)!
    expect(concat.args).toContain("copy")
    expect(concat.args).toContain("-an")
    const list = readFileSync(join(req.dir, "video", "program.txt"), "utf8")
    expect(list.split("\n").filter(Boolean)).toHaveLength(7)
    expect(list).toContain(`file '${join(req.dir, "video", "intro.mp4")}'`)
  })

  test("a stage whose tour part is missing gets a lone chapter card", async () => {
    media = installFakeMedia()
    const renderer = recordingRenderer()
    const req = requestOf([tourStage({ dir: tourRun(false, true) })])
    await produceCombinedTourVideo(req, kit, TOUR, {}, renderer.render)
    expect(parts(req)).toEqual([
      "video/intro.mp4",
      "video/chapter-1.mp4",
      "video/score-1.mp4",
    ])
    const chapter = renderer.jobs.find((j) => j.path.endsWith("chapter-1.png"))!
    expect(chapter.html).toContain("a part is missing")
  })

  test("many features paginate the scoreboard, the first page speaks the outro", async () => {
    media = installFakeMedia()
    const many = Array.from({ length: SCOREBOARD_ROWS + 1 }, (_, i) =>
      summaryFeature(`A${i + 1}`, "passed"),
    )
    const renderer = recordingRenderer()
    const req = requestOf([
      tourStage({
        dir: tourRun(),
        summary: {
          tourVideo: { produced: true },
          features: many,
        } as CombinedStage["summary"],
      }),
    ])
    await produceCombinedTourVideo(req, kit, TOUR, {}, renderer.render)
    const stills = parts(req).filter((p) => p.includes("score-"))
    expect(stills).toEqual(["video/score-1.mp4", "video/score-2.mp4"])
  })

  test("narrated: cards say their line, joined parts get a sound track", async () => {
    media = installFakeMedia({ noAudio: "A2-reel" })
    const req = requestOf([tourStage({ dir: tourRun(true) }), notRun()])
    const outcome = await produceCombinedTourVideo(
      req,
      narratedKit,
      TOUR,
      {},
      recordingRenderer().render,
    )
    expect(outcome).toMatchObject({
      produced: true,
      narration: { produced: true, engine: "fake" },
    })
    const ffmpeg = media.calls("ffmpeg")
    const intro = ffmpeg.find((c) => c.args.at(-1)!.endsWith("intro.mp4"))!
    expect(intro.args.some((a) => a.startsWith("/clips/"))).toBe(true)
    // Only the first scoreboard page has a line; the rest are silent stills.
    const concat = ffmpeg.at(-1)!
    expect(concat.args).not.toContain("-an")
    // The reel without audio was copied with a silent track first.
    expect(
      ffmpeg.some((c) => c.args.includes("anullsrc=r=48000:cl=mono")),
    ).toBe(true)
  })

  test("a narrated join that fails is redone silent, with the reason", async () => {
    media = installFakeMedia({ fail: "/clips/" })
    const req = requestOf([tourStage({ dir: tourRun(true) })])
    const outcome = await produceCombinedTourVideo(
      req,
      narratedKit,
      TOUR,
      {},
      recordingRenderer().render,
    )
    expect(outcome).toMatchObject({
      produced: true,
      narration: {
        produced: false,
        reason:
          "the narrated video failed (ffmpeg failed: fake ffmpeg refused | second line)",
      },
    })
    const concat = media.calls("ffmpeg").at(-1)!
    expect(concat.args).toContain("-an")
  })

  test("a non-Error from the narrated join is still a reason", async () => {
    media = installFakeMedia()
    let encodes = 0
    const flaky = {
      ...narratedKit,
      prepareNarration: () =>
        Promise.resolve({
          narrator: {
            ...narrator,
            clip: (text: string | null | undefined) => {
              if (encodes++ === 0) {
                // eslint-disable-next-line @typescript-eslint/only-throw-error
                throw "clip exploded\nmore"
              }
              return narrator.clip(text)
            },
          },
          outcome: {
            produced: true as const,
            engine: "fake",
            voice: "Test",
            warning: null,
            lines: 1,
            synthesized: 1,
            cached: 0,
          },
        }),
    }
    const outcome = await produceCombinedTourVideo(
      requestOf([tourStage({ dir: tourRun(true) })]),
      flaky,
      TOUR,
      {},
      recordingRenderer().render,
    )
    expect(outcome).toMatchObject({
      produced: true,
      narration: {
        produced: false,
        reason: "the narrated video failed (clip exploded)",
      },
    })
  })

  test("a tour that was narrated but whose voice is unavailable is joined silent", async () => {
    media = installFakeMedia()
    const outcome = await produceCombinedTourVideo(
      requestOf([tourStage({ dir: tourRun(true) })]),
      {
        ...kit,
        prepareNarration: () =>
          Promise.resolve({
            narrator: null,
            outcome: { produced: false as const, reason: "no voice installed" },
          }),
      },
      TOUR,
      {},
      recordingRenderer().render,
    )
    expect(outcome).toMatchObject({
      produced: true,
      narration: { produced: false, reason: "no voice installed" },
    })
  })

  test("FLOWREEL_NARRATION=off keeps a narrated tour silent", async () => {
    media = installFakeMedia()
    const outcome = await produceCombinedTourVideo(
      requestOf([tourStage({ dir: tourRun(true) })]),
      narratedKit,
      TOUR,
      { FLOWREEL_NARRATION: "off" },
      recordingRenderer().render,
    )
    expect(outcome).toMatchObject({
      produced: true,
      narration: { produced: false, reason: "no stage video was narrated" },
    })
  })

  test("never throws: no ffmpeg, a failing join, a non-Error", async () => {
    const render = recordingRenderer().render
    const req = requestOf([tourStage({ dir: tourRun() })])
    media = installFakeMedia({ tools: false })
    await expect(
      produceCombinedTourVideo(req, kit, TOUR, {}, render),
    ).resolves.toMatchObject({
      produced: false,
      reason: "ffmpeg not found on PATH (install it, e.g. brew install ffmpeg)",
    })
    media.restore()

    media = installFakeMedia({ fail: "\\.mp4" })
    await expect(
      produceCombinedTourVideo(req, kit, TOUR, {}, render),
    ).resolves.toMatchObject({
      produced: false,
      reason: "ffmpeg failed: fake ffmpeg refused | second line",
    })
    media.restore()

    media = installFakeMedia()
    await expect(
      produceCombinedTourVideo(req, kit, TOUR, {}, () =>
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        Promise.reject("plain string\nsecond"),
      ),
    ).resolves.toMatchObject({ produced: false, reason: "plain string" })
  })
})

// ---------------------------------------------------------------------------
// The planning helpers' remaining branches
// ---------------------------------------------------------------------------

test.describe("stage helpers", () => {
  test("stageTourBody: not run, no tour.json, empty body, missing part", () => {
    expect(
      stageTourBody(
        stageOf({
          result: { verdict: "skipped", reason: "skipped (no tour)" },
        }),
      ),
    ).toEqual({ files: null, note: "no tour" })
    expect(stageTourBody(stageOf({ summary: null })).note).toBe(
      "Passed. No tour video: it was not produced.",
    )
    const noManifest = tourStage({ dir: tmp() })
    expect(stageTourBody(noManifest).note).toBe(
      "Passed. No tour video: the run left no tour.json.",
    )
    expect(stageTourBody(tourStage({ dir: null })).note).toBe(
      "Passed. No tour video: the run left no tour.json.",
    )
    const empty = tmp()
    touch(
      empty,
      TOUR_VIDEO_MANIFEST,
      JSON.stringify({ body: [], features: [] }),
    )
    expect(stageTourBody(tourStage({ dir: empty })).note).toBe(
      "Passed. No tour video: the run left no tour.json.",
    )
    expect(stageTourBody(tourStage({ dir: tourRun(false, true) })).note).toBe(
      "Passed. No tour video: a part is missing.",
    )
    expect(stageTourBody(tourStage({ dir: tourRun() }))).toMatchObject({
      note: null,
      narrated: false,
    })
  })

  test("stageReel: a stage with no run folder, and a skipped note keeps its text", () => {
    expect(stageReel(stageOf({ dir: null })).note).toBe(
      "Passed. No recording: the run left no reel.",
    )
    expect(
      stageReel(
        stageOf({ result: { verdict: "skipped", reason: "plain reason" } }),
      ).note,
    ).toBe("plain reason")
    expect(stageReel(stageOf({ summary: null })).note).toBe(
      "Passed. No recording: the run video was not produced.",
    )
  })

  test("stageReel: a recording file that is gone", () => {
    const dir = reelRun()
    rmSync(join(dir, reelFiles.appVideo))
    expect(stageReel(stageOf({ dir })).note).toBe(
      "Passed. No recording: a recording file is missing.",
    )
  })

  test("the tour video is off: the reason, and ffmpeg is never run", async () => {
    media = installFakeMedia()
    await expect(
      produceCombinedTourVideo(
        requestOf([tourStage({ dir: tourRun() })]),
        kit,
        TOUR,
        { FLOWREEL_VIDEO: "off" },
        recordingRenderer().render,
      ),
    ).resolves.toEqual({
      produced: false,
      reason: "FLOWREEL_VIDEO=off",
      narration: { produced: false, reason: "no stage video was narrated" },
    })
    expect(media.calls()).toEqual([])
  })

  test("featureComparison: a feature one stage lacks is 'not run' there", () => {
    const only = (id: string) =>
      stageOf({
        summary: {
          features: [summaryFeature(id, "passed")],
        } as unknown as CombinedStage["summary"],
      })
    const data = featureComparison(requestOf([only("A1"), only("A2")]), AREAS)
    expect(data.rows.map((r) => r.cells)).toEqual([
      [
        { status: "passed", durationMs: 100 },
        { status: "not run", durationMs: null },
      ],
      [
        { status: "not run", durationMs: null },
        { status: "passed", durationMs: 100 },
      ],
    ])
  })

  test("featureComparison: stage without features, an entry without an id, ties by number", () => {
    const withFeatures = (features: unknown) =>
      stageOf({ summary: { features } as unknown as CombinedStage["summary"] })
    const data = featureComparison(
      requestOf([
        withFeatures([
          summaryFeature("A10", "passed"),
          summaryFeature("A2", "passed"),
          { id: 5 },
          { ...summaryFeature("A3", "failed"), durationMs: undefined },
        ]),
        withFeatures("nope"),
        notRun(),
      ]),
      AREAS,
    )
    expect(data.rows.map((r) => r.id)).toEqual(["A2", "A3", "A10"])
    expect(data.rows[1].cells).toEqual([
      { status: "failed", durationMs: null },
      null,
      null,
    ])
  })

  test("featureComparison: a null entry beside real features does not lose the table", () => {
    const withFeatures = (features: unknown) =>
      stageOf({ summary: { features } as unknown as CombinedStage["summary"] })
    const data = featureComparison(
      requestOf([
        withFeatures([summaryFeature("A1", "passed")]),
        withFeatures([null, summaryFeature("A1", "failed")]),
      ]),
      AREAS,
    )
    expect(data.rows.map((r) => r.id)).toEqual(["A1"])
    expect(data.rows[0].cells.map((c) => c?.status)).toEqual([
      "passed",
      "failed",
    ])
  })
})
