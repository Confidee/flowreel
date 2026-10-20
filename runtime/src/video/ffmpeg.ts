// SPDX-License-Identifier: Apache-2.0

import { execFile, execFileSync } from "node:child_process"
import { join } from "node:path"

import { APP_RECT, OUTPUT, OUTPUT_SCALE } from "./geometry.js"
import { mediaSignal, stoppedError } from "./stop.js"
import type { Timeline } from "./timeline.js"

// ffmpeg composer for the run video. One
// ffmpeg call executes a Timeline (timeline.ts): the page recording is
// scaled into the frame, the frame/watermark and per-step caption PNGs are
// overlaid on the SOURCE clock (`enable=between(t,a,b)`), the result is cut
// into the timeline's app segments (sped up where the timeline says), and
// those are concatenated with the looped card stills. Output: 1920x1080 H.264,
// yuv420p, +faststart; no audio, or (narration) one AAC
// 128k mono track mixed from the sentence clips (adelay + amix normalize=0 +
// apad, cut to the program's length; the clips are loudness-normalised once
// when synthesized, voice/voice.ts). Slowed pieces (demo pace) are stretched
// with setpts, and a narration hold freezes a piece's last frame (tpad
// stop_mode=clone). All text is in the PNGs, so ffmpeg needs no
// fonts. Arguments are passed as an array (no shell). A pipeline's combined
// video is the same graph with several recordings: a program of
// card stills and body-only reels, never a re-recording.

export const FPS = 25

/** What one recording needs: the page video and the overlays drawn on it. */
export interface ReelFiles {
  /** The page recording (.webm). */
  appVideo: string
  /** Transparent overlay: brand strips around the recording + watermark. */
  frame: string
  /** One PNG per timeline caption, same order. */
  captions: string[]
  /** Badge PNG per app segment index (timeline.segments) played faster. */
  speedBadges: Record<number, string>
  /** Needed only when the timeline has an intro / outro (bookends). */
  intro?: string
  outro?: string
  /** One PNG per recorded mail card (Segment.mail indexes it). */
  emails: string[]
  /** Tour: one transparent badge PNG per persona in timeline.personas. */
  personaBadges?: Record<string, string>
}

export interface ComposeFiles extends ReelFiles {
  intro: string
  outro: string
  output: string
}

/**
 * One piece of a program, played in order: a looped card still, or a
 * recording cut and carded by its timeline. A single run's video is one reel
 * (with bookends); a pipeline's is its own cards around each
 * stage's body-only reel.
 */
export type ProgramPart =
  | { kind: "still"; path: string; durationSec: number }
  | {
      kind: "reel"
      timeline: Pick<Timeline, "segments" | "captions"> &
        Partial<Pick<Timeline, "personas">>
      files: ReelFiles
    }

const n = (value: number) => String(Math.round(value * 1000) / 1000)

/** A narration track: sentence clips placed on the program's clock. */
export interface AudioTrack {
  clips: { path: string; atSec: number }[]
  /** The program's length (the track is padded / cut to it). */
  durationSec: number
}

export const AUDIO_RATE = 48_000

/** Pure: a program's length rounded up to whole frames, per part. */
export function programSec(parts: ProgramPart[]): number {
  const frames = (seconds: number) => Math.ceil(seconds * FPS - 1e-6) / FPS
  let total = 0
  for (const part of parts) {
    if (part.kind === "still") total += frames(part.durationSec)
    else {
      for (const segment of part.timeline.segments) {
        total += frames(segment.durationSec)
      }
    }
  }
  return Math.round(total * 1000) / 1000
}

/** Pure: the ffmpeg argument list for a timeline (unit-tested). */
export function composeArgs(
  timeline: Timeline,
  files: ComposeFiles,
  audio: AudioTrack | null = null,
): string[] {
  return programArgs([{ kind: "reel", timeline, files }], files.output, audio)
}

/** Pure: the ffmpeg argument list for a program of stills and reels. */
export function programArgs(
  parts: ProgramPart[],
  output: string,
  audio: AudioTrack | null = null,
): string[] {
  const inputs: string[] = []
  let count = 0
  const input = (...args: string[]) => {
    inputs.push(...args)
    return count++
  }
  const still = (path: string, seconds: number) =>
    input("-loop", "1", "-framerate", String(FPS), "-t", n(seconds), "-i", path)

  const filters: string[] = []
  const outputs: string[] = []
  const stillPart = (path: string, seconds: number) => {
    const out = `g${outputs.length}`
    outputs.push(`[${out}]`)
    const png = still(path, seconds)
    filters.push(
      `[${png}:v]scale=${OUTPUT.width}:${OUTPUT.height},setsar=1,fps=${FPS},format=yuv420p[${out}]`,
    )
  }

  parts.forEach((part, r) => {
    if (part.kind === "still") {
      stillPart(part.path, part.durationSec)
      return
    }
    const { timeline, files } = part
    // Labels are per reel, so several recordings can share one graph.
    const label = (name: string) => `r${r}${name}`
    const appSegments = timeline.segments
      .map((segment, index) => ({ segment, index }))
      .filter(({ segment }) => segment.kind === "app")

    // The recording, framed and captioned once on its own clock.
    const appLabels = new Map<number, string>()
    if (appSegments.length > 0) {
      const app = input("-i", files.appVideo)
      const frame = input("-i", files.frame)
      // APP_RECT is in card layout pixels; the composition is in OUTPUT pixels.
      const [x, y, width, height] = [
        APP_RECT.x,
        APP_RECT.y,
        APP_RECT.width,
        APP_RECT.height,
      ].map((v) => v * OUTPUT_SCALE)
      filters.push(
        `[${app}:v]setpts=PTS-STARTPTS,fps=${FPS},` +
          `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
          `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=white,` +
          `pad=${OUTPUT.width}:${OUTPUT.height}:${x}:${y}:color=white,setsar=1[${label("v0")}]`,
        `[${label("v0")}][${frame}:v]overlay=0:0[${label("v1")}]`,
      )
      let last = label("v1")
      timeline.captions.forEach((caption, k) => {
        const png = input("-i", files.captions[k])
        const next = label(`c${k}`)
        filters.push(
          `[${last}][${png}:v]overlay=0:0:enable='between(t,${n(caption.fromSec)},${n(caption.toSec)})'[${next}]`,
        )
        last = next
      })
      // Tour reels: "as <persona>" in the brand strip, on the same clock.
      ;(timeline.personas ?? []).forEach((window, k) => {
        const badge = files.personaBadges?.[window.persona]
        if (!badge) return
        const png = input("-i", badge)
        const next = label(`b${k}`)
        filters.push(
          `[${last}][${png}:v]overlay=0:0:enable='between(t,${n(window.fromSec)},${n(window.toSec)})'[${next}]`,
        )
        last = next
      })
      if (appSegments.length === 1) {
        appLabels.set(appSegments[0].index, last)
      } else {
        const labels = appSegments.map(({ index }) => label(`p${index}`))
        filters.push(
          `[${last}]split=${appSegments.length}${labels.map((l) => `[${l}]`).join("")}`,
        )
        appSegments.forEach(({ index }, k) => appLabels.set(index, labels[k]))
      }
    }

    timeline.segments.forEach((segment, index) => {
      if (segment.kind !== "app") {
        const path =
          segment.kind === "intro"
            ? files.intro
            : segment.kind === "outro"
              ? files.outro
              : files.emails[segment.mail]
        if (!path) throw new Error(`no ${segment.kind} card for the timeline`)
        stillPart(path, segment.durationSec)
        return
      }
      const out = `g${outputs.length}`
      outputs.push(`[${out}]`)
      // Faster (qa fast-forward) divides; slower (demo pace) multiplies by
      // the exact stretch, so the piece lasts what the timeline says.
      const pts =
        segment.speed > 1
          ? `(PTS-STARTPTS)/${n(segment.speed)}`
          : segment.speed < 1
            ? `(PTS-STARTPTS)*${(1 / segment.speed).toFixed(6)}`
            : "PTS-STARTPTS"
      const hold =
        segment.holdSec && segment.holdSec > 0
          ? `,tpad=stop_mode=clone:stop_duration=${n(segment.holdSec)}`
          : ""
      const cut = `[${appLabels.get(index)}]trim=start=${n(segment.fromSec)}:end=${n(segment.toSec)},setpts=${pts},fps=${FPS}${hold}`
      const badge = files.speedBadges[index]
      if (badge) {
        const png = input("-i", badge)
        const sped = label(`t${index}`)
        filters.push(
          `${cut}[${sped}]`,
          `[${sped}][${png}:v]overlay=0:0,format=yuv420p[${out}]`,
        )
      } else {
        filters.push(`${cut},format=yuv420p[${out}]`)
      }
    })
  })

  filters.push(`${outputs.join("")}concat=n=${outputs.length}:v=1:a=0[out]`)

  const audioMap: string[] = []
  if (audio) {
    const end = n(audio.durationSec)
    const clips = audio.clips.filter((c) => c.atSec < audio.durationSec)
    if (clips.length === 0) {
      filters.push(`anullsrc=r=${AUDIO_RATE}:cl=mono,atrim=end=${end}[aout]`)
    } else {
      const labels = clips.map((clip, k) => {
        const index = input("-i", clip.path)
        const delay = Math.max(0, Math.round(clip.atSec * 1000))
        filters.push(
          `[${index}:a]aformat=sample_rates=${AUDIO_RATE}:channel_layouts=mono,adelay=delays=${delay}:all=1[a${k}]`,
        )
        return `[a${k}]`
      })
      filters.push(
        `${labels.join("")}${
          labels.length > 1
            ? `amix=inputs=${labels.length}:normalize=0:dropout_transition=0,`
            : ""
        }apad,atrim=end=${end}[aout]`,
      )
    }
    audioMap.push("-map", "[aout]", "-c:a", "aac", "-b:a", "128k", "-ac", "1")
  }

  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    ...inputs,
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[out]",
    ...(audio ? audioMap : ["-an"]),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "22",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(FPS),
    "-movflags",
    "+faststart",
    output,
  ]
}

/** Null when ffmpeg/ffprobe with libx264 are usable, else the reason. */
export function ffmpegProblem(): string | null {
  for (const tool of ["ffmpeg", "ffprobe"]) {
    try {
      execFileSync(tool, ["-hide_banner", "-version"], { stdio: "ignore" })
    } catch {
      return `${tool} not found on PATH (install it, e.g. brew install ffmpeg)`
    }
  }
  try {
    const encoders = execFileSync("ffmpeg", ["-hide_banner", "-encoders"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    if (!/\blibx264\b/.test(encoders)) return "ffmpeg has no libx264 encoder"
  } catch {
    return "ffmpeg -encoders failed"
  }
  return null
}

// A stopped composition (mediaSignal) ends the tool and rejects with
// "<tool> stopped".
function run(tool: string, args: string[], timeoutMs: number): Promise<string> {
  const signal = mediaSignal()
  if (signal?.aborted) return Promise.reject(new Error(`${tool} stopped`))
  return new Promise((resolvePromise, reject) => {
    execFile(
      tool,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
        signal,
      },
      (error, stdout, stderr) => {
        if (stoppedError(error)) {
          reject(new Error(`${tool} stopped`))
        } else if (error) {
          const detail = stderr.trim().split("\n").slice(-3).join(" | ")
          reject(new Error(`${tool} failed: ${detail || error.message}`))
        } else {
          resolvePromise(stdout)
        }
      },
    )
  })
}

/** Container duration in seconds (falls back to frames / frame rate). */
export async function probeDuration(path: string): Promise<number> {
  const out = await run(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      path,
    ],
    60_000,
  )
  const seconds = Number.parseFloat(out.trim())
  if (Number.isFinite(seconds) && seconds > 0) return seconds
  const counted = await run(
    "ffprobe",
    [
      "-v",
      "error",
      "-count_packets",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=nb_read_packets,r_frame_rate",
      "-of",
      "default=noprint_wrappers=1",
      path,
    ],
    120_000,
  )
  const frames = Number(/nb_read_packets=(\d+)/.exec(counted)?.[1])
  const [num, den] = (/r_frame_rate=(\d+)\/(\d+)/.exec(counted) ?? [])
    .slice(1)
    .map(Number)
  if (frames > 0 && num > 0 && den > 0) return (frames * den) / num
  throw new Error(`could not read the duration of ${path}`)
}

export async function compose(
  timeline: Timeline,
  files: ComposeFiles,
  timeoutMs = 10 * 60_000,
  audio: AudioTrack | null = null,
): Promise<void> {
  await run("ffmpeg", composeArgs(timeline, files, audio), timeoutMs)
}

export async function composeProgram(
  parts: ProgramPart[],
  output: string,
  timeoutMs = 15 * 60_000,
  audio: AudioTrack | null = null,
): Promise<void> {
  await run("ffmpeg", programArgs(parts, output, audio), timeoutMs)
}

/** Whether a media file has an audio stream. */
export async function hasAudio(path: string): Promise<boolean> {
  const out = await run(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "a",
      "-show_entries",
      "stream=index",
      "-of",
      "csv=p=0",
      path,
    ],
    60_000,
  )
  return out.trim() !== ""
}

/** Pure: the same MP4 with a silent mono track added (video copied). */
export function addSilenceArgs(input: string, output: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    input,
    "-f",
    "lavfi",
    "-i",
    `anullsrc=r=${AUDIO_RATE}:cl=mono`,
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ac",
    "1",
    "-shortest",
    "-movflags",
    "+faststart",
    output,
  ]
}

// Tour videos are built from MANY short segments (a card still
// or one feature's reel, each its own MP4 encoded with the same arguments
// above), so an area, the full tour and a pipeline's combined tour are
// concatenations of files that already exist: the concat demuxer joins them
// without re-encoding. Should the streams ever disagree, it falls back to one
// re-encode with the same output settings.

/** Pure: a concat-demuxer list file's contents (paths single-quoted). */
export function concatList(paths: string[]): string {
  return `${paths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n")}\n`
}

/** Pure: the ffmpeg arguments joining a list file's segments. */
export function concatArgs(
  listFile: string,
  output: string,
  reencode = false,
  audio = false,
): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFile,
    ...(audio ? [] : ["-an"]),
    ...(reencode
      ? [
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "22",
          "-pix_fmt",
          "yuv420p",
          "-r",
          String(FPS),
          ...(audio ? ["-c:a", "aac", "-b:a", "128k", "-ac", "1"] : []),
        ]
      : ["-c", "copy"]),
    "-movflags",
    "+faststart",
    output,
  ]
}

/**
 * Joins segment MP4s. With `audio` the joined file keeps a sound track: a
 * segment without one (a silent stage, an older run) is first copied with a
 * silent track into `scratchDir`, because the concat demuxer needs every
 * file to have the same streams.
 */
export async function concatSegments(
  paths: string[],
  output: string,
  listFile: string,
  writeList: (path: string, content: string) => void,
  timeoutMs = 15 * 60_000,
  audio: { scratchDir: string } | null = null,
): Promise<void> {
  if (paths.length === 0) throw new Error("nothing to concatenate")
  let files = paths
  if (audio) {
    const silent = new Map<string, string>()
    files = []
    for (const path of paths) {
      if (await hasAudio(path)) {
        files.push(path)
        continue
      }
      let copy = silent.get(path)
      if (!copy) {
        copy = join(audio.scratchDir, `with-silence-${silent.size + 1}.mp4`)
        await run("ffmpeg", addSilenceArgs(path, copy), timeoutMs)
        silent.set(path, copy)
      }
      files.push(copy)
    }
  }
  writeList(listFile, concatList(files))
  try {
    await run("ffmpeg", concatArgs(listFile, output, false, !!audio), timeoutMs)
  } catch {
    await run("ffmpeg", concatArgs(listFile, output, true, !!audio), timeoutMs)
  }
}
