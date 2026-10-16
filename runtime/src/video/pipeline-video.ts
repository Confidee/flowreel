// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"

import type { Env } from "../core/env.js"
import { narrationForcedOff } from "../narration/narration.js"
import type { PipelineVerdict, StageResult } from "../pipeline/decisions.js"
import type { FeatureStatus } from "../reporter/status.js"
import type { NarrationOutcome, Narrator } from "../voice/narrator.js"

import type {
  Cards,
  ComparisonCell,
  ComparisonData,
  PipelineStageCard,
} from "./cards.js"
import {
  type AudioTrack,
  type ProgramPart,
  composeProgram,
  concatSegments,
  ffmpegProblem,
  probeDuration,
  programSec,
} from "./ffmpeg.js"
import type { VideoKit } from "./kit.js"
import { videoEnabled, videoOffReason } from "./recorder.js"
import { narrateReel, segmentBadges } from "./reel-voice.js"
import { type PngJob, renderPngs } from "./render.js"
import { type ReelManifest, type VideoOutcome, readReel } from "./run-video.js"
import { CARD_LEAD_SEC, buildTimeline } from "./timeline.js"
import { SCOREBOARD_ROWS } from "./tour-cards.js"
import {
  type PngRenderer,
  type TourVideoArea,
  type TourVideoConfig,
  cardHoldSec,
  readTourVideoManifest,
} from "./tour-video.js"

// The development -> staging pipeline's combined video: pipeline intro (both
// stages listed) -> "Development" chapter card + stage 1's recording with
// its captions and email cards (no intro/outro of its own) -> "Staging"
// chapter card + stage 2's, or that card alone saying why there is nothing
// to show ("not configured", "not run (development FAIL)", no recording) ->
// comparison outro (verdicts, steps side by side, latencies development vs
// staging). Nothing is re-recorded: each stage's own run left a reel
// (video/reel.json, written by produceVideo) and its body is rebuilt with
// the same timeline function, bookends off. Like produceVideo it never
// throws: any problem is { produced: false, reason }.
//
// Narration: when a stage's own video was narrated, the combined video is
// too: the pipeline's cards say their line (the narration copy's pipeline
// lines) and each stage's reel says what it said in its own video
// (reel.json / tour.json), from the voice cache.

export const PIPELINE_CHAPTER_SEC = 2.5
/** A chapter card that stands in for a stage with nothing to play. */
export const CHAPTER_ALONE_SEC = 5
export const PIPELINE_INTRO_SEC = 4
export const COMPARISON_SEC = 7

/** The slice of a stage's summary.json the pipeline video reads. */
export interface StageSummary {
  runId?: string
  verdict?: string
  verdictReason?: string
  tests?: {
    project: string
    steps: { id: string; status: string; durationMs: number | null }[]
  }[]
  latenciesMs?: Record<string, unknown>
  video?: { produced: boolean; reason?: string }
}

/** One stage (development or staging) of a pipeline video. */
export interface CombinedStage {
  /** The stage's outcome as the pipeline decided it (its StageResult). */
  result: Pick<StageResult, "verdict" | "reason">
  /** "Development" / "Staging". */
  title: string
  detail: string
  runId: string | null
  /** The stage run's results folder when the stage ran. */
  dir: string | null
  summary: StageSummary | null
}

/**
 * What produceCombinedVideo and produceCombinedTourVideo make one
 * development -> staging video from: the pipeline's outcome and its stages.
 */
export interface CombinedRequest {
  /** The module the pipeline ran (its video file's name). */
  module: string
  pipelineId: string
  /** The pipeline's results folder. */
  dir: string
  startedAt: Date
  verdict: PipelineVerdict
  reason: string
  stages: CombinedStage[]
}

export const combinedFileName = (module: string, pipelineId: string) =>
  `${module}-${pipelineId}.mp4`

const RAN = new Set(["PASS", "FAIL", "N/A"])

/** Pure: what the comparison outro shows (latency order from the cards' copy). */
export function comparisonData(
  req: CombinedRequest,
  cards: Pick<Cards, "latencyKeys" | "latencyLabel">,
): ComparisonData {
  // summary.json is another process's output: a shape it does not have
  // reads as "nothing recorded", never a throw.
  const tables = req.stages.map((stage) => {
    if (!RAN.has(stage.result.verdict)) return null
    const tests = stage.summary?.tests
    const own = Array.isArray(tests)
      ? tests.find((t) => t?.project === req.module)
      : undefined
    return Array.isArray(own?.steps) ? own.steps : null
  })
  const ids: string[] = []
  for (const table of tables) {
    for (const step of table ?? []) {
      if (!ids.includes(step.id)) ids.push(step.id)
    }
  }
  const rows = ids.map((id) => ({
    id,
    cells: tables.map((table): ComparisonCell | null => {
      if (!table) return null
      const step = table.find((s) => s.id === id)
      return step
        ? { status: step.status, durationMs: step.durationMs }
        : { status: "not run", durationMs: null }
    }),
  }))

  const latencyMaps = req.stages.map((stage) => {
    const map = RAN.has(stage.result.verdict)
      ? stage.summary?.latenciesMs
      : undefined
    return map && typeof map === "object" && !Array.isArray(map) ? map : {}
  })
  const known = cards.latencyKeys
  const keys = [
    ...new Set(latencyMaps.flatMap((map) => Object.keys(map))),
  ].sort((a, b) => {
    const rank = (key: string) =>
      known.includes(key) ? known.indexOf(key) : Infinity
    return rank(a) - rank(b)
  })
  const latencies = keys.map((key) => ({
    key,
    label: cards.latencyLabel(key),
    values: latencyMaps.map((map) => {
      const value = Number(map[key])
      return key in map && Number.isFinite(value) ? value : null
    }),
  }))

  return {
    pipelineId: req.pipelineId,
    verdict: req.verdict,
    reason: req.reason,
    stages: req.stages.map((stage) => ({
      title: stage.title,
      verdict: stage.result.verdict,
      runId: RAN.has(stage.result.verdict) ? stage.runId : null,
    })),
    rows,
    latencies,
  }
}

/**
 * A stage's reel when it can be spliced in, else why not. The reel must
 * match its own timeline (one caption PNG per caption, one card per mail)
 * and every file must still be there.
 */
export function stageReel(
  stage: CombinedStage,
): { reel: ReelManifest; note: null } | { reel: null; note: string } {
  if (!RAN.has(stage.result.verdict)) {
    // "not run (development FAIL)" under a "Not run" heading: drop the echo.
    const note = stage.result.reason.replace(
      /^(not run|skipped) \((.*)\)$/,
      "$2",
    )
    return { reel: null, note }
  }
  const noRecording = (why: string) => ({
    reel: null,
    note: `${stage.result.reason} No recording: ${why}.`.trim(),
  })
  const video = stage.summary?.video
  if (!video?.produced) {
    return noRecording(video?.reason ?? "the run video was not produced")
  }
  const reel = stage.dir ? readReel(stage.dir) : null
  if (!reel) return noRecording("the run left no reel")
  const timeline = buildTimeline(reel.input, {
    ...reel.timeline,
    bookends: false,
  })
  if (
    timeline.captions.length !== reel.captions.length ||
    reel.input.mail.length !== reel.emails.length
  ) {
    return noRecording("the reel does not match its timeline")
  }
  const files = [reel.appVideo, reel.frame, ...reel.captions, ...reel.emails]
  if (!files.every((path) => existsSync(path))) {
    return noRecording("a recording file is missing")
  }
  return { reel, note: null }
}

/**
 * Makes the development -> staging pipeline's combined video of a
 * single-flow module: pipeline intro, then per stage a chapter card and
 * that stage's recording rebuilt from its reel.json (or the chapter card
 * alone saying why there is nothing to play), then the comparison outro.
 * Nothing is re-recorded. Writes <req.dir>/<module>-<pipelineId>.mp4;
 * working files go to <req.dir>/video/.
 *
 * `kit` supplies the brand, the cards and their copy, and the narration
 * (said only when a stage's own video was narrated, from the voice cache).
 * Never throws: video off, no ffmpeg, no stage recording or any failure is
 * { produced: false, reason }.
 */
export async function produceCombinedVideo(
  req: CombinedRequest,
  kit: VideoKit,
  env: Env = process.env,
  render: PngRenderer = renderPngs,
): Promise<VideoOutcome> {
  let narration: NarrationOutcome = {
    produced: false,
    reason: "no stage video was narrated",
  }
  try {
    if (!videoEnabled(env)) {
      return { produced: false, reason: videoOffReason(env), narration }
    }
    const problem = ffmpegProblem()
    if (problem) return { produced: false, reason: problem, narration }

    const lines = kit.narration.copy.pipeline
    const reels = req.stages.map(stageReel)
    const cards: PipelineStageCard[] = req.stages.map((stage, i) => ({
      title: stage.title,
      detail: stage.detail,
      runId: RAN.has(stage.result.verdict) ? stage.runId : null,
      verdict: stage.result.verdict,
      note: reels[i].note,
    }))
    const stillLines = {
      intro: lines.intro,
      chapters: req.stages.map((stage, i) =>
        lines.chapter(stage.title, reels[i].reel !== null),
      ),
      outro: lines.outro,
    }
    const narrated =
      !narrationForcedOff(env) && reels.some((r) => r.reel?.narration)
    if (narrated) {
      const prepared = await kit.prepareNarration(
        { on: true },
        [
          stillLines.intro,
          ...stillLines.chapters,
          stillLines.outro,
          ...reels.flatMap((r) => [
            ...(r.reel?.narration?.captions ?? []),
            ...(r.reel?.narration?.mail ?? []),
          ]),
        ],
        env,
      )
      narration = prepared.outcome
      if (prepared.narrator) {
        try {
          const made = await buildCombinedVideo(
            req,
            kit,
            reels,
            cards,
            stillLines,
            prepared.narrator,
            render,
          )
          return { ...made, narration }
        } catch (error) {
          narration = {
            produced: false,
            reason: `the narrated video failed (${firstLine(error instanceof Error ? error.message : String(error))})`,
          }
        }
      }
    }
    const made = await buildCombinedVideo(
      req,
      kit,
      reels,
      cards,
      stillLines,
      null,
      render,
    )
    return { ...made, narration }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { produced: false, reason: firstLine(message), narration }
  }
}

const firstLine = (message: string) =>
  (message.split("\n").find((l) => l.trim() !== "") ?? message).slice(0, 300)

async function buildCombinedVideo(
  req: CombinedRequest,
  kit: VideoKit,
  reels: ReturnType<typeof stageReel>[],
  cards: PipelineStageCard[],
  stillLines: { intro: string; chapters: string[]; outro: string },
  narrator: Narrator | null,
  render: PngRenderer,
): Promise<{ produced: true; path: string; durationSec: number }> {
  const work = join(req.dir, "video")
  mkdirSync(work, { recursive: true })
  const logos = kit.brand.logos()
  const png = (name: string) => join(work, `${name}.png`)
  const jobs: PngJob[] = []
  const parts: ProgramPart[] = []
  const clips: AudioTrack["clips"] = []
  const spoken: { atSec: number; text: string }[] = []
  let at = 0
  const still = (
    name: string,
    html: string,
    nominalSec: number,
    line: string,
  ) => {
    const durationSec = narrator
      ? cardHoldSec(nominalSec, narrator.seconds(line))
      : nominalSec
    jobs.push({ path: png(name), html })
    parts.push({ kind: "still", path: png(name), durationSec })
    const clip = narrator?.clip(line)
    if (clip) {
      clips.push({ path: clip.path, atSec: at + CARD_LEAD_SEC })
      spoken.push({ atSec: at + CARD_LEAD_SEC, text: line })
    }
    at += programSec([{ kind: "still", path: "", durationSec }])
  }

  still(
    "intro",
    kit.cards.pipelineIntroHtml({
      logos,
      module: req.module,
      pipelineId: req.pipelineId,
      startedAt: req.startedAt,
      stages: cards,
    }),
    PIPELINE_INTRO_SEC,
    stillLines.intro,
  )
  req.stages.forEach((_stage, i) => {
    const { reel } = reels[i]
    still(
      `chapter-${i + 1}`,
      kit.cards.chapterHtml(logos, i, cards[i]),
      reel ? PIPELINE_CHAPTER_SEC : CHAPTER_ALONE_SEC,
      stillLines.chapters[i],
    )
    if (!reel) return
    const plain = buildTimeline(reel.input, {
      ...reel.timeline,
      bookends: false,
    })
    const voiced =
      narrator && reel.narration
        ? narrateReel(plain, reel.narration, narrator)
        : null
    const timeline = voiced?.timeline ?? plain
    const speedBadges: Record<number, string> = {}
    for (const badge of segmentBadges(timeline, kit.reelCopy)) {
      speedBadges[badge.index] = png(`stage-${i + 1}-speed-${badge.index}`)
      jobs.push({
        path: speedBadges[badge.index],
        html: badge.html,
        transparent: true,
      })
    }
    const part: ProgramPart = {
      kind: "reel",
      timeline,
      files: {
        appVideo: reel.appVideo,
        frame: reel.frame,
        captions: reel.captions,
        emails: reel.emails,
        speedBadges,
      },
    }
    parts.push(part)
    for (const clip of voiced?.clips ?? []) {
      clips.push({ path: clip.path, atSec: at + clip.atSec })
    }
    for (const cue of voiced?.cues ?? []) {
      const text =
        cue.kind === "caption"
          ? reel.narration?.captions[cue.index]
          : cue.kind === "mail"
            ? reel.narration?.mail[cue.index]
            : null
      if (text) spoken.push({ atSec: at + cue.atSec, text })
    }
    at += programSec([part])
  })
  still(
    "outro",
    kit.cards.comparisonHtml(logos, comparisonData(req, kit.cards)),
    COMPARISON_SEC,
    stillLines.outro,
  )

  await render(jobs)
  // Where each part starts in the MP4 (seconds), for finding a frame or
  // checking a cut by hand. Timings and file names (relative to the
  // pipeline folder) only.
  const inDir = (path: string) => relative(req.dir, path)
  let offset = 0
  const placed = parts.map((part) => {
    const startSec = Math.round(offset * 1000) / 1000
    if (part.kind === "still") {
      offset += part.durationSec
      return {
        startSec,
        kind: "still",
        path: inDir(part.path),
        durationSec: part.durationSec,
      }
    }
    const durationSec = part.timeline.segments.reduce(
      (sum, segment) => sum + segment.durationSec,
      0,
    )
    offset += durationSec
    return {
      startSec,
      kind: "reel",
      appVideo: inDir(part.files.appVideo),
      durationSec: Math.round(durationSec * 1000) / 1000,
      segments: part.timeline.segments,
      captions: part.timeline.captions,
    }
  })
  writeFileSync(
    join(work, "program.json"),
    `${JSON.stringify({ parts: placed, narration: spoken }, null, 2)}\n`,
  )

  const output = join(req.dir, combinedFileName(req.module, req.pipelineId))
  await composeProgram(
    parts,
    output,
    undefined,
    narrator ? { clips, durationSec: programSec(parts) } : null,
  )
  return {
    produced: true,
    path: output,
    durationSec: Math.round((await probeDuration(output)) * 10) / 10,
  }
}

// ---------------------------------------------------------------------------
// The tour's combined video: pipeline intro -> "Development" chapter + the
// development tour's body (area chapters, feature cards and reels, exactly
// the files its own tour MP4 was joined from) -> "Staging" chapter + the
// staging tour's body (or that card alone, saying why) -> the side-by-side
// scoreboard (every feature, development vs staging). Nothing is
// re-recorded or re-encoded: the parts are joined as they are.
// ---------------------------------------------------------------------------

/** The slice of a stage's summary.json `features` the pipeline reads. */
interface SummaryFeature {
  id: string
  title: string
  area: string
  status: FeatureStatus
  durationMs: number | null
}

export interface FeatureComparison {
  stages: string[]
  rows: {
    id: string
    title: string
    area: string
    cells: ({ status: FeatureStatus; durationMs: number | null } | null)[]
  }[]
}

/** Pure: every tour feature with one cell per stage (null = stage has none). */
export function featureComparison(
  req: CombinedRequest,
  areas: readonly TourVideoArea[],
): FeatureComparison {
  const lists = req.stages.map((stage) => {
    if (!RAN.has(stage.result.verdict)) return null
    const features = (stage.summary as { features?: unknown } | null)?.features
    return Array.isArray(features) ? (features as SummaryFeature[]) : null
  })
  const order: SummaryFeature[] = []
  for (const list of lists) {
    for (const f of list ?? []) {
      if (typeof f?.id === "string" && !order.some((o) => o.id === f.id)) {
        order.push(f)
      }
    }
  }
  const area = (l: string) => areas.findIndex((a) => a.letter === l)
  order.sort(
    (a, b) =>
      area(a.area) - area(b.area) ||
      Number(a.id.slice(1)) - Number(b.id.slice(1)),
  )
  return {
    stages: req.stages.map((s) => s.title),
    rows: order.map((f) => ({
      id: f.id,
      title: f.title,
      area: f.area,
      cells: lists.map((list) => {
        if (!list) return null
        const hit = list.find((x) => x?.id === f.id)
        return hit
          ? { status: hit.status, durationMs: hit.durationMs ?? null }
          : { status: "not run" as FeatureStatus, durationMs: null }
      }),
    })),
  }
}

/** A stage's tour body files when they can be joined, else why not. */
export function stageTourBody(
  stage: CombinedStage,
):
  | { files: string[]; note: null; narrated?: boolean }
  | { files: null; note: string } {
  if (!RAN.has(stage.result.verdict)) {
    return {
      files: null,
      note: stage.result.reason.replace(/^(not run|skipped) \((.*)\)$/, "$2"),
    }
  }
  const video = (
    stage.summary as {
      tourVideo?: { produced?: boolean; reason?: string }
    } | null
  )?.tourVideo
  if (!video?.produced) {
    return {
      files: null,
      note: `${stage.result.reason} No tour video: ${video?.reason ?? "it was not produced"}.`.trim(),
    }
  }
  const manifest = stage.dir ? readTourVideoManifest(stage.dir) : null
  if (!manifest || manifest.bodyFiles.length === 0) {
    return {
      files: null,
      note: `${stage.result.reason} No tour video: the run left no tour.json.`.trim(),
    }
  }
  if (!manifest.bodyFiles.every((path) => existsSync(path))) {
    return {
      files: null,
      note: `${stage.result.reason} No tour video: a part is missing.`.trim(),
    }
  }
  return {
    files: manifest.bodyFiles,
    note: null,
    narrated: manifest.narrated === true,
  }
}

/** The tour module as the pipeline intro names it ("my-tour" -> "my tour"). */
export const tourLabel = (module: string) => module.replace(/-/g, " ")

/**
 * The pipeline's combined video of a tour: like produceCombinedVideo, but
 * each stage's part is its tour body (video/tour.json's segments) and the
 * outro compares every feature's status development vs staging. Writes
 * <req.dir>/<module>-<pipelineId>.mp4; working files go to <req.dir>/video/.
 *
 * `kit` supplies the brand, cards, copy and narration; `tour` the tour's
 * module name and its areas in catalogue order (feature order in the
 * comparison). Never throws: any problem is { produced: false, reason }.
 */
export async function produceCombinedTourVideo(
  req: CombinedRequest,
  kit: VideoKit,
  tour: Pick<TourVideoConfig, "module" | "areas">,
  env: Env = process.env,
  render: PngRenderer = renderPngs,
): Promise<VideoOutcome> {
  let narration: NarrationOutcome = {
    produced: false,
    reason: "no stage video was narrated",
  }
  try {
    if (!videoEnabled(env)) {
      return { produced: false, reason: videoOffReason(env), narration }
    }
    const problem = ffmpegProblem()
    if (problem) return { produced: false, reason: problem, narration }

    const lines = kit.narration.copy.pipeline
    const copy = kit.cards.copy.tour
    const work = join(req.dir, "video")
    mkdirSync(work, { recursive: true })
    const logos = kit.brand.logos()
    const bodies = req.stages.map(stageTourBody)
    const cards: PipelineStageCard[] = req.stages.map((stage, i) => ({
      title: stage.title,
      detail: stage.detail,
      runId: RAN.has(stage.result.verdict) ? stage.runId : null,
      verdict: stage.result.verdict,
      note: bodies[i].note,
    }))
    const comparison = featureComparison(req, tour.areas)
    const pages = Math.max(
      1,
      Math.ceil(comparison.rows.length / SCOREBOARD_ROWS),
    )

    const stills: {
      name: string
      html: string
      durationSec: number
      line: string | null
    }[] = [
      {
        name: "intro",
        html: kit.cards.pipelineIntroHtml({
          logos,
          module: tourLabel(tour.module),
          pipelineId: req.pipelineId,
          startedAt: req.startedAt,
          stages: cards,
        }),
        durationSec: PIPELINE_INTRO_SEC,
        line: lines.intro,
      },
      ...req.stages.map((stage, i) => ({
        name: `chapter-${i + 1}`,
        html: kit.cards.chapterHtml(logos, i, cards[i]),
        durationSec: bodies[i].files ? PIPELINE_CHAPTER_SEC : CHAPTER_ALONE_SEC,
        line: lines.chapter(stage.title, bodies[i].files !== null),
      })),
      ...Array.from({ length: pages }, (_, p) => ({
        name: `score-${p + 1}`,
        html: kit.tourCards.scoreboardHtml({
          logos,
          heading: copy.comparison,
          subheading: req.pipelineId,
          columns: comparison.stages,
          rows: comparison.rows
            .slice(p * SCOREBOARD_ROWS, (p + 1) * SCOREBOARD_ROWS)
            .map((r) => ({ id: r.id, title: r.title, cells: r.cells })),
          counts: {},
          verdict: req.verdict,
          page: p + 1,
          pages,
        }),
        durationSec: COMPARISON_SEC,
        line: p === 0 ? lines.outro : null,
      })),
    ]

    // Narrated when a stage's tour was: the cards say their line too, and
    // every joined part keeps (or gets) a sound track.
    let narrator: Narrator | null = null
    if (
      !narrationForcedOff(env) &&
      bodies.some((b) => b.files && "narrated" in b && b.narrated)
    ) {
      const prepared = await kit.prepareNarration(
        { on: true },
        stills.map((s) => s.line),
        env,
      )
      narration = prepared.outcome
      narrator = prepared.narrator
    }
    const png = (name: string) => join(work, `${name}.png`)
    const mp4 = (name: string) => join(work, `${name}.mp4`)
    await render(stills.map((s) => ({ path: png(s.name), html: s.html })))
    const encodeStills = async (voice: Narrator | null) => {
      for (const still of stills) {
        const durationSec = voice
          ? cardHoldSec(still.durationSec, voice.seconds(still.line))
          : still.durationSec
        const clip = voice?.clip(still.line)
        await composeProgram(
          [{ kind: "still", path: png(still.name), durationSec }],
          mp4(still.name),
          undefined,
          voice
            ? {
                clips: clip ? [{ path: clip.path, atSec: CARD_LEAD_SEC }] : [],
                durationSec: programSec([
                  { kind: "still", path: "", durationSec },
                ]),
              }
            : null,
        )
      }
    }

    const order: string[] = [mp4("intro")]
    req.stages.forEach((_, i) => {
      order.push(mp4(`chapter-${i + 1}`), ...(bodies[i].files ?? []))
    })
    for (let p = 0; p < pages; p++) order.push(mp4(`score-${p + 1}`))

    writeFileSync(
      join(work, "program.json"),
      `${JSON.stringify({ parts: order.map((path) => relative(req.dir, path)) }, null, 2)}\n`,
    )
    const output = join(req.dir, combinedFileName(req.module, req.pipelineId))
    const join_ = async (voice: Narrator | null) => {
      await encodeStills(voice)
      await concatSegments(
        order,
        output,
        join(work, "program.txt"),
        (path, content) => writeFileSync(path, content),
        undefined,
        voice ? { scratchDir: work } : null,
      )
    }
    try {
      await join_(narrator)
    } catch (error) {
      if (!narrator) throw error
      narration = {
        produced: false,
        reason: `the narrated video failed (${firstLine(error instanceof Error ? error.message : String(error))})`,
      }
      await join_(null)
    }
    return {
      produced: true,
      path: output,
      durationSec: Math.round((await probeDuration(output)) * 10) / 10,
      narration,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { produced: false, reason: firstLine(message), narration }
  }
}
