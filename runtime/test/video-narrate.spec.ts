// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "@playwright/test"

import { defineNarrationCopy } from "../src/narration/copy.js"
import { defineBrand } from "../src/video/brand.js"
import { DEFAULT_CARD_COPY, defineCardCopy } from "../src/video/copy.js"
import { createVideoKit } from "../src/video/kit.js"
import { narrateReel } from "../src/video/reel-voice.js"
import {
  type Segment,
  type Timeline,
  buildTimeline,
  narrateTimeline,
  waitCaptions,
} from "../src/video/timeline.js"
import type { Narrator } from "../src/voice/narrator.js"
import type { VoiceEngine } from "../src/voice/voice.js"

const tl = (
  segments: Segment[],
  captions: Timeline["captions"],
  app = { fromSec: 0, toSec: 20 },
): Timeline => ({
  segments,
  captions,
  personas: [],
  durationSec: segments.reduce((sum, s) => sum + s.durationSec, 0),
  app,
})

const app = (
  fromSec: number,
  toSec: number,
  extra: Partial<Extract<Segment, { kind: "app" }>> = {},
): Segment => ({
  kind: "app",
  fromSec,
  toSec,
  speed: 1,
  durationSec: toSec - fromSec,
  ...extra,
})

test.describe("waitCaptions", () => {
  test("a wait belongs to the caption it starts in; kind from what follows", () => {
    const timeline = tl(
      [
        app(0, 4),
        app(4, 30, { wait: true }),
        { kind: "email", mail: 0, durationSec: 4 },
        app(30, 60, { wait: true }),
      ],
      [
        { step: 0, fromSec: 0, toSec: 30 },
        { step: 1, fromSec: 30, toSec: 60 },
      ],
    )
    const waits = waitCaptions(timeline)
    expect([...waits]).toEqual([
      [0, "email"],
      [1, "other"],
    ])
  })

  test("only the first wait of a caption counts; stray waits use caption 0", () => {
    const timeline = tl(
      [app(0, 25, { wait: true }), app(25, 50, { wait: true })],
      [{ step: 0, fromSec: 5, toSec: 20 }],
    )
    // Neither wait starts inside the caption: both fall back to caption 0,
    // and the first one's kind wins.
    expect([...waitCaptions(timeline)]).toEqual([[0, "other"]])
    // No captions at all: nothing to attach to.
    expect(
      waitCaptions({ segments: timeline.segments, captions: [] }).size,
    ).toBe(0)
  })
})

test.describe("narrateTimeline", () => {
  const base = buildTimeline({
    videoDurationSec: 30,
    steps: [
      { id: "S1", startSec: 2, endSec: 6, status: "passed" },
      { id: "S2", startSec: 6, endSec: 10, status: "passed" },
    ],
    mail: [{ atSec: 6 }],
  })

  test("no sentences: the timeline comes back unchanged with no cues", () => {
    const out = narrateTimeline(base, { captions: [null, null], mail: [null] })
    expect(out.cues).toEqual([])
    expect(out.timeline.segments).toEqual(base.segments)
    expect(out.timeline.durationSec).toBe(base.durationSec)
  })

  test("a long sentence holds the step's last frame until it ends", () => {
    const out = narrateTimeline(base, { captions: [9, null], mail: [null] })
    // Window of S1 on screen is 4 s; 9 + 0.4 gap needs a 5.4 s hold.
    const held = out.timeline.segments.filter(
      (s) => s.kind === "app" && s.holdSec,
    )
    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({ kind: "app", holdSec: 5.4 })
    expect(out.cues).toEqual([{ kind: "caption", index: 0, atSec: 3.5 }])
    expect(out.timeline.durationSec).toBe(base.durationSec + 5.4)
  })

  test("a sentence that fits adds no hold", () => {
    const out = narrateTimeline(base, { captions: [2, null], mail: [null] })
    expect(out.timeline.durationSec).toBe(base.durationSec)
    expect(out.cues).toEqual([{ kind: "caption", index: 0, atSec: 3.5 }])
  })

  test("cards last lead + sentence + pad and cue after the lead", () => {
    const out = narrateTimeline(base, {
      captions: [null, null],
      mail: [10],
      intro: 6,
      outro: 1,
    })
    const intro = out.timeline.segments.find((s) => s.kind === "intro")
    const email = out.timeline.segments.find((s) => s.kind === "email")
    const outro = out.timeline.segments.find((s) => s.kind === "outro")
    expect(intro?.durationSec).toBe(6.9) // 0.3 + 6 + 0.6
    expect(email?.durationSec).toBe(10.9)
    // The outro keeps its own, longer, default length.
    expect(outro?.durationSec).toBe(5)
    const at = (kind: string) => out.cues.find((c) => c.kind === kind)?.atSec
    expect(at("intro")).toBe(0.3)
    // longer intro + the 4.5 s of recording before the card + the lead
    expect(at("mail")).toBeCloseTo(6.9 + 4.5 + 0.3, 6)
    expect(at("outro")).toBeCloseTo(
      out.timeline.durationSec - (outro?.durationSec ?? 0) + 0.3,
      6,
    )
  })

  test("custom gap, pad and lead; unusable durations are not said", () => {
    const out = narrateTimeline(
      base,
      {
        captions: [Number.NaN, 0],
        mail: [Number.POSITIVE_INFINITY],
        intro: -1,
        outro: undefined,
      },
      { gapSec: 1, cardPadSec: 2, cardLeadSec: 3 },
    )
    expect(out.cues).toEqual([])
    const custom = narrateTimeline(
      base,
      { captions: [null, null], mail: [1], intro: 1 },
      { cardPadSec: 2, cardLeadSec: 3 },
    )
    expect(custom.timeline.segments[0].durationSec).toBe(6)
    expect(custom.cues[0]).toEqual({ kind: "intro", index: 0, atSec: 3 })
  })

  test("a timeline without bookends or cards ignores intro / outro / mail lines", () => {
    const bare = buildTimeline(
      {
        videoDurationSec: 12,
        steps: [{ id: "S", startSec: 1, endSec: 5, status: "passed" }],
        mail: [],
      },
      { bookends: false },
    )
    const out = narrateTimeline(bare, {
      captions: [2],
      mail: [3],
      intro: 4,
      outro: 4,
    })
    expect(out.cues.map((c) => c.kind)).toEqual(["caption"])
  })

  test("a hold lands inside a piece, splitting it at the sentence's end", () => {
    // One 20 s piece, two captions; the first caption's window ends at 8,
    // mid-piece, so the piece is cut there and the first half is held.
    const timeline = tl(
      [app(0, 20)],
      [
        { step: 0, fromSec: 0, toSec: 8 },
        { step: 1, fromSec: 8, toSec: 20 },
      ],
    )
    const out = narrateTimeline(timeline, { captions: [10, null], mail: [] })
    expect(out.timeline.segments).toEqual([
      app(0, 8, { holdSec: 2.4, durationSec: 10.4 }),
      app(8, 20),
    ])
    expect(out.cues).toEqual([{ kind: "caption", index: 0, atSec: 0 }])
  })

  test("a second hold on the same piece adds to the first", () => {
    const timeline = tl([app(0, 10)], [{ step: 0, fromSec: 0, toSec: 10 }], {
      fromSec: 0,
      toSec: 10,
    })
    const once = narrateTimeline(timeline, { captions: [12], mail: [] })
    expect(once.timeline.segments[0]).toMatchObject({ holdSec: 2.4 })
    const twice = narrateTimeline(once.timeline, { captions: [14], mail: [] })
    // The window is measured before the piece's hold (10 s on screen), so
    // 14.4 - 10 = 4.4 more is added to the existing 2.4.
    expect(twice.timeline.segments[0]).toMatchObject({
      holdSec: 6.8,
      durationSec: 16.8,
    })
  })

  test("a window squeezed out of the recording holds the piece before it", () => {
    // Pieces cover 0-5 and 9-12 only; caption window ends at 7, which no
    // piece contains, so the hold goes on the last piece ending before it.
    const timeline = tl(
      [app(0, 5), app(9, 12)],
      [
        { step: 0, fromSec: 1, toSec: 7 },
        { step: 1, fromSec: 7, toSec: 12 },
      ],
      { fromSec: 0, toSec: 12 },
    )
    const out = narrateTimeline(timeline, { captions: [4, null], mail: [] })
    // The window's end is in no piece, so the whole sentence + gap is held.
    expect(out.timeline.segments[0]).toMatchObject({ toSec: 5, holdSec: 4.4 })
    expect(out.timeline.segments[1]).toEqual(app(9, 12))
  })

  test("a caption outside every piece is not placed", () => {
    const timeline = tl([app(0, 5)], [{ step: 0, fromSec: 8, toSec: 12 }], {
      fromSec: 0,
      toSec: 12,
    })
    const out = narrateTimeline(timeline, { captions: [3], mail: [] })
    expect(out.cues).toEqual([])
  })

  test("a piece that plays slower holds in output time", () => {
    const timeline = tl(
      [app(0, 10, { speed: 0.5, durationSec: 20 })],
      [{ step: 0, fromSec: 0, toSec: 10 }],
      { fromSec: 0, toSec: 10 },
    )
    const out = narrateTimeline(timeline, { captions: [25], mail: [] })
    expect(out.timeline.segments[0]).toMatchObject({
      holdSec: 5.4,
      durationSec: 25.4,
    })
  })

  test("a mail card at a caption's second comes before that caption", () => {
    const out = narrateTimeline(base, { captions: [1, 1], mail: [1] })
    expect(out.cues.map((c) => `${c.kind}${c.index}`)).toEqual([
      "caption0",
      "mail0",
      "caption1",
    ])
  })
})

test.describe("narrateReel", () => {
  const narrator = (lengths: Record<string, number>): Narrator => ({
    seconds: (text) => (text ? (lengths[text] ?? null) : null),
    clip: (text) =>
      text && lengths[text]
        ? { path: `/clips/${text}.wav`, seconds: lengths[text] }
        : null,
  })
  const base = buildTimeline({
    videoDurationSec: 30,
    steps: [
      { id: "S1", startSec: 2, endSec: 6, status: "passed" },
      { id: "S2", startSec: 6, endSec: 10, status: "passed" },
    ],
    mail: [{ atSec: 6 }],
  })

  test("places each spoken line's clip at its cue", () => {
    const out = narrateReel(
      base,
      { captions: ["one", null], mail: ["card"] },
      narrator({ one: 1, card: 2, hello: 1, bye: 1 }),
      { intro: "hello", outro: "bye" },
    )
    expect(out.clips).toEqual([
      { path: "/clips/hello.wav", atSec: 0.3 },
      { path: "/clips/one.wav", atSec: 3.5 },
      { path: "/clips/card.wav", atSec: 7.8 },
      {
        path: "/clips/bye.wav",
        atSec: out.timeline.durationSec - 5 + 0.3,
      },
    ])
    expect(out.cues.map((c) => c.kind)).toEqual([
      "intro",
      "caption",
      "mail",
      "outro",
    ])
  })

  test("without bookends or sentences there are no clips", () => {
    const out = narrateReel(
      base,
      { captions: [null, null], mail: [null] },
      narrator({}),
    )
    expect(out.clips).toEqual([])
    expect(out.timeline.segments).toEqual(base.segments)
  })

  test("a cue whose clip is missing adds no clip", () => {
    const silent: Narrator = {
      seconds: (text) => (text === "x" ? 2 : null),
      clip: () => null,
    }
    const out = narrateReel(
      base,
      { captions: ["x", null], mail: [null] },
      silent,
    )
    expect(out.cues).toHaveLength(1)
    expect(out.clips).toEqual([])
  })
})

test.describe("createVideoKit", () => {
  const made: string[] = []
  test.afterAll(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true })
  })
  const tmp = () => {
    const dir = mkdtempSync(join(tmpdir(), "flowreel-kit-"))
    made.push(dir)
    return dir
  }

  const engine = (problem: string | null): VoiceEngine => ({
    name: "fake",
    voice: "Fake Voice",
    warning: null,
    cacheParts: () => ["fake"],
    available: () => Promise.resolve(problem),
    synthesize: (_text, out) => {
      writeFileSync(out, "")
      return Promise.resolve(1.5)
    },
  })

  test("lines come from the narration dir, or {} without one", () => {
    const dir = tmp()
    writeFileSync(
      join(dir, "orbit.json"),
      JSON.stringify({ S1: "Opening.", _note: "ignored", n: 3 }),
    )
    expect(createVideoKit({ narrationDir: dir }).lines("orbit")).toEqual({
      S1: "Opening.",
    })
    expect(createVideoKit({ narrationDir: dir }).lines("absent")).toEqual({})
    expect(createVideoKit().lines("orbit")).toEqual({})
  })

  test("prepareNarration uses the injected engine, cache dir and log", async () => {
    const cacheDir = tmp()
    const kit = createVideoKit({
      voice: { engine: () => engine(null), cacheDir, log: () => {} },
    })
    const { narrator, outcome } = await kit.prepareNarration(
      { on: true },
      ["Hello there.", null, "Hello there."],
      {},
    )
    expect(outcome).toMatchObject({
      produced: true,
      engine: "fake",
      voice: "Fake Voice",
      lines: 1,
      synthesized: 1,
      cached: 0,
    })
    expect(narrator?.seconds("Hello there.")).toBe(1.5)
    expect(narrator?.seconds("unknown")).toBeNull()
    expect(narrator?.clip("Hello there.")?.path.startsWith(cacheDir)).toBe(true)
  })

  test("prepareNarration reports an unavailable engine and a switched-off decision", async () => {
    const kit = createVideoKit({
      voice: { engine: () => engine("no voice installed"), cacheDir: tmp() },
    })
    await expect(
      kit.prepareNarration({ on: true }, ["x"], {}),
    ).resolves.toEqual({
      narrator: null,
      outcome: { produced: false, reason: "no voice installed" },
    })
    await expect(
      kit.prepareNarration({ on: false, reason: "off here" }, ["x"], {}),
    ).resolves.toEqual({
      narrator: null,
      outcome: { produced: false, reason: "off here" },
    })
  })

  test("the reel copy renders badges from the kit's cards and copy", () => {
    const kit = createVideoKit()
    expect(kit.reelCopy.speedBadge(4)).toContain("4")
    expect(kit.reelCopy.waitBadge("email")).toBe(
      kit.cards.waitHtml(kit.narration.copy.waitCaptions.email),
    )
    expect(
      kit.reelCopy.stepLine(
        {},
        { title: "S1 Open the page", failed: false },
        null,
      ),
    ).toBe(
      kit.narration.stepLine(
        {},
        { title: "S1 Open the page", failed: false },
        null,
      ),
    )
  })
})

test.describe("buildTimeline corners", () => {
  const steps = [
    { id: "S", startSec: 2, endSec: 12, status: "passed" as const },
  ]

  test("a mail with no usable time is cut at the end of the kept window", () => {
    const timeline = buildTimeline({
      videoDurationSec: 30,
      steps,
      mail: [{ atSec: Number.NaN }],
    })
    expect(timeline.segments.map((s) => s.kind)).toEqual([
      "intro",
      "app",
      "email",
      "outro",
    ])
    expect(timeline.app).toEqual({ fromSec: 1.5, toSec: 13.5 })
  })

  test("two mails at the same second keep their recorded order", () => {
    const timeline = buildTimeline({
      videoDurationSec: 30,
      steps,
      mail: [{ atSec: 6 }, { atSec: 6 }],
    })
    const mails = timeline.segments.flatMap((s) =>
      s.kind === "email" ? [s.mail] : [],
    )
    expect(mails).toEqual([0, 1])
  })

  test("persona windows: same persona merges, an empty window is skipped", () => {
    const timeline = buildTimeline({
      videoDurationSec: 30,
      steps,
      mail: [],
      personas: {
        initial: "admin",
        switches: [
          { atSec: 6, persona: "ops" },
          { atSec: 4, persona: "admin" },
          { atSec: 6, persona: "guest" },
          { atSec: Number.NaN, persona: "ignored" },
        ],
      },
    })
    // admin 1.5-4, admin again 4-6 (merged), ops 6-6 (empty, skipped), guest to the end.
    expect(timeline.personas).toEqual([
      { persona: "admin", fromSec: 1.5, toSec: 6 },
      { persona: "guest", fromSec: 6, toSec: 13.5 },
    ])
  })

  test("a different persona at the same second is a new window", () => {
    const timeline = buildTimeline({
      videoDurationSec: 30,
      steps,
      mail: [],
      personas: {
        initial: "admin",
        switches: [{ atSec: 5, persona: "guest" }],
      },
    })
    expect(timeline.personas.map((p) => p.persona)).toEqual(["admin", "guest"])
  })
})

test.describe("narrateTimeline corners", () => {
  test("splitting a piece keeps the hold it already had on its second half", () => {
    const timeline = tl(
      [app(0, 20, { holdSec: 2, durationSec: 22 })],
      [
        { step: 0, fromSec: 0, toSec: 8 },
        { step: 1, fromSec: 8, toSec: 20 },
      ],
    )
    const out = narrateTimeline(timeline, { captions: [10, null], mail: [] })
    expect(out.timeline.segments).toEqual([
      app(0, 8, { holdSec: 2.4, durationSec: 10.4 }),
      app(8, 20, { holdSec: 2, durationSec: 14 }),
    ])
  })

  test("a window ending where a later piece starts is placed at that piece", () => {
    // Pieces 0-5 and 9-12; caption 0's window ends at 9, the start of the
    // second piece, so its sentence is measured up to there (5 s on screen).
    const timeline = tl(
      [app(0, 5), app(9, 12)],
      [
        { step: 0, fromSec: 0, toSec: 9 },
        { step: 1, fromSec: 9, toSec: 12 },
      ],
      { fromSec: 0, toSec: 12 },
    )
    const out = narrateTimeline(timeline, { captions: [8, 1], mail: [] })
    expect(out.timeline.segments[0]).toMatchObject({ holdSec: 3.4 })
    expect(out.cues).toEqual([
      { kind: "caption", index: 0, atSec: 0 },
      { kind: "caption", index: 1, atSec: 8.4 },
    ])
  })

  test("events at the same second are ordered by kind, then by index", () => {
    const timeline = tl(
      [
        app(0, 6),
        { kind: "email", mail: 0, durationSec: 4 },
        { kind: "email", mail: 1, durationSec: 4 },
        app(6, 12),
      ],
      [
        { step: 0, fromSec: 6, toSec: 9 },
        { step: 1, fromSec: 6, toSec: 12 },
      ],
      { fromSec: 0, toSec: 12 },
    )
    const out = narrateTimeline(timeline, {
      captions: [1, 1],
      mail: [1, 1],
    })
    expect(out.cues.map((c) => `${c.kind}${c.index}`)).toEqual([
      "mail0",
      "mail1",
      "caption0",
      "caption1",
    ])
  })
})

test.describe("createVideoKit options and defaults", () => {
  test("a brand's copy and narration copy flow into the cards and the lines", () => {
    const kit = createVideoKit({
      copy: defineCardCopy({ stepTitles: { "T1 a": "Custom title" } }),
    })
    expect(kit.cards.stepLabel("T1 a").title).toBe("Custom title")
    expect(kit.tourCards.cards).toBe(kit.cards)
    const plain = createVideoKit()
    expect(plain.cards.stepLabel("T1 a").title).toBe("a")
    expect(plain.brand).toBe(createVideoKit().brand)
    expect(DEFAULT_CARD_COPY.stepTitles).toEqual({})
  })

  test("a project's brand and narration copy are used", () => {
    const brand = defineBrand({ name: "Acme" })
    const kit = createVideoKit({
      brand,
      narrationCopy: defineNarrationCopy({ featureId: "[Z]\\d" }),
    })
    expect(kit.brand).toBe(brand)
    expect(kit.cards.brand).toBe(brand)
    expect(kit.narration.copy.featureId).toBe("[Z]\\d")
  })

  test("the default voice is read from the environment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flowreel-kit-env-"))
    try {
      const { narrator, outcome } = await createVideoKit().prepareNarration(
        { on: true },
        ["Hello there."],
        { FLOWREEL_VOICE_ENGINE: "none", FLOWREEL_VOICE_CACHE_DIR: dir },
      )
      expect(narrator).toBeNull()
      expect(outcome).toEqual({
        produced: false,
        reason: expect.stringContaining("FLOWREEL_VOICE_ENGINE=none"),
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
