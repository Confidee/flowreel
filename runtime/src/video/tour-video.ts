// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"

import type { Env } from "../core/env.js"
import {
  type TourCardLine,
  type VideoPace,
  timelineOptionsFor,
  tourNarrationModule,
  videoPaceFor,
} from "../narration/narration.js"
import type { FeatureMode, FeatureStatus } from "../reporter/status.js"
import type { TourArea } from "../tour/manifest.js"
import type { Pace, Policy } from "../tour/policy.js"
import type {
  NarrationLines,
  NarrationOutcome,
  Narrator,
} from "../voice/narrator.js"

import {
  type AudioTrack,
  type ProgramPart,
  composeProgram,
  concatSegments,
  ffmpegProblem,
  probeDuration,
  programSec,
} from "./ffmpeg.js"
import { withMediaSignal } from "./stop.js"
import type { VideoKit } from "./kit.js"
import { type VideoLogData, videoEnabled, videoOffReason } from "./recorder.js"
import {
  type ReelTexts,
  narrateReel,
  reelTexts,
  segmentBadges,
} from "./reel-voice.js"
import { type PngJob, renderPngs } from "./render.js"
import type { RecordedStep } from "./run-video.js"
import {
  CARD_LEAD_SEC,
  CARD_PAD_SEC,
  type NarrationCue,
  type Timeline,
  type TimelineInput,
  buildTimeline,
} from "./timeline.js"
import { SCOREBOARD_ROWS, type ScoreRow } from "./tour-cards.js"

// Feature tour videos, made by the summary reporter after a tour run:
//
//   per feature  its page recording -> a reel (captions from the step titles,
//                email cards, "as <persona>" badges), encoded once;
//   per area     <RUN_ID>/tour-<letter>-<RUN_ID>.mp4: area intro -> for each
//                feature a 1.5 s title card (id, title, policy badge) + its
//                reel, or a 3 s "Development only" / "Not run" card, or the
//                "Read-only on staging" card + its reel -> the area
//                scoreboard;
//   full tour    <RUN_ID>/<module>-<RUN_ID>.mp4: tour intro -> per area a
//                chapter card + the same feature parts -> the final
//                scoreboard (an area summary page, then every feature).
//
// Every part (card still or reel) is its own MP4 with identical encoder
// settings, so the area and tour files are concatenations without a second
// encode (ffmpeg.ts concatSegments). <RUN_ID>/video/tour.json records the
// parts, their files and where each feature starts in the tour MP4; the
// pipeline's combined video re-uses them. Like produceVideo it never throws
// and never changes a verdict.
//
// Narration: at demo pace every reel plays at 1/slowFactor (a long wait in
// real time) and is never fast-forwarded; each step's sentence (curated
// tour-<letter>.json, else its caption) starts with its caption and holds
// the last frame until it ends; every card says its line and lasts long
// enough for it. Narrated, every part MP4 carries a sound track, so the
// joins keep the audio. A narration failure falls back to the silent cut.

export const TITLE_SEC = 1.5
export const STANDIN_SEC = 3
export const AREA_INTRO_SEC = 3
export const TOUR_CHAPTER_SEC = 2
export const TOUR_INTRO_SEC = 4
export const SCOREBOARD_SEC = 4

/**
 * A tour area as the videos name it, in catalogue order: the manifest's
 * TourArea (TourManifest.areas fits as it is) without its spec slug.
 */
export type TourVideoArea = Pick<TourArea, "letter" | "title">

/** The tour's own settings for its videos. */
export interface TourVideoConfig {
  /** The tour's module: the full tour MP4 is <module>-<RUN_ID>.mp4. */
  module: string
  /** The catalogue's areas, in order (features sort by it). */
  areas: readonly TourVideoArea[]
  /** Who the recorded page acts as before its first persona switch. */
  initialPersona: string
}

/** One tour feature test as the reporter recorded it. */
export interface TourFeatureRecord {
  /** "A4" */
  id: string
  /** "list-search" (the test title after the id). */
  title: string
  area: string
  policy: Policy | null
  mode: FeatureMode
  status: FeatureStatus
  /** Why it did not run (dev-only reason or skip reason), else null. */
  reason: string | null
  durationMs: number | null
  /** Present when the test ran with a page recording and a video log. */
  recording: {
    videoPath: string
    log: VideoLogData
    steps: RecordedStep[]
  } | null
}

export type TourCard =
  | { kind: "tour-intro" }
  | { kind: "area-intro"; area: string }
  | { kind: "area-chapter"; area: string }
  | {
      kind: "feature"
      feature: string
      card: "title" | "dev-only" | "view" | "not-run"
    }
  | { kind: "area-scoreboard"; area: string; page: number; pages: number }
  | { kind: "tour-summary" }
  | { kind: "tour-scoreboard"; page: number; pages: number }

export type TourSegment =
  | { kind: "card"; card: TourCard; durationSec: number }
  | { kind: "reel"; feature: string }

const cardSeg = (card: TourCard, durationSec: number): TourSegment => ({
  kind: "card",
  card,
  durationSec,
})

/** Whether a feature has a reel to play. */
export const hasReel = (f: TourFeatureRecord) =>
  f.recording !== null &&
  (f.status === "passed" || f.status === "failed" || f.status === "view-only")

/** Pure: a feature's parts (title + reel, or its stand-in card). */
export function featureSegments(f: TourFeatureRecord): TourSegment[] {
  if (f.status === "dev-only") {
    return [
      cardSeg(
        { kind: "feature", feature: f.id, card: "dev-only" },
        STANDIN_SEC,
      ),
    ]
  }
  if (!hasReel(f)) {
    return [
      cardSeg({ kind: "feature", feature: f.id, card: "not-run" }, STANDIN_SEC),
    ]
  }
  const reel: TourSegment = { kind: "reel", feature: f.id }
  if (f.status === "view-only") {
    return [
      cardSeg({ kind: "feature", feature: f.id, card: "view" }, STANDIN_SEC),
      reel,
    ]
  }
  return [
    cardSeg({ kind: "feature", feature: f.id, card: "title" }, TITLE_SEC),
    reel,
  ]
}

const pagesOf = (n: number) => Math.max(1, Math.ceil(n / SCOREBOARD_ROWS))

/** The areas that have at least one feature, in catalogue order. */
export function areasOf(
  features: TourFeatureRecord[],
  areas: readonly TourVideoArea[],
): string[] {
  return areas
    .map((a) => a.letter)
    .filter((letter) => features.some((f) => f.area === letter))
}

/** Features in catalogue order: by area, then numeric id (A2 before A10). */
export function sortFeatures(
  features: TourFeatureRecord[],
  areas: readonly TourVideoArea[],
): TourFeatureRecord[] {
  const num = (id: string) => Number(id.slice(1))
  const area = (l: string) => areas.findIndex((a) => a.letter === l)
  return [...features].sort(
    (a, b) => area(a.area) - area(b.area) || num(a.id) - num(b.id),
  )
}

/** Pure: an area MP4's parts. */
export function planAreaVideo(
  area: string,
  features: TourFeatureRecord[],
  areas: readonly TourVideoArea[],
): TourSegment[] {
  const own = sortFeatures(
    features.filter((f) => f.area === area),
    areas,
  )
  const pages = pagesOf(own.length)
  return [
    cardSeg({ kind: "area-intro", area }, AREA_INTRO_SEC),
    ...own.flatMap(featureSegments),
    ...Array.from({ length: pages }, (_, i) =>
      cardSeg(
        { kind: "area-scoreboard", area, page: i + 1, pages },
        SCOREBOARD_SEC,
      ),
    ),
  ]
}

/** Pure: the full tour MP4's parts. `body` = without intro and scoreboard. */
export function planTourVideo(
  features: TourFeatureRecord[],
  areas: readonly TourVideoArea[],
): {
  segments: TourSegment[]
  body: TourSegment[]
} {
  const sorted = sortFeatures(features, areas)
  const body = areasOf(sorted, areas).flatMap((area) => [
    cardSeg({ kind: "area-chapter", area }, TOUR_CHAPTER_SEC),
    ...sorted.filter((f) => f.area === area).flatMap(featureSegments),
  ])
  const pages = pagesOf(sorted.length)
  return {
    body,
    segments: [
      cardSeg({ kind: "tour-intro" }, TOUR_INTRO_SEC),
      ...body,
      cardSeg({ kind: "tour-summary" }, SCOREBOARD_SEC),
      ...Array.from({ length: pages }, (_, i) =>
        cardSeg(
          { kind: "tour-scoreboard", page: i + 1, pages },
          SCOREBOARD_SEC,
        ),
      ),
    ],
  }
}

/** A card's file stem (its PNG / MP4 name in <RUN_ID>/video/tour/). */
export function cardName(card: TourCard): string {
  switch (card.kind) {
    case "tour-intro":
      return "tour-intro"
    case "tour-summary":
      return "tour-summary"
    case "area-intro":
      return `area-${card.area}-intro`
    case "area-chapter":
      return `area-${card.area}-chapter`
    case "feature":
      return `${card.feature}-${card.card}`
    case "area-scoreboard":
      return `area-${card.area}-score-${card.page}`
    case "tour-scoreboard":
      return `tour-score-${card.page}`
  }
}

/** One encoded card clip per card and nominal length. */
export const cardKey = (segment: { card: TourCard; durationSec: number }) =>
  `${cardName(segment.card)}-${segment.durationSec}`

/**
 * Pure: where each part starts (seconds) given the reels' real lengths, and
 * where each feature starts (its title / stand-in card) in that video.
 * `cardSec` holds the ENCODED cards' probed lengths by cardKey: a still is
 * encoded at 25 fps, so a nominal length that is not a whole number of
 * frames comes out longer (1.5 s = 37.5 frames -> 38 = 1.52 s), and summing
 * nominal lengths drifts by 0.02 s per title card (1.9 s over 96 features).
 * A card missing from it counts at its nominal length.
 */
export function placeSegments(
  segments: TourSegment[],
  reelSec: Record<string, number>,
  cardSec: Record<string, number> = {},
): { starts: number[]; durationSec: number; features: Record<string, number> } {
  let at = 0
  const starts: number[] = []
  const features: Record<string, number> = {}
  for (const segment of segments) {
    starts.push(Math.round(at * 1000) / 1000)
    if (segment.kind === "card" && segment.card.kind === "feature") {
      features[segment.card.feature] ??= Math.round(at * 1000) / 1000
    }
    at +=
      segment.kind === "card"
        ? (cardSec[cardKey(segment)] ?? segment.durationSec)
        : (reelSec[segment.feature] ?? 0)
  }
  return { starts, durationSec: Math.round(at * 1000) / 1000, features }
}

/** Pure: a feature's reel timeline input (worker clock -> page-video clock). */
export function reelInput(
  recording: NonNullable<TourFeatureRecord["recording"]>,
  videoDurationSec: number,
  initialPersona: string,
): TimelineInput {
  const anchor = recording.log.videoStartedAt ?? 0
  return {
    videoDurationSec,
    steps: recording.steps.map((s) => ({
      id: s.id,
      startSec: (s.startMs - anchor) / 1000,
      endSec:
        s.durationMs < 0
          ? videoDurationSec
          : (s.startMs + s.durationMs - anchor) / 1000,
      status: s.failed ? "failed" : "passed",
    })),
    mail: recording.log.mail.map((m) => ({ atSec: (m.at - anchor) / 1000 })),
    personas: {
      initial: initialPersona,
      switches: (recording.log.personas ?? []).map((p) => ({
        atSec: (p.at - anchor) / 1000,
        persona: p.persona,
      })),
    },
  }
}

const countStatuses = (features: TourFeatureRecord[]) =>
  features.reduce<Partial<Record<FeatureStatus, number>>>((acc, f) => {
    acc[f.status] = (acc[f.status] ?? 0) + 1
    return acc
  }, {})

/** Pure: one scoreboard page's rows. */
export function scoreRows(
  features: TourFeatureRecord[],
  page: number,
  areas: readonly TourVideoArea[],
): ScoreRow[] {
  return sortFeatures(features, areas)
    .slice((page - 1) * SCOREBOARD_ROWS, page * SCOREBOARD_ROWS)
    .map((f) => ({
      id: f.id,
      title: f.title,
      cells: [{ status: f.status, durationMs: f.durationMs }],
    }))
}

// ---------------------------------------------------------------------------
// Narration: what each card says, and cards long enough to say it
// ---------------------------------------------------------------------------

const verified = (f: TourFeatureRecord) =>
  f.status === "passed" || f.status === "view-only"

/** Pure: the facts a card's sentence is made of. */
export function cardLineData(
  card: TourCard,
  features: TourFeatureRecord[],
  target: string,
  areas: readonly TourVideoArea[],
): TourCardLine {
  const title = (letter: string) =>
    areas.find((a) => a.letter === letter)?.title ?? letter
  const own = (letter: string) => features.filter((f) => f.area === letter)
  switch (card.kind) {
    case "tour-intro":
      return {
        kind: "tour-intro",
        count: features.length,
        areas: areasOf(features, areas).length,
        target,
      }
    case "area-intro":
    case "area-chapter":
      return {
        kind: card.kind,
        area: card.area,
        title: title(card.area),
        count: own(card.area).length,
      }
    case "feature": {
      const f = features.find((x) => x.id === card.feature)
      return {
        kind: "feature",
        id: card.feature,
        title: f?.title ?? card.feature,
        card: card.card,
      }
    }
    case "area-scoreboard": {
      const list = own(card.area)
      return {
        kind: "area-scoreboard",
        area: card.area,
        page: card.page,
        count: list.length,
        passed: list.filter(verified).length,
        failed: list.filter((f) => f.status === "failed").length,
      }
    }
    case "tour-summary":
      return {
        kind: "tour-summary",
        count: features.length,
        passed: features.filter(verified).length,
        failed: features.filter((f) => f.status === "failed").length,
      }
    case "tour-scoreboard":
      return { kind: "tour-scoreboard", page: card.page }
  }
}

/** The area whose narration file a card's line comes from (null = none). */
export function cardArea(
  card: TourCard,
  features: TourFeatureRecord[],
): string | null {
  if ("area" in card) return card.area
  if (card.kind === "feature") {
    return features.find((f) => f.id === card.feature)?.area ?? null
  }
  return null
}

/**
 * Pure: a card held at least as long as its sentence (lead + sentence +
 * pad); never shorter than its nominal length.
 */
export function cardHoldSec(nominalSec: number, sentenceSec: number | null) {
  if (sentenceSec === null || !(sentenceSec > 0)) return nominalSec
  return (
    Math.round(
      Math.max(nominalSec, CARD_LEAD_SEC + sentenceSec + CARD_PAD_SEC) * 1000,
    ) / 1000
  )
}

// ---------------------------------------------------------------------------
// Production (impure)
// ---------------------------------------------------------------------------

/**
 * Renders the card PNGs (default: renderPngs, a headless Chromium). The
 * producers take it as their last parameter so tests can record the jobs.
 */
export type PngRenderer = (jobs: PngJob[]) => Promise<void>

/**
 * What produceTourVideos makes a tour run's videos from (one per area, and
 * the full tour): the run, its pace and every feature's record.
 */
export interface TourVideoRequest {
  runId: string
  target: string
  pace: Pace
  /** The run's results folder. */
  dir: string
  startedAt: Date
  verdict: string
  features: TourFeatureRecord[]
  /**
   * Stops the composition: every tool it started ends and the outcome is
   * not produced. The summary reporter passes one that aborts on Ctrl-C.
   */
  signal?: AbortSignal
}

/** One produced tour video file. */
/** One produced tour MP4 and its length. */
export interface TourVideoFile {
  path: string
  durationSec: number
}

/** What produceTourVideos returns (it never throws): the area and full-tour MP4s, or why there are none. */
export type TourVideoOutcome = (
  | {
      produced: true
      areas: (TourVideoFile & { area: string })[]
      tour: TourVideoFile
      /** Where each feature starts in the tour MP4 (seconds). */
      featureStarts: Record<string, number>
    }
  | { produced: false; reason: string }
) & {
  narration?: NarrationOutcome
  pace?: Pick<VideoPace, "pace" | "slowFactor">
}

/** "tour-<letter>-<RUN_ID>.mp4" */
export const areaVideoName = (letter: string, runId: string) =>
  `tour-${letter.toLowerCase()}-${runId}.mp4`
/** "<module>-<RUN_ID>.mp4" */
export const tourVideoName = (module: string, runId: string) =>
  `${module}-${runId}.mp4`
/** Where a tour run's manifest lives, relative to its run folder. */
export const TOUR_VIDEO_MANIFEST = join("video", "tour.json")

/** <RUN_ID>/video/tour.json: what a pipeline needs to splice this tour in. */
export interface TourVideoManifest {
  runId: string
  target: string
  /** Segment MP4s relative to the run folder, in tour order (body only). */
  body: { file: string; durationSec: number; feature?: string }[]
  features: {
    id: string
    title: string
    area: string
    status: FeatureStatus
    durationMs: number | null
  }[]
  /** The segments carry a narration track. */
  narrated?: boolean
}

export function readTourVideoManifest(runDir: string):
  | (TourVideoManifest & {
      bodyFiles: string[]
    })
  | null {
  try {
    const raw = JSON.parse(
      readFileSync(join(runDir, TOUR_VIDEO_MANIFEST), "utf8"),
    ) as Partial<TourVideoManifest>
    if (!Array.isArray(raw.body) || !Array.isArray(raw.features)) return null
    const inside = (p: unknown): p is string =>
      typeof p === "string" &&
      p !== "" &&
      !isAbsolute(p) &&
      !relative(runDir, resolve(runDir, p)).startsWith("..")
    if (!raw.body.every((b) => inside(b?.file))) return null
    return {
      runId: raw.runId ?? "",
      target: raw.target ?? "",
      body: raw.body,
      features: raw.features,
      narrated: raw.narrated === true,
      bodyFiles: raw.body.map((b) => resolve(runDir, b.file)),
    }
  } catch {
    return null
  }
}

const firstLine = (message: string) =>
  (message.split("\n").find((l) => l.trim() !== "") ?? message).slice(0, 300)

/**
 * Makes a tour run's videos: one MP4 per area that ran
 * (<req.dir>/tour-<letter>-<RUN_ID>.mp4: area intro, each feature's title
 * card and recording or its stand-in card, the area scoreboard) and the
 * whole tour (<req.dir>/<tour.module>-<RUN_ID>.mp4: tour intro, the areas
 * behind chapter cards, the summary and the full scoreboard), plus
 * <req.dir>/video/tour.json (TOUR_VIDEO_MANIFEST, what a pipeline splices
 * in); working files go to <req.dir>/video/tour/. Paced and narrated per
 * videoPaceFor("tour", env, req.pace).
 *
 * `kit` supplies the brand, card copy, narration copy, curated lines
 * (tour-<letter>.json per area) and voice; `tour` supplies the tour module
 * name, the catalogue's areas in order and the persona the recording starts
 * as. Never throws: video off, no ffmpeg, nothing recorded or any failure is
 * { produced: false, reason }.
 */
export function produceTourVideos(
  req: TourVideoRequest,
  kit: VideoKit,
  tour: TourVideoConfig,
  env: Env = process.env,
  render: PngRenderer = renderPngs,
): Promise<TourVideoOutcome> {
  return withMediaSignal(req.signal, () =>
    composeTourVideos(req, kit, tour, env, render),
  )
}

async function composeTourVideos(
  req: TourVideoRequest,
  kit: VideoKit,
  tour: TourVideoConfig,
  env: Env,
  render: PngRenderer,
): Promise<TourVideoOutcome> {
  const pace = videoPaceFor("tour", env, req.pace)
  const paced = { pace: pace.pace, slowFactor: pace.slowFactor }
  let narration: NarrationOutcome = pace.narration.on
    ? { produced: false, reason: "the video was not produced" }
    : { produced: false, reason: pace.narration.reason }
  try {
    if (!videoEnabled(env)) {
      return {
        produced: false,
        reason: videoOffReason(env),
        narration,
        pace: paced,
      }
    }
    if (req.features.length === 0) {
      return {
        produced: false,
        reason: "no tour feature ran",
        narration,
        pace: paced,
      }
    }
    const problem = ffmpegProblem()
    if (problem) {
      return { produced: false, reason: problem, narration, pace: paced }
    }

    const features = sortFeatures(req.features, tour.areas)
    const options = timelineOptionsFor(pace)
    const lines = new Map<string, NarrationLines>()
    const linesOf = (letter: string | null) => {
      if (!letter) return {}
      if (!lines.has(letter)) {
        lines.set(letter, kit.lines(tourNarrationModule(letter)))
      }
      return lines.get(letter)!
    }

    // Plain timelines and every line, so they are synthesized in one go.
    const plain = new Map<string, { timeline: Timeline; texts: ReelTexts }>()
    for (const f of features) {
      if (!hasReel(f)) continue
      const rec = f.recording!
      const timeline = buildTimeline(
        reelInput(rec, await probeDuration(rec.videoPath), tour.initialPersona),
        { ...options, bookends: false },
      )
      plain.set(f.id, { timeline, texts: { captions: [], mail: [] } })
    }
    const plans = {
      areas: areasOf(features, tour.areas).map((area) => ({
        area,
        segments: planAreaVideo(area, features, tour.areas),
      })),
      tour: planTourVideo(features, tour.areas),
    }
    const cardText = new Map<string, string | null>()
    // Anything that throws while the lines are prepared costs the narration
    // only (the silent videos), never the videos.
    let prepared: { narrator: Narrator | null; outcome: NarrationOutcome } = {
      narrator: null,
      outcome: narration,
    }
    if (pace.narration.on) {
      try {
        for (const f of features) {
          const base = plain.get(f.id)
          if (!base) continue
          const rec = f.recording!
          base.texts = reelTexts(
            base.timeline,
            rec.steps,
            rec.log.mail,
            linesOf(f.area),
            kit.reelCopy,
          )
        }
        for (const segment of [
          ...plans.areas.flatMap((a) => a.segments),
          ...plans.tour.segments,
        ]) {
          if (segment.kind !== "card") continue
          const name = cardName(segment.card)
          if (cardText.has(name)) continue
          cardText.set(
            name,
            kit.narration.tourCardLine(
              linesOf(cardArea(segment.card, features)),
              cardLineData(segment.card, features, req.target, tour.areas),
            ),
          )
        }
        prepared = await kit.prepareNarration(
          pace.narration,
          [
            ...[...plain.values()].flatMap((p) => [
              ...p.texts.captions,
              ...p.texts.mail,
            ]),
            ...cardText.values(),
          ],
          env,
        )
      } catch (error) {
        for (const base of plain.values()) {
          base.texts = { captions: [], mail: [] }
        }
        cardText.clear()
        prepared = {
          narrator: null,
          outcome: {
            produced: false,
            reason: firstLine(
              error instanceof Error ? error.message : String(error),
            ),
          },
        }
      }
    }
    narration = prepared.outcome
    try {
      const made = await buildTourVideos(
        req,
        kit,
        tour,
        features,
        plans,
        plain,
        cardText,
        prepared.narrator,
        render,
      )
      return { ...made, narration, pace: paced }
    } catch (error) {
      if (!prepared.narrator) throw error
      // Narration never costs the video: the silent cut, as without it.
      narration = {
        produced: false,
        reason: `the narrated video failed (${firstLine(error instanceof Error ? error.message : String(error))})`,
      }
      const made = await buildTourVideos(
        req,
        kit,
        tour,
        features,
        plans,
        plain,
        cardText,
        null,
        render,
      )
      return { ...made, narration, pace: paced }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      produced: false,
      reason: firstLine(message),
      narration,
      pace: paced,
    }
  }
}

interface Plans {
  areas: { area: string; segments: TourSegment[] }[]
  tour: { segments: TourSegment[]; body: TourSegment[] }
}

/** Renders, encodes and joins every part; `narrator` null = silent. */
async function buildTourVideos(
  req: TourVideoRequest,
  kit: VideoKit,
  tour: TourVideoConfig,
  features: TourFeatureRecord[],
  basePlans: Plans,
  plain: Map<string, { timeline: Timeline; texts: ReelTexts }>,
  cardText: Map<string, string | null>,
  narrator: Narrator | null,
  render: PngRenderer,
): Promise<{
  produced: true
  areas: (TourVideoFile & { area: string })[]
  tour: TourVideoFile
  featureStarts: Record<string, number>
}> {
  const { cards, tourCards } = kit
  const copy = cards.copy.tour
  const work = join(req.dir, "video", "tour")
  mkdirSync(work, { recursive: true })
  const logos = kit.brand.logos()
  const byId = new Map(features.map((f) => [f.id, f]))
  const areas = areasOf(features, tour.areas)
  const areaTitle = (letter: string) =>
    tour.areas.find((a) => a.letter === letter)!.title
  const jobs: PngJob[] = []
  const png = (name: string) => join(work, `${name}.png`)
  const mp4 = (name: string) => join(work, `${name}.mp4`)

  // Cards held long enough for their sentence (narrated only).
  const hold = (segments: TourSegment[]): TourSegment[] =>
    segments.map((segment) =>
      segment.kind === "card" && narrator
        ? {
            ...segment,
            durationSec: cardHoldSec(
              segment.durationSec,
              narrator.seconds(cardText.get(cardName(segment.card))),
            ),
          }
        : segment,
    )
  const plans: Plans = {
    areas: basePlans.areas.map((a) => ({ ...a, segments: hold(a.segments) })),
    tour: {
      segments: hold(basePlans.tour.segments),
      body: hold(basePlans.tour.body),
    },
  }

  // 1. Each feature's reel: overlays rendered, then one encode per reel.
  const reels: {
    feature: TourFeatureRecord
    parts: ProgramPart[]
    audio: AudioTrack | null
    timeline: Timeline
    cues: (NarrationCue & { text: string | null })[]
  }[] = []
  const reelSec: Record<string, number> = {}
  for (const f of features) {
    const base = plain.get(f.id)
    if (!base) continue
    const rec = f.recording!
    const narrated = narrator
      ? narrateReel(base.timeline, base.texts, narrator)
      : null
    const timeline = narrated?.timeline ?? base.timeline
    const id = `${f.id}`
    jobs.push({
      path: png(`${id}-frame`),
      html: cards.frameHtml(
        logos,
        req.runId,
        req.target,
        `${copy.frameLabel} · ${f.id} ${f.title}`,
      ),
      transparent: true,
    })
    const captions = timeline.captions.map((c, i) => {
      const step = rec.steps[c.step]
      const path = png(`${id}-caption-${i + 1}`)
      jobs.push({
        path,
        html: cards.captionHtml(step.id, step.failed ? "failed" : "passed"),
        transparent: true,
      })
      return path
    })
    const emails = rec.log.mail.map((card, i) => {
      const path = png(`${id}-email-${i + 1}`)
      jobs.push({ path, html: cards.emailHtml(logos, card) })
      return path
    })
    const personaBadges: Record<string, string> = {}
    for (const w of timeline.personas) {
      if (personaBadges[w.persona]) continue
      personaBadges[w.persona] = png(
        `persona-${w.persona.replace(/[^a-z0-9]+/gi, "-")}`,
      )
      if (!jobs.some((j) => j.path === personaBadges[w.persona])) {
        jobs.push({
          path: personaBadges[w.persona],
          html: tourCards.personaBadgeHtml(w.persona),
          transparent: true,
        })
      }
    }
    const speedBadges: Record<number, string> = {}
    for (const badge of segmentBadges(timeline, kit.reelCopy)) {
      speedBadges[badge.index] = png(`${id}-speed-${badge.index}`)
      jobs.push({
        path: speedBadges[badge.index],
        html: badge.html,
        transparent: true,
      })
    }
    const parts: ProgramPart[] = [
      {
        kind: "reel",
        timeline,
        files: {
          appVideo: rec.videoPath,
          frame: png(`${id}-frame`),
          captions,
          emails,
          speedBadges,
          personaBadges,
        },
      },
    ]
    reels.push({
      feature: f,
      parts,
      timeline,
      audio: narrator
        ? { clips: narrated?.clips ?? [], durationSec: programSec(parts) }
        : null,
      cues: (narrated?.cues ?? []).map((cue) => ({
        ...cue,
        text:
          cue.kind === "caption"
            ? base.texts.captions[cue.index]
            : cue.kind === "mail"
              ? base.texts.mail[cue.index]
              : null,
      })),
    })
  }

  // 2. Every card still (named by its content, rendered once).
  const cardHtml = (card: TourCard): string => {
    const meta = (letter: string) => ({
      logos,
      letter,
      title: areaTitle(letter),
      count: features.filter((f) => f.area === letter).length,
      target: req.target,
      pace: req.pace,
      runId: req.runId,
    })
    const target =
      req.target === "staging"
        ? copy.targetName.staging
        : copy.targetName.development
    switch (card.kind) {
      case "tour-intro":
        return tourCards.tourIntroHtml({
          logos,
          target: req.target,
          runId: req.runId,
          startedAt: req.startedAt,
          pace: req.pace,
          areas: areas.map((letter) => ({
            letter,
            title: areaTitle(letter),
            count: features.filter((f) => f.area === letter).length,
          })),
        })
      case "area-intro":
        return tourCards.areaIntroHtml(meta(card.area))
      case "area-chapter":
        return tourCards.areaIntroHtml(meta(card.area), true)
      case "feature": {
        const f = byId.get(card.feature)!
        return tourCards.featureCardHtml({
          logos,
          id: f.id,
          title: f.title,
          area: `${f.area} · ${areaTitle(f.area)}`,
          policy: f.policy,
          kind: card.card,
          reason: f.reason,
        })
      }
      case "area-scoreboard": {
        const own = features.filter((f) => f.area === card.area)
        return tourCards.scoreboardHtml({
          logos,
          heading: copy.areaHeading(card.area, areaTitle(card.area)),
          subheading: `${target} · ${req.runId}`,
          columns: [target],
          rows: scoreRows(own, card.page, tour.areas),
          counts: countStatuses(own),
          page: card.page,
          pages: card.pages,
        })
      }
      case "tour-summary":
        return tourCards.scoreboardHtml({
          logos,
          heading: copy.title,
          subheading: `${target} · ${req.runId}`,
          columns: [target],
          rows: areas.map((letter) => {
            const own = features.filter((f) => f.area === letter)
            const failed = own.some((f) => f.status === "failed")
            const ran = own.filter(verified)
            return {
              id: letter,
              title: copy.areaSummary(
                areaTitle(letter),
                ran.length,
                own.length,
              ),
              cells: [
                {
                  status: failed
                    ? "failed"
                    : ran.length > 0
                      ? "passed"
                      : "dev-only",
                  durationMs: own.reduce(
                    (sum, f) => sum + (f.durationMs ?? 0),
                    0,
                  ),
                },
              ],
            }
          }),
          counts: countStatuses(features),
          verdict: req.verdict,
          page: 1,
          pages: 1,
        })
      case "tour-scoreboard":
        return tourCards.scoreboardHtml({
          logos,
          heading: copy.everyFeature,
          subheading: `${target} · ${req.runId}`,
          columns: [target],
          rows: scoreRows(features, card.page, tour.areas),
          counts: countStatuses(features),
          verdict: req.verdict,
          page: card.page,
          pages: card.pages,
        })
    }
  }
  const stills = new Map<string, { card: TourCard; durationSec: number }>()
  const rendered = new Set<string>()
  for (const segment of [
    ...plans.areas.flatMap((a) => a.segments),
    ...plans.tour.segments,
  ]) {
    if (segment.kind !== "card") continue
    const key = cardKey(segment)
    if (stills.has(key)) continue
    stills.set(key, segment)
    // The PNG is named by content; one per card even at two lengths.
    const name = cardName(segment.card)
    if (!rendered.has(name)) {
      rendered.add(name)
      jobs.push({ path: png(name), html: cardHtml(segment.card) })
    }
  }
  await render(jobs)

  // 3. Encode: each card as a still clip, each reel once. Both are probed:
  // the placement uses the real lengths (see placeSegments). Narrated, every
  // part carries a sound track (silence where nothing is said), so the
  // joins keep the audio.
  const cardSec: Record<string, number> = {}
  for (const [key, { card, durationSec }] of stills) {
    const clip = narrator?.clip(cardText.get(cardName(card)))
    await composeProgram(
      [{ kind: "still", path: png(cardName(card)), durationSec }],
      mp4(key),
      undefined,
      narrator
        ? {
            clips: clip ? [{ path: clip.path, atSec: CARD_LEAD_SEC }] : [],
            durationSec: programSec([{ kind: "still", path: "", durationSec }]),
          }
        : null,
    )
    cardSec[key] = await probeDuration(mp4(key))
  }
  for (const { feature, parts, audio } of reels) {
    await composeProgram(parts, mp4(`${feature.id}-reel`), undefined, audio)
    reelSec[feature.id] = await probeDuration(mp4(`${feature.id}-reel`))
  }
  const fileOf = (segment: TourSegment) =>
    segment.kind === "reel"
      ? mp4(`${segment.feature}-reel`)
      : mp4(cardKey(segment))

  // 4. Concatenate: one MP4 per area, one for the whole tour.
  const write = (path: string, content: string) => writeFileSync(path, content)
  const withAudio = narrator ? { scratchDir: work } : null
  const areaFiles: (TourVideoFile & { area: string })[] = []
  for (const plan of plans.areas) {
    const output = join(req.dir, areaVideoName(plan.area, req.runId))
    await concatSegments(
      plan.segments.map(fileOf),
      output,
      join(work, `area-${plan.area}.txt`),
      write,
      undefined,
      withAudio,
    )
    areaFiles.push({
      area: plan.area,
      path: output,
      durationSec: Math.round((await probeDuration(output)) * 10) / 10,
    })
  }
  const tourOutput = join(req.dir, tourVideoName(tour.module, req.runId))
  await concatSegments(
    plans.tour.segments.map(fileOf),
    tourOutput,
    join(work, "tour.txt"),
    write,
    undefined,
    withAudio,
  )
  const placed = placeSegments(plans.tour.segments, reelSec, cardSec)

  const manifest: TourVideoManifest = {
    runId: req.runId,
    target: req.target,
    body: plans.tour.body.map((segment) => ({
      file: relative(req.dir, fileOf(segment)),
      durationSec:
        segment.kind === "card"
          ? (cardSec[cardKey(segment)] ?? segment.durationSec)
          : (reelSec[segment.feature] ?? 0),
      ...(segment.kind === "reel" ? { feature: segment.feature } : {}),
    })),
    features: features.map((f) => ({
      id: f.id,
      title: f.title,
      area: f.area,
      status: f.status,
      durationMs: f.durationMs,
    })),
    narrated: narrator !== null,
  }
  // Per reel: its segments (holds, speeds) and, narrated, each sentence
  // with where it starts in the reel: for checking a cut or a frame by hand.
  // Timings, step lines and file names only.
  const reelsJson = Object.fromEntries(
    reels.map((r) => [
      r.feature.id,
      {
        startsAtInTour: placed.features[r.feature.id] ?? null,
        segments: r.timeline.segments,
        captions: r.timeline.captions,
        narration: r.cues,
      },
    ]),
  )
  writeFileSync(
    join(req.dir, TOUR_VIDEO_MANIFEST),
    `${JSON.stringify({ ...manifest, featureStarts: placed.features, starts: placed.starts, cards: Object.fromEntries([...cardText].map(([name, text]) => [name, text])), reels: reelsJson }, null, 2)}\n`,
  )
  return {
    produced: true,
    areas: areaFiles,
    tour: {
      path: tourOutput,
      durationSec: Math.round((await probeDuration(tourOutput)) * 10) / 10,
    },
    featureStarts: placed.features,
  }
}
