// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"

import type { Env } from "../core/env.js"
import {
  type VideoPace,
  timelineOptionsFor,
  videoPaceFor,
} from "../narration/narration.js"
import type { NarrationOutcome } from "../voice/narrator.js"

import type { OutroStep } from "./cards.js"
import {
  type AudioTrack,
  compose,
  ffmpegProblem,
  probeDuration,
  programSec,
} from "./ffmpeg.js"
import { withMediaSignal } from "./stop.js"
import type { VideoKit } from "./kit.js"
import { type VideoLogData, videoEnabled, videoOffReason } from "./recorder.js"
import {
  type NarratedReel,
  type ReelTexts,
  narrateReel,
  reelTexts,
  segmentBadges,
} from "./reel-voice.js"
import { type PngJob, renderPngs } from "./render.js"
import {
  type NarrationCue,
  type Timeline,
  type TimelineInput,
  type TimelineOptions,
  type TimelineStep,
  buildTimeline,
} from "./timeline.js"

// The branded video of one flow's run (the release-gate round trip), made by
// the summary reporter after the tests: <run dir>/<module>-<RUN_ID>.mp4. It
// never throws and never touches the verdict: anything that stops it
// becomes { produced: false, reason } for "video: not produced (<reason>)".

/** One test.step of the recorded flow, as the summary reporter saw it. */
export interface RecordedStep {
  id: string
  /** Worker wall clock (epoch ms), from Playwright's TestStep.startTime. */
  startMs: number
  durationMs: number
  failed: boolean
  /** The step's error text; narration says only its category. */
  error?: string | null
}

/** What produceVideo makes one run's MP4 from: the run, its flow and its summary table. */
export interface VideoRequest {
  /** The module the run belongs to: the MP4's name and its narration file. */
  module: string
  runId: string
  target: string
  /** The run's results folder. */
  dir: string
  startedAt: Date
  verdict: "PASS" | "FAIL" | "N/A"
  verdictReason: string
  /** The flow's test as recorded; null when it never ran. */
  flow: {
    status: string
    videoPath: string | null
    log: VideoLogData | null
    steps: RecordedStep[]
  } | null
  /** The summary's per-step table (plan steps included, run or not). */
  table: OutroStep[]
  latenciesMs: Record<string, unknown>
  /**
   * Stops the composition: every tool it started ends and the outcome is
   * not produced. The summary reporter passes one that aborts on Ctrl-C.
   */
  signal?: AbortSignal
}

/** What produceVideo returns (it never throws): the MP4, or why there is none. */
export type VideoOutcome = (
  | { produced: true; path: string; durationSec: number }
  | { produced: false; reason: string }
) & {
  /** Whether the video is narrated, and with what (or why not). */
  narration?: NarrationOutcome
  /** The pace the video was composed at. */
  pace?: Pick<VideoPace, "pace" | "slowFactor">
}

/** "<module>-<RUN_ID>.mp4" */
export const videoFileName = (module: string, runId: string) =>
  `${module}-${runId}.mp4`

/**
 * What a pipeline needs to splice this run's recording into its combined
 * video without re-recording: the timeline input (so it rebuilds the same
 * cuts body-only) and the page video and overlay PNGs already made. Paths
 * are relative to the run folder. Written only once the run's own MP4
 * exists, at <RUN_ID>/video/reel.json. Timings and file names only.
 */
export interface ReelManifest {
  input: TimelineInput
  appVideo: string
  frame: string
  captions: string[]
  emails: string[]
  /** The timeline options the run used (demo pace: slow factor, no fast-forward). */
  timeline?: Partial<Pick<TimelineOptions, "slowFactor" | "fastForward">>
  /** The run was narrated: what each caption and card said. */
  narration?: ReelTexts
}

/** Where a run's ReelManifest lives, relative to its run folder. */
export const REEL_FILE = join("video", "reel.json")

/** A run's reel with absolute paths, or null when it has none. */
export function readReel(runDir: string): ReelManifest | null {
  try {
    const raw = JSON.parse(
      readFileSync(join(runDir, REEL_FILE), "utf8"),
    ) as Partial<ReelManifest>
    // Relative and still inside the run folder once resolved
    // ("video/../../x" is refused like "../x").
    const inside = (path: unknown): path is string =>
      typeof path === "string" &&
      path !== "" &&
      !isAbsolute(path) &&
      !relative(runDir, resolve(runDir, path)).startsWith("..")
    if (
      !raw.input ||
      !inside(raw.appVideo) ||
      !inside(raw.frame) ||
      !Array.isArray(raw.captions) ||
      !Array.isArray(raw.emails) ||
      ![...raw.captions, ...raw.emails].every(inside)
    ) {
      return null
    }
    const at = (path: string) => resolve(runDir, path)
    const strings = (list: unknown) =>
      Array.isArray(list) &&
      list.every((t) => t === null || typeof t === "string")
    const narration =
      raw.narration &&
      strings(raw.narration.captions) &&
      strings(raw.narration.mail)
        ? raw.narration
        : undefined
    const options = raw.timeline ?? {}
    const timeline = {
      ...(typeof options.slowFactor === "number" && options.slowFactor >= 1
        ? { slowFactor: options.slowFactor }
        : {}),
      ...(typeof options.fastForward === "boolean"
        ? { fastForward: options.fastForward }
        : {}),
    }
    return {
      input: raw.input,
      appVideo: at(raw.appVideo),
      frame: at(raw.frame),
      captions: raw.captions.map(at),
      emails: raw.emails.map(at),
      ...(Object.keys(timeline).length > 0 ? { timeline } : {}),
      ...(narration ? { narration } : {}),
    }
  } catch {
    return null
  }
}

/** Why no video can be made from this run, or null when one can. */
export function videoBlocker(
  req: VideoRequest,
  env: Env = process.env,
): string | null {
  if (!videoEnabled(env)) return videoOffReason(env)
  const t = req.flow
  if (!t) return `the ${req.module} test did not run`
  if (t.status === "skipped") return `the ${req.module} test was skipped`
  if (!t.videoPath) return "no page recording was attached"
  if (typeof t.log?.videoStartedAt !== "number") return "no video timing log"
  if (t.steps.length === 0) return "no step was recorded"
  return null
}

const firstLine = (message: unknown) => {
  const text = typeof message === "string" ? message : String(message)
  return (text.split("\n").find((l) => l.trim() !== "") ?? text).slice(0, 300)
}

/**
 * Makes one flow run's branded video: intro card, the page recording with a
 * caption per step and an email card per mail the run saw, then the outro
 * (verdict, step table, latencies), narrated when videoPaceFor("round-trip")
 * says so. Writes <req.dir>/<module>-<RUN_ID>.mp4 and, once that exists,
 * <req.dir>/video/reel.json (REEL_FILE, what a pipeline splices in); its
 * working files go to <req.dir>/video/.
 *
 * `kit` supplies the brand, card copy, narration copy, curated lines
 * (kit.lines(req.module)) and voice. Never throws and never touches the
 * verdict: video off (FLOWREEL_VIDEO=off), no ffmpeg, no recording or any
 * failure is { produced: false, reason }.
 */
export function produceVideo(
  req: VideoRequest,
  kit: VideoKit,
  env: Env = process.env,
): Promise<VideoOutcome> {
  return withMediaSignal(req.signal, () => composeRunVideo(req, kit, env))
}

async function composeRunVideo(
  req: VideoRequest,
  kit: VideoKit,
  env: Env,
): Promise<VideoOutcome> {
  const pace = videoPaceFor("round-trip", env)
  const paced = { pace: pace.pace, slowFactor: pace.slowFactor }
  let narration: NarrationOutcome = pace.narration.on
    ? { produced: false, reason: "the video was not produced" }
    : { produced: false, reason: pace.narration.reason }
  const { cards } = kit
  try {
    const blocker = videoBlocker(req, env) ?? ffmpegProblem()
    if (blocker) {
      return { produced: false, reason: blocker, narration, pace: paced }
    }
    const t = req.flow!
    const log = t.log!
    const anchor = log.videoStartedAt!

    const videoDurationSec = await probeDuration(t.videoPath!)
    const steps: TimelineStep[] = t.steps.map((s) => ({
      id: s.id,
      startSec: (s.startMs - anchor) / 1000,
      // A step that never ended (durationMs < 0) runs to the recording's end.
      endSec:
        s.durationMs < 0
          ? videoDurationSec
          : (s.startMs + s.durationMs - anchor) / 1000,
      status: s.failed ? "failed" : "passed",
    }))
    const input: TimelineInput = {
      videoDurationSec,
      steps,
      mail: log.mail.map((m) => ({ atSec: (m.at - anchor) / 1000 })),
    }
    const options = timelineOptionsFor(pace)
    const plain = buildTimeline(input, options)

    // What is said (curated <module>.json lines, else the captions),
    // synthesized once; the sentences then stretch the timeline. Anything
    // that throws here costs the narration only, never the video.
    let texts: ReelTexts = { captions: [], mail: [] }
    let bookends: { intro: string | null; outro: string | null } = {
      intro: null,
      outro: null,
    }
    let narrated: NarratedReel | null = null
    if (pace.narration.on) {
      try {
        const lines = kit.lines(req.module)
        texts = reelTexts(plain, t.steps, log.mail, lines, kit.reelCopy)
        const vars = {
          COUNT: req.table.length,
          PASSED: req.table.filter((s) => s.status === "passed").length,
          FAILED: req.table.filter((s) => s.status === "failed").length,
        }
        bookends = {
          intro: kit.narration.roundTripCardLine(
            lines,
            "intro",
            vars,
            req.verdict,
          ),
          outro: kit.narration.roundTripCardLine(
            lines,
            "outro",
            vars,
            req.verdict,
          ),
        }
        const prepared = await kit.prepareNarration(
          pace.narration,
          [...texts.captions, ...texts.mail, bookends.intro, bookends.outro],
          env,
        )
        narration = prepared.outcome
        narrated = prepared.narrator
          ? narrateReel(plain, texts, prepared.narrator, bookends)
          : null
      } catch (error) {
        narrated = null
        narration = {
          produced: false,
          reason: firstLine(
            error instanceof Error ? error.message : String(error),
          ),
        }
      }
    }
    const timeline: Timeline = narrated?.timeline ?? plain

    const work = join(req.dir, "video")
    mkdirSync(work, { recursive: true })
    const logos = kit.brand.logos()
    const png = (name: string) => join(work, `${name}.png`)
    const jobs: PngJob[] = [
      {
        path: png("intro"),
        html: cards.introHtml({
          logos,
          target: req.target,
          runId: req.runId,
          startedAt: req.startedAt,
        }),
      },
      {
        path: png("outro"),
        html: cards.outroHtml({
          logos,
          verdict: req.verdict,
          reason: req.verdictReason,
          runId: req.runId,
          steps: req.table,
          latenciesMs: req.latenciesMs,
        }),
      },
      {
        path: png("frame"),
        html: cards.frameHtml(logos, req.runId, req.target),
        transparent: true,
      },
      ...log.mail.map((card, i) => ({
        path: png(`email-${i + 1}`),
        html: cards.emailHtml(logos, card),
      })),
      ...timeline.captions.map((c, i) => ({
        path: png(`caption-${i + 1}`),
        html: cards.captionHtml(steps[c.step].id, steps[c.step].status),
        transparent: true,
      })),
    ]
    const badgeJobs = (of: Timeline, prefix: string) => {
      const badges: Record<number, string> = {}
      const out: PngJob[] = []
      for (const badge of segmentBadges(of, kit.reelCopy)) {
        badges[badge.index] = png(`${prefix}-${badge.index}`)
        out.push({
          path: badges[badge.index],
          html: badge.html,
          transparent: true,
        })
      }
      return { badges, jobs: out }
    }
    const { badges: speedBadges, jobs: badgePngs } = badgeJobs(
      timeline,
      "speed",
    )
    await renderPngs([...jobs, ...badgePngs])
    // Where each segment starts in the MP4 (seconds), for finding a frame or
    // checking a cut by hand. Timings and step ids only, nothing secret.
    // Written after the compose, from the timeline the MP4 was cut from.
    const writeTimeline = (used: Timeline, cues: NarrationCue[]) => {
      let at = 0
      const placed = used.segments.map((segment) => {
        const startSec = Math.round(at * 1000) / 1000
        at += segment.durationSec
        return { startSec, ...segment }
      })
      const spoken = cues.map((cue) => ({
        ...cue,
        text:
          cue.kind === "caption"
            ? texts.captions[cue.index]
            : cue.kind === "mail"
              ? texts.mail[cue.index]
              : bookends[cue.kind],
      }))
      writeFileSync(
        join(work, "timeline.json"),
        `${JSON.stringify({ ...used, segments: placed, steps: steps.map(({ id, startSec, endSec, status }) => ({ id, startSec, endSec, status })), pace: paced, narration: spoken }, null, 2)}\n`,
      )
    }

    const output = join(req.dir, videoFileName(req.module, req.runId))
    const files = {
      appVideo: t.videoPath!,
      frame: png("frame"),
      captions: timeline.captions.map((_, i) => png(`caption-${i + 1}`)),
      emails: log.mail.map((_, i) => png(`email-${i + 1}`)),
    }
    const composeFiles = {
      ...files,
      speedBadges,
      intro: png("intro"),
      outro: png("outro"),
      output,
    }
    const audio: AudioTrack | null = narrated
      ? {
          clips: narrated.clips,
          durationSec: programSec([
            { kind: "reel", timeline, files: composeFiles },
          ]),
        }
      : null
    try {
      await compose(timeline, composeFiles, undefined, audio)
      writeTimeline(timeline, narrated?.cues ?? [])
    } catch (error) {
      if (!audio) throw error
      // Narration never costs the video: the silent cut, as without it.
      narration = {
        produced: false,
        reason: `the narrated video failed (${firstLine(error instanceof Error ? error.message : String(error))})`,
      }
      const silent = badgeJobs(plain, "speed-silent")
      await renderPngs(silent.jobs)
      await compose(plain, { ...composeFiles, speedBadges: silent.badges })
      writeTimeline(plain, [])
    }
    const inRun = (path: string) => relative(req.dir, path)
    const reel: ReelManifest = {
      input,
      appVideo: inRun(files.appVideo),
      frame: inRun(files.frame),
      captions: files.captions.map(inRun),
      emails: files.emails.map(inRun),
      ...(Object.keys(options).length > 0 ? { timeline: options } : {}),
      ...(narration.produced ? { narration: texts } : {}),
    }
    writeFileSync(
      join(req.dir, REEL_FILE),
      `${JSON.stringify(reel, null, 2)}\n`,
    )
    return {
      produced: true,
      path: output,
      durationSec: Math.round((await probeDuration(output)) * 10) / 10,
      narration,
      pace: paced,
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
