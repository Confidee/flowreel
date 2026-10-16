// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "@playwright/test"

import { createVideoKit } from "../src/video/kit.js"
import type { MailEvent } from "../src/video/recorder.js"
import { SCOREBOARD_ROWS } from "../src/video/tour-cards.js"
import {
  TOUR_VIDEO_MANIFEST,
  type TourCard,
  type TourFeatureRecord,
  type TourVideoArea,
  type TourVideoRequest,
  areasOf,
  cardArea,
  cardHoldSec,
  cardLineData,
  cardName,
  hasReel,
  planAreaVideo,
  planTourVideo,
  produceTourVideos,
  readTourVideoManifest,
  scoreRows,
} from "../src/video/tour-video.js"
import type { Narrator } from "../src/voice/narrator.js"

import { installFakeMedia, recordingRenderer } from "./fake-media.js"
import type { FakeMedia } from "./fake-media.js"

// produceTourVideos end to end against stand-in ffmpeg / ffprobe binaries
// (test/fake-media.ts) and a recording PNG renderer: which files are cut,
// the ffmpeg argument lists, the joins, tour.json, the narrated path and
// every fallback. Nothing real is encoded or rendered.

const kit = createVideoKit()

const AREAS: TourVideoArea[] = [
  { letter: "A", title: "Lists" },
  { letter: "F", title: "Admin" },
  { letter: "G", title: "Ledger" },
]

const mail = (at: number): MailEvent => ({
  at,
  step: "A2.1 open",
  direction: "received",
  from: "a@example.test",
  to: ["b@example.test"],
  replyTo: [],
  subject: "Hello",
  excerpt: "Body",
})

const rec = (
  start: number,
  withMail = false,
  personas = ["admin", "Ops Lead!"],
): NonNullable<TourFeatureRecord["recording"]> => ({
  videoPath: "/rec/page.webm",
  log: {
    videoStartedAt: start,
    mail: withMail ? [mail(start + 2_000)] : [],
    personas: personas.map((persona, i) => ({
      persona,
      at: start + 4_000 + i * 1_000,
    })),
  },
  steps: [
    { id: "X.1 a", startMs: start + 1_000, durationMs: 2_000, failed: false },
    { id: "X.2 b", startMs: start + 3_500, durationMs: 3_000, failed: true },
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

const FEATURES = [
  feature("A2", "passed", { recording: rec(1_000_000, true) }),
  feature("A5", "failed"),
  feature("F3", "view-only", { policy: "view" }),
  feature("G1", "dev-only", { policy: "dev", reason: "append-only ledger" }),
]
const TOUR = { module: "orbit-tour", areas: AREAS, initialPersona: "agent" }

const dirs: string[] = []
let media: FakeMedia
test.afterEach(() => {
  media?.restore()
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})
const runDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "flowreel-tour-run-"))
  dirs.push(dir)
  return dir
}
const request = (
  overrides: Partial<TourVideoRequest> = {},
): TourVideoRequest => ({
  runId: "loc-x",
  target: "local",
  pace: "qa",
  dir: runDir(),
  startedAt: new Date(0),
  verdict: "PASS",
  features: FEATURES,
  ...overrides,
})

/** A stand-in voice: a clip per distinct line, `seconds` = length / 10. */
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

test.describe("produceTourVideos, silent (qa pace)", () => {
  test("cuts every part, joins the areas and the tour, writes tour.json", async () => {
    media = installFakeMedia()
    const renderer = recordingRenderer()
    const req = request({ target: "staging" })
    const outcome = await produceTourVideos(req, kit, TOUR, {}, renderer.render)

    expect(outcome).toMatchObject({
      produced: true,
      pace: { pace: "qa", slowFactor: 1 },
      narration: { produced: false, reason: "off at qa pace" },
    })
    if (!outcome.produced) throw new Error("not produced")
    expect(outcome.areas.map((a) => [a.area, a.path])).toEqual([
      ["A", join(req.dir, "tour-a-loc-x.mp4")],
      ["F", join(req.dir, "tour-f-loc-x.mp4")],
      ["G", join(req.dir, "tour-g-loc-x.mp4")],
    ])
    expect(outcome.areas.every((a) => a.durationSec === 10)).toBe(true)
    expect(outcome.tour).toEqual({
      path: join(req.dir, "orbit-tour-loc-x.mp4"),
      durationSec: 10,
    })
    for (const a of outcome.areas) expect(existsSync(a.path)).toBe(true)

    // Every card still and every feature's PNG overlays were rendered.
    const names = renderer.jobs.map((j) => j.path.split("/").pop())
    for (const expected of [
      "A2-frame.png",
      "A2-caption-1.png",
      "A2-caption-2.png",
      "A2-email-1.png",
      "tour-intro.png",
      "area-A-intro.png",
      "area-A-chapter.png",
      "A2-title.png",
      "A5-title.png",
      "F3-view.png",
      "G1-dev-only.png",
      "area-A-score-1.png",
      "tour-summary.png",
      "tour-score-1.png",
    ]) {
      expect(names).toContain(expected)
    }
    // Persona badges are named by persona and rendered once across reels.
    expect(names.filter((n) => n === "persona-agent.png")).toHaveLength(1)
    expect(names).toContain("persona-Ops-Lead-.png")
    expect(new Set(names).size).toBe(names.length)
    const frame = renderer.jobs.find((j) => j.path.endsWith("A2-frame.png"))!
    expect(frame.transparent).toBe(true)
    expect(frame.html).toContain("A2 a2-slug")
    // The summary card names each area's outcome: failed / passed / dev-only.
    const summary = renderer.jobs.find((j) =>
      j.path.endsWith("tour-summary.png"),
    )!
    expect(summary.html).toContain("Lists")

    // ffmpeg: one encode per distinct card and reel, silent (no audio input).
    const ffmpeg = media.calls("ffmpeg")
    const encodes = ffmpeg.filter((c) =>
      c.args[c.args.length - 1].endsWith("-reel.mp4"),
    )
    expect(
      encodes.map((c) => c.args[c.args.length - 1].split("/").pop()),
    ).toEqual(["A2-reel.mp4", "A5-reel.mp4", "F3-reel.mp4"])
    expect(ffmpeg.some((c) => c.args.includes("anullsrc"))).toBe(false)
    // Joins: copy first, one per area plus the tour, no audio.
    const joins = ffmpeg.filter((c) => c.args.includes("concat"))
    expect(joins).toHaveLength(4)
    for (const j of joins) {
      expect(j.args).toContain("-an")
      expect(j.args).toContain("copy")
    }
    const list = readFileSync(
      join(req.dir, "video", "tour", "area-F.txt"),
      "utf8",
    )
    expect(list.split("\n").filter(Boolean)).toEqual([
      `file '${join(req.dir, "video", "tour", "area-F-intro-3.mp4")}'`,
      `file '${join(req.dir, "video", "tour", "F3-view-3.mp4")}'`,
      `file '${join(req.dir, "video", "tour", "F3-reel.mp4")}'`,
      `file '${join(req.dir, "video", "tour", "area-F-score-1-4.mp4")}'`,
    ])

    // tour.json: parts in tour order, the real (probed) lengths, not narrated.
    const manifest = JSON.parse(
      readFileSync(join(req.dir, TOUR_VIDEO_MANIFEST), "utf8"),
    )
    expect(manifest).toMatchObject({
      runId: "loc-x",
      target: "staging",
      narrated: false,
      features: [
        {
          id: "A2",
          title: "a2-slug",
          area: "A",
          status: "passed",
          durationMs: 5000,
        },
        { id: "A5", status: "failed" },
        { id: "F3", status: "view-only" },
        { id: "G1", status: "dev-only" },
      ],
    })
    expect(manifest.body[0]).toEqual({
      file: "video/tour/area-A-chapter-2.mp4",
      durationSec: 2.02,
    })
    expect(manifest.body[2]).toEqual({
      file: "video/tour/A2-reel.mp4",
      durationSec: 12,
      feature: "A2",
    })
    expect(manifest.cards).toEqual({}) // silent: no card lines were said
    expect(Object.keys(manifest.reels)).toEqual(["A2", "A5", "F3"])
    expect(manifest.reels.A2.narration).toEqual([])
    expect(manifest.featureStarts).toEqual(outcome.featureStarts)
    expect(outcome.featureStarts.A2).toBeCloseTo(4.02 + 2.02, 5)
    expect(manifest.starts).toHaveLength(manifest.body.length + 3)
    // readTourVideoManifest reads it back with absolute body files.
    const read = readTourVideoManifest(req.dir)!
    expect(read.narrated).toBe(false)
    expect(read.bodyFiles[0]).toBe(
      join(req.dir, "video", "tour", "area-A-chapter-2.mp4"),
    )
  })

  test("the development target names its cards differently from staging", async () => {
    media = installFakeMedia()
    const staging = recordingRenderer()
    const dev = recordingRenderer()
    await produceTourVideos(
      request({ target: "staging" }),
      kit,
      TOUR,
      {},
      staging.render,
    )
    await produceTourVideos(
      request({ target: "local" }),
      kit,
      TOUR,
      {},
      dev.render,
    )
    const board = (r: typeof staging) =>
      r.jobs.find((j) => j.path.endsWith("tour-score-1.png"))!.html
    expect(board(staging)).toContain(kit.cards.copy.tour.targetName.staging)
    expect(board(dev)).toContain(kit.cards.copy.tour.targetName.development)
  })

  test("a failure while cutting is the reason, not a throw", async () => {
    media = installFakeMedia({ fail: "\\.mp4" })
    const outcome = await produceTourVideos(
      request(),
      kit,
      TOUR,
      {},
      recordingRenderer().render,
    )
    expect(outcome).toMatchObject({
      produced: false,
      reason: "ffmpeg failed: fake ffmpeg refused | second line",
      narration: { produced: false, reason: "off at qa pace" },
    })
  })

  test("no ffmpeg on PATH is the reason", async () => {
    media = installFakeMedia({ tools: false })
    await expect(
      produceTourVideos(request(), kit, TOUR, {}, recordingRenderer().render),
    ).resolves.toMatchObject({
      produced: false,
      reason: "ffmpeg not found on PATH (install it, e.g. brew install ffmpeg)",
    })
  })

  test("features that all lack a recording still make area and tour videos", async () => {
    media = installFakeMedia()
    const req = request({
      features: [feature("G1", "dev-only"), feature("A1", "N/A")],
    })
    const outcome = await produceTourVideos(
      req,
      kit,
      TOUR,
      {},
      recordingRenderer().render,
    )
    expect(outcome.produced).toBe(true)
    const manifest = JSON.parse(
      readFileSync(join(req.dir, TOUR_VIDEO_MANIFEST), "utf8"),
    )
    expect(manifest.reels).toEqual({})
    expect(manifest.body.every((b: { feature?: string }) => !b.feature)).toBe(
      true,
    )
  })
})

test.describe("long waits", () => {
  // One step that never ended (durationMs < 0) runs to the end of the 30 s
  // recording: a 29 s wait.
  const waiting = feature("A9", "passed", {
    recording: {
      ...rec(1_000_000),
      steps: [
        { id: "X.1 wait", startMs: 1_001_000, durationMs: -1, failed: false },
      ],
    },
  })

  test("qa pace plays it faster and renders a speed badge", async () => {
    media = installFakeMedia()
    const renderer = recordingRenderer()
    const req = request({ features: [waiting] })
    await produceTourVideos(req, kit, TOUR, {}, renderer.render)
    const badges = renderer.jobs.filter((j) =>
      /A9-speed-\d+\.png$/.test(j.path),
    )
    expect(badges).toHaveLength(1)
    expect(badges[0].transparent).toBe(true)
    const manifest = JSON.parse(
      readFileSync(join(req.dir, TOUR_VIDEO_MANIFEST), "utf8"),
    )
    expect(
      manifest.reels.A9.segments.some(
        (s: { kind: string; speed: number }) => s.kind === "app" && s.speed > 1,
      ),
    ).toBe(true)
    const fast = manifest.reels.A9.segments.find(
      (s: { kind: string; speed: number }) => s.kind === "app" && s.speed > 1,
    )
    expect(badges[0].html).toBe(kit.cards.speedHtml(fast.speed))
  })

  test("demo pace keeps real time and renders a wait badge", async () => {
    media = installFakeMedia()
    const renderer = recordingRenderer()
    const req = request({ features: [waiting], pace: "demo" })
    await produceTourVideos(
      req,
      kit,
      TOUR,
      { FLOWREEL_NARRATION: "off" },
      renderer.render,
    )
    expect(renderer.jobs.some((j) => /A9-speed-\d+\.png$/.test(j.path))).toBe(
      true,
    )
    const manifest = JSON.parse(
      readFileSync(join(req.dir, TOUR_VIDEO_MANIFEST), "utf8"),
    )
    expect(
      manifest.reels.A9.segments.some((s: { wait?: true }) => s.wait),
    ).toBe(true)
    expect(manifest.narrated).toBe(false)
  })
})

test.describe("produceTourVideos, nothing to make", () => {
  test("video off and no features are reasons", async () => {
    media = installFakeMedia()
    const render = recordingRenderer().render
    await expect(
      produceTourVideos(
        request(),
        kit,
        TOUR,
        { FLOWREEL_VIDEO: "off" },
        render,
      ),
    ).resolves.toMatchObject({ produced: false, reason: "FLOWREEL_VIDEO=off" })
    await expect(
      produceTourVideos(request({ features: [] }), kit, TOUR, {}, render),
    ).resolves.toMatchObject({ produced: false, reason: "no tour feature ran" })
    expect(media.calls("ffmpeg")).toEqual([])
  })
})

test.describe("produceTourVideos, narrated", () => {
  const demo = { FLOWREEL_PACE: "demo" }

  test("every part carries a sound track and tour.json says what was said", async () => {
    media = installFakeMedia({ noAudio: "chapter" })
    const renderer = recordingRenderer()
    const req = request({ pace: "demo" })
    const outcome = await produceTourVideos(
      req,
      narratedKit,
      TOUR,
      demo,
      renderer.render,
    )
    expect(outcome).toMatchObject({
      produced: true,
      pace: { pace: "demo", slowFactor: 1.5 },
      narration: { produced: true, engine: "fake" },
    })
    const ffmpeg = media.calls("ffmpeg")
    // Cards that have a line carry its clip at the lead-in offset.
    const intro = ffmpeg.find((c) =>
      c.args[c.args.length - 1].includes("tour-intro-"),
    )!
    expect(intro.args.some((a) => a.startsWith("/clips/"))).toBe(true)
    // Joins keep audio (no -an) and silent segments get a silent track.
    const joins = ffmpeg.filter((c) => c.args.includes("concat"))
    expect(joins).toHaveLength(4)
    for (const j of joins) expect(j.args).not.toContain("-an")
    expect(
      ffmpeg.some((c) => c.args.includes("anullsrc=r=48000:cl=mono")),
    ).toBe(true)
    const manifest = JSON.parse(
      readFileSync(join(req.dir, TOUR_VIDEO_MANIFEST), "utf8"),
    )
    expect(manifest.narrated).toBe(true)
    expect(typeof manifest.cards["tour-intro"]).toBe("string")
    expect(manifest.cards["tour-score-1"]).toBeDefined()
    const cues = manifest.reels.A2.narration as {
      kind: string
      text: string | null
    }[]
    expect(cues.length).toBeGreaterThan(0)
    expect(cues.some((c) => c.kind === "caption" && c.text)).toBe(true)
    expect(cues.some((c) => c.kind === "mail" && c.text)).toBe(true)
    // Narrated cards are held for their sentence: longer than nominal.
    expect(manifest.body[0].durationSec).toBeGreaterThan(2)
  })

  test("a narrated cut that fails is redone silent, with the reason", async () => {
    media = installFakeMedia({ fail: "/clips/" })
    const req = request({ pace: "demo" })
    const outcome = await produceTourVideos(
      req,
      narratedKit,
      TOUR,
      demo,
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
    const manifest = JSON.parse(
      readFileSync(join(req.dir, TOUR_VIDEO_MANIFEST), "utf8"),
    )
    expect(manifest.narrated).toBe(false)
  })

  test("a narrated cut that fails with a non-Error is still redone silent", async () => {
    media = installFakeMedia()
    let renders = 0
    const outcome = await produceTourVideos(
      request({ pace: "demo" }),
      narratedKit,
      TOUR,
      demo,
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

  test("a silent failure with no narrator to blame is the reason", async () => {
    media = installFakeMedia()
    const outcome = await produceTourVideos(request(), kit, TOUR, {}, () =>
      Promise.reject(new Error("no browser\nat line 2")),
    )
    expect(outcome).toMatchObject({ produced: false, reason: "no browser" })
  })

  test("preparing the lines fails: silent videos, the failure as narration reason", async () => {
    media = installFakeMedia()
    const outcome = await produceTourVideos(
      request({ pace: "demo" }),
      {
        ...kit,
        prepareNarration: () => Promise.reject(new Error("engine down\nstack")),
      },
      TOUR,
      demo,
      recordingRenderer().render,
    )
    expect(outcome).toMatchObject({
      produced: true,
      narration: { produced: false, reason: "engine down" },
    })
  })

  test("a non-Error thrown while preparing the lines", async () => {
    media = installFakeMedia()
    const outcome = await produceTourVideos(
      request({ pace: "demo" }),
      {
        ...kit,
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        prepareNarration: () => Promise.reject("plain string"),
      },
      TOUR,
      demo,
      recordingRenderer().render,
    )
    expect(outcome).toMatchObject({
      produced: true,
      narration: { produced: false, reason: "plain string" },
    })
  })

  test("curated lines are loaded once per area; a narrator without engine is null", async () => {
    media = installFakeMedia()
    const asked: string[] = []
    const outcome = await produceTourVideos(
      request({ pace: "demo" }),
      {
        ...narratedKit,
        lines: (module) => {
          asked.push(module)
          return {}
        },
        prepareNarration: () =>
          Promise.resolve({
            narrator: null,
            outcome: { produced: false as const, reason: "no voice installed" },
          }),
      },
      TOUR,
      demo,
      recordingRenderer().render,
    )
    expect(new Set(asked).size).toBe(asked.length)
    expect(asked.length).toBeGreaterThan(0)
    expect(outcome).toMatchObject({
      produced: true,
      narration: { produced: false, reason: "no voice installed" },
    })
  })
})

test.describe("tour planning helpers", () => {
  test("hasReel and areasOf", () => {
    expect(hasReel(feature("A1", "passed"))).toBe(true)
    expect(hasReel(feature("A1", "N/A", { recording: rec(1) }))).toBe(false)
    expect(hasReel(feature("A1", "passed", { recording: null }))).toBe(false)
    expect(areasOf(FEATURES, AREAS)).toEqual(["A", "F", "G"])
    expect(areasOf([feature("F1", "passed")], AREAS)).toEqual(["F"])
  })

  test("more features than a scoreboard page holds make more pages", () => {
    const many = Array.from({ length: SCOREBOARD_ROWS + 1 }, (_, i) =>
      feature(`A${i + 1}`, "dev-only"),
    )
    const pages = (segments: ReturnType<typeof planAreaVideo>) =>
      segments.filter(
        (s) => s.kind === "card" && s.card.kind.endsWith("scoreboard"),
      ).length
    expect(pages(planAreaVideo("A", many, AREAS))).toBe(2)
    expect(pages(planTourVideo(many, AREAS).segments)).toBe(2)
    expect(scoreRows(many, 2, AREAS).map((r) => r.id)).toEqual([
      `A${SCOREBOARD_ROWS + 1}`,
    ])
    expect(scoreRows(many, 1, AREAS)[0]).toEqual({
      id: "A1",
      title: "a1-slug",
      cells: [{ status: "dev-only", durationMs: 5_000 }],
    })
  })

  test("every card has its own file stem", () => {
    const cards: [TourCard, string][] = [
      [{ kind: "tour-intro" }, "tour-intro"],
      [{ kind: "tour-summary" }, "tour-summary"],
      [{ kind: "area-intro", area: "A" }, "area-A-intro"],
      [{ kind: "area-chapter", area: "A" }, "area-A-chapter"],
      [{ kind: "feature", feature: "A2", card: "view" }, "A2-view"],
      [
        { kind: "area-scoreboard", area: "A", page: 2, pages: 2 },
        "area-A-score-2",
      ],
      [{ kind: "tour-scoreboard", page: 3, pages: 3 }, "tour-score-3"],
    ]
    for (const [card, stem] of cards) expect(cardName(card)).toBe(stem)
  })

  test("card line facts for every card kind", () => {
    const f = FEATURES
    expect(
      cardLineData({ kind: "area-chapter", area: "Z" }, f, "local", AREAS),
    ).toEqual({ kind: "area-chapter", area: "Z", title: "Z", count: 0 })
    expect(
      cardLineData(
        { kind: "feature", feature: "A5", card: "title" },
        f,
        "local",
        AREAS,
      ),
    ).toEqual({ kind: "feature", id: "A5", title: "a5-slug", card: "title" })
    expect(
      cardLineData(
        { kind: "feature", feature: "Q9", card: "not-run" },
        f,
        "local",
        AREAS,
      ),
    ).toEqual({ kind: "feature", id: "Q9", title: "Q9", card: "not-run" })
    expect(
      cardLineData(
        { kind: "area-scoreboard", area: "A", page: 1, pages: 1 },
        f,
        "local",
        AREAS,
      ),
    ).toEqual({
      kind: "area-scoreboard",
      area: "A",
      page: 1,
      count: 2,
      passed: 1,
      failed: 1,
    })
    expect(
      cardLineData(
        { kind: "tour-scoreboard", page: 2, pages: 2 },
        f,
        "local",
        AREAS,
      ),
    ).toEqual({ kind: "tour-scoreboard", page: 2 })
  })

  test("the area a card's line comes from", () => {
    expect(cardArea({ kind: "area-intro", area: "F" }, FEATURES)).toBe("F")
    expect(
      cardArea({ kind: "feature", feature: "G1", card: "dev-only" }, FEATURES),
    ).toBe("G")
    expect(
      cardArea({ kind: "feature", feature: "Q9", card: "title" }, FEATURES),
    ).toBeNull()
    expect(cardArea({ kind: "tour-summary" }, FEATURES)).toBeNull()
  })

  test("a hold is never shorter than nominal and ignores unusable lengths", () => {
    expect(cardHoldSec(2, 0)).toBe(2)
    expect(cardHoldSec(2, Number.NaN)).toBe(2)
    expect(cardHoldSec(2, -1)).toBe(2)
    expect(cardHoldSec(2, 0.1)).toBe(2)
    expect(cardHoldSec(1, 3)).toBeGreaterThan(3)
  })
})

test.describe("readTourVideoManifest", () => {
  const manifestIn = (content: string | undefined) => {
    const dir = runDir()
    if (content !== undefined) {
      mkdirSync(join(dir, "video"), { recursive: true })
      writeFileSync(join(dir, TOUR_VIDEO_MANIFEST), content)
    }
    return dir
  }
  const body = (file: unknown) => ({ file, durationSec: 1 })

  test("missing, malformed or wrongly shaped files read as null", () => {
    expect(readTourVideoManifest(manifestIn(undefined))).toBeNull()
    expect(readTourVideoManifest(manifestIn("{ nope"))).toBeNull()
    expect(
      readTourVideoManifest(
        manifestIn(JSON.stringify({ body: {}, features: [] })),
      ),
    ).toBeNull()
    expect(
      readTourVideoManifest(
        manifestIn(JSON.stringify({ body: [], features: 1 })),
      ),
    ).toBeNull()
  })

  test("a part outside the run folder, absolute, empty or not a string is refused", () => {
    for (const file of [
      "../x.mp4",
      "video/../../x.mp4",
      "/etc/x.mp4",
      "",
      7,
      null,
    ]) {
      expect(
        readTourVideoManifest(
          manifestIn(JSON.stringify({ body: [body(file)], features: [] })),
        ),
      ).toBeNull()
    }
    expect(
      readTourVideoManifest(
        manifestIn(JSON.stringify({ body: [null], features: [] })),
      ),
    ).toBeNull()
  })

  test("defaults for absent fields", () => {
    const dir = manifestIn(
      JSON.stringify({ body: [body("video/tour/a.mp4")], features: [] }),
    )
    expect(readTourVideoManifest(dir)).toEqual({
      runId: "",
      target: "",
      body: [body("video/tour/a.mp4")],
      features: [],
      narrated: false,
      bodyFiles: [join(dir, "video/tour/a.mp4")],
    })
  })
})
