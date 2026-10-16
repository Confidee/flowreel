// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "@playwright/test"

import {
  type ComposeFiles,
  type ProgramPart,
  type ReelFiles,
  addSilenceArgs,
  compose,
  composeArgs,
  composeProgram,
  concatArgs,
  concatList,
  concatSegments,
  ffmpegProblem,
  hasAudio,
  probeDuration,
  programArgs,
  programSec,
} from "../src/video/ffmpeg.js"
import type { Segment, Timeline } from "../src/video/timeline.js"

import { FakeMediaTools, HEALTHY } from "./fake-media-tools.js"

const timeline = (
  segments: Segment[],
  extra: Partial<Timeline> = {},
): Timeline => ({
  segments,
  captions: [],
  personas: [],
  durationSec: 0,
  app: { fromSec: 0, toSec: 0 },
  ...extra,
})

const app = (
  fromSec: number,
  toSec: number,
  speed = 1,
  extra: Partial<Extract<Segment, { kind: "app" }>> = {},
): Segment => ({
  kind: "app",
  fromSec,
  toSec,
  speed,
  durationSec: (toSec - fromSec) / speed,
  ...extra,
})

const reelFiles: ReelFiles = {
  appVideo: "/w/page.webm",
  frame: "/w/frame.png",
  captions: ["/w/c1.png", "/w/c2.png"],
  speedBadges: {},
  emails: ["/w/e1.png"],
}

const filterOf = (args: string[]) => args[args.indexOf("-filter_complex") + 1]

test.describe("programSec", () => {
  test("rounds each part up to whole frames and sums", () => {
    const parts: ProgramPart[] = [
      { kind: "still", path: "/a.png", durationSec: 1.01 },
      {
        kind: "reel",
        timeline: timeline([app(0, 1), { kind: "outro", durationSec: 0.5 }]),
        files: reelFiles,
      },
    ]
    // 1.01 s -> 26 frames (1.04 s); app 1 s -> 1 s; outro 0.5 s -> 13 frames.
    expect(programSec(parts)).toBe(2.56)
    expect(programSec([])).toBe(0)
  })
})

test.describe("programArgs", () => {
  test("a still-only program loops each card and concatenates", () => {
    const args = programArgs(
      [
        { kind: "still", path: "/a.png", durationSec: 2 },
        { kind: "still", path: "/b.png", durationSec: 1.2345 },
      ],
      "/out.mp4",
    )
    expect(args.slice(0, 4)).toEqual([
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
    ])
    expect(args.join(" ")).toContain(
      "-loop 1 -framerate 25 -t 2 -i /a.png -loop 1 -framerate 25 -t 1.235 -i /b.png",
    )
    expect(filterOf(args)).toBe(
      [
        "[0:v]scale=1920:1080,setsar=1,fps=25,format=yuv420p[g0]",
        "[1:v]scale=1920:1080,setsar=1,fps=25,format=yuv420p[g1]",
        "[g0][g1]concat=n=2:v=1:a=0[out]",
      ].join(";"),
    )
    expect(args).toContain("-an")
    expect(args).not.toContain("aac")
    expect(args.at(-1)).toBe("/out.mp4")
    expect(args.slice(-13)).toEqual([
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "22",
      "-pix_fmt",
      "yuv420p",
      "-r",
      "25",
      "-movflags",
      "+faststart",
      "/out.mp4",
    ])
  })

  test("a reel: framed recording, captions, personas, cards, pace and hold", () => {
    const args = programArgs(
      [
        {
          kind: "reel",
          timeline: timeline(
            [
              { kind: "intro", durationSec: 3 },
              app(0, 10, 5),
              { kind: "email", mail: 0, durationSec: 4 },
              app(10, 14, 0.5),
              app(14, 20, 1, { holdSec: 1.5, durationSec: 7.5 }),
              { kind: "outro", durationSec: 5 },
            ],
            {
              captions: [
                { step: 0, fromSec: 0, toSec: 6 },
                { step: 1, fromSec: 6, toSec: 20 },
              ],
              personas: [
                { persona: "admin", fromSec: 0, toSec: 8 },
                { persona: "ghost", fromSec: 8, toSec: 12 },
                { persona: "guest", fromSec: 12, toSec: 20 },
              ],
            },
          ),
          files: {
            ...reelFiles,
            intro: "/w/intro.png",
            outro: "/w/outro.png",
            speedBadges: { 1: "/w/speed-1.png" },
            personaBadges: { admin: "/w/admin.png", guest: "/w/guest.png" },
          },
        },
      ],
      "/out.mp4",
    )
    const joined = args.join(" ")
    // Inputs in order: intro still, recording, frame, 2 captions, 2 persona
    // badges (ghost has no badge: skipped), email still, speed badge, outro.
    expect(joined).toContain("-i /w/intro.png")
    expect(joined).toContain(
      "-i /w/page.webm -i /w/frame.png -i /w/c1.png -i /w/c2.png -i /w/admin.png -i /w/guest.png",
    )
    expect(joined).not.toContain("ghost")
    const filter = filterOf(args)
    // APP_RECT (80,36,1120,630) at 1.5x.
    expect(filter).toContain(
      "scale=1680:945:force_original_aspect_ratio=decrease,pad=1680:945:(ow-iw)/2:(oh-ih)/2:color=white,pad=1920:1080:120:54:color=white,setsar=1[r0v0]",
    )
    expect(filter).toContain("[r0v0][1:v]overlay=0:0[r0v1]")
    expect(filter).toContain(
      "[r0v1][2:v]overlay=0:0:enable='between(t,0,6)'[r0c0]",
    )
    expect(filter).toContain(
      "[r0c1][4:v]overlay=0:0:enable='between(t,0,8)'[r0b0]",
    )
    expect(filter).toContain(
      "[r0b0][5:v]overlay=0:0:enable='between(t,12,20)'[r0b2]",
    )
    // Three app pieces share the recording through a split.
    expect(filter).toContain("[r0b2]split=3[r0p1][r0p3][r0p4]")
    // Faster divides, slower multiplies by the exact stretch, hold clones.
    expect(filter).toContain(
      "[r0p1]trim=start=0:end=10,setpts=(PTS-STARTPTS)/5,fps=25",
    )
    expect(filter).toContain(
      "[r0p3]trim=start=10:end=14,setpts=(PTS-STARTPTS)*2.000000,fps=25,format=yuv420p[g3]",
    )
    expect(filter).toContain(
      "[r0p4]trim=start=14:end=20,setpts=PTS-STARTPTS,fps=25,tpad=stop_mode=clone:stop_duration=1.5,format=yuv420p[g4]",
    )
    // The sped-up piece gets its badge overlaid.
    expect(filter).toMatch(/\[r0t1\]\[\d+:v\]overlay=0:0,format=yuv420p\[g1\]/)
    expect(filter).toContain("concat=n=6:v=1:a=0[out]")
    expect(joined).toContain("-i /w/e1.png")
    expect(joined).toContain("-i /w/outro.png")
  })

  test("persona windows without badge files, or without personas, add no overlay", () => {
    const withWindows = programArgs(
      [
        {
          kind: "reel",
          timeline: timeline([app(0, 4)], {
            personas: [{ persona: "admin", fromSec: 0, toSec: 4 }],
          }),
          files: reelFiles,
        },
      ],
      "/o.mp4",
    )
    // A Pick-typed timeline without a personas field at all is fine too.
    const without = programArgs(
      [
        {
          kind: "reel",
          timeline: { segments: [app(0, 4)], captions: [] },
          files: reelFiles,
        },
      ],
      "/o.mp4",
    )
    expect(filterOf(withWindows)).toBe(filterOf(without))
    expect(filterOf(without)).not.toContain("enable=")
  })

  test("a single app piece needs no split", () => {
    const args = programArgs(
      [
        {
          kind: "reel",
          timeline: timeline([app(2, 8)], {
            captions: [{ step: 0, fromSec: 2, toSec: 8 }],
          }),
          files: reelFiles,
        },
      ],
      "/o.mp4",
    )
    const filter = filterOf(args)
    expect(filter).not.toContain("split=")
    expect(filter).toContain(
      "[r0c0]trim=start=2:end=8,setpts=PTS-STARTPTS,fps=25,format=yuv420p[g0]",
    )
  })

  test("several reels keep their labels apart in one graph", () => {
    const part = (): ProgramPart => ({
      kind: "reel",
      timeline: timeline([app(0, 4)]),
      files: { ...reelFiles, captions: [] },
    })
    const filter = filterOf(programArgs([part(), part()], "/o.mp4"))
    expect(filter).toContain("[r0v0]")
    expect(filter).toContain("[r1v0]")
    expect(filter).toContain("[g0][g1]concat=n=2:v=1:a=0[out]")
  })

  test("a card the timeline needs but the files lack is an error", () => {
    const reel = (
      files: Partial<ReelFiles>,
      segment: Segment,
    ): ProgramPart => ({
      kind: "reel",
      timeline: timeline([segment]),
      files: { ...reelFiles, ...files },
    })
    expect(() =>
      programArgs([reel({}, { kind: "intro", durationSec: 3 })], "/o.mp4"),
    ).toThrow("no intro card for the timeline")
    expect(() =>
      programArgs([reel({}, { kind: "outro", durationSec: 3 })], "/o.mp4"),
    ).toThrow("no outro card for the timeline")
    expect(() =>
      programArgs(
        [reel({}, { kind: "email", mail: 5, durationSec: 3 })],
        "/o.mp4",
      ),
    ).toThrow("no email card for the timeline")
  })

  test("narration: clips delayed on the program clock and mixed", () => {
    const parts: ProgramPart[] = [
      { kind: "still", path: "/a.png", durationSec: 5 },
    ]
    const args = programArgs(parts, "/o.mp4", {
      durationSec: 5,
      clips: [
        { path: "/v/1.wav", atSec: 0.3456 },
        { path: "/v/2.wav", atSec: 2 },
        { path: "/v/late.wav", atSec: 5 },
      ],
    })
    const filter = filterOf(args)
    expect(filter).toContain(
      "[1:a]aformat=sample_rates=48000:channel_layouts=mono,adelay=delays=346:all=1[a0]",
    )
    expect(filter).toContain("adelay=delays=2000:all=1[a1]")
    expect(filter).toContain(
      "[a0][a1]amix=inputs=2:normalize=0:dropout_transition=0,apad,atrim=end=5[aout]",
    )
    // A clip at or past the end is dropped.
    expect(args.join(" ")).not.toContain("late.wav")
    expect(args.join(" ")).toContain(
      "-map [aout] -c:a aac -b:a 128k -ac 1 -c:v libx264",
    )
    expect(args).not.toContain("-an")
  })

  test("narration: one clip needs no mix; none gives silence of the length", () => {
    const one = filterOf(
      programArgs([{ kind: "still", path: "/a.png", durationSec: 2 }], "/o", {
        durationSec: 2,
        clips: [{ path: "/v/1.wav", atSec: -3 }],
      }),
    )
    expect(one).toContain("adelay=delays=0:all=1[a0]")
    expect(one).toContain("[a0]apad,atrim=end=2[aout]")
    expect(one).not.toContain("amix")
    const none = filterOf(
      programArgs([{ kind: "still", path: "/a.png", durationSec: 2 }], "/o", {
        durationSec: 2,
        clips: [],
      }),
    )
    expect(none).toContain("anullsrc=r=48000:cl=mono,atrim=end=2[aout]")
  })
})

test.describe("composeArgs", () => {
  test("is a one-reel program on the files' output", () => {
    const files: ComposeFiles = {
      ...reelFiles,
      intro: "/w/intro.png",
      outro: "/w/outro.png",
      output: "/w/run.mp4",
    }
    const tl = timeline([
      { kind: "intro", durationSec: 3 },
      app(0, 5),
      { kind: "outro", durationSec: 5 },
    ])
    const args = composeArgs(tl, files)
    expect(args).toEqual(
      programArgs([{ kind: "reel", timeline: tl, files }], "/w/run.mp4"),
    )
    expect(args.at(-1)).toBe("/w/run.mp4")
  })
})

test.describe("concat and silence arguments", () => {
  test("list: single-quoted, quotes escaped, newline terminated", () => {
    expect(concatList(["/a.mp4", "/it's.mp4"])).toBe(
      "file '/a.mp4'\nfile '/it'\\''s.mp4'\n",
    )
  })

  test("copy join, silent", () => {
    expect(concatArgs("/l.txt", "/o.mp4")).toEqual([
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      "/l.txt",
      "-an",
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      "/o.mp4",
    ])
  })

  test("copy join keeps audio: no -an", () => {
    const args = concatArgs("/l.txt", "/o.mp4", false, true)
    expect(args).not.toContain("-an")
    expect(args).toContain("copy")
  })

  test("re-encode, with and without audio", () => {
    const silent = concatArgs("/l.txt", "/o.mp4", true)
    expect(silent).toContain("-an")
    expect(silent.join(" ")).toContain(
      "-c:v libx264 -preset veryfast -crf 22 -pix_fmt yuv420p -r 25 -movflags",
    )
    expect(silent).not.toContain("aac")
    const sound = concatArgs("/l.txt", "/o.mp4", true, true)
    expect(sound).not.toContain("-an")
    expect(sound.join(" ")).toContain("-r 25 -c:a aac -b:a 128k -ac 1")
  })

  test("silence: video copied, silent mono track, shortest", () => {
    const args = addSilenceArgs("/in.mp4", "/out.mp4")
    expect(args.join(" ")).toContain(
      "-i /in.mp4 -f lavfi -i anullsrc=r=48000:cl=mono -map 0:v -map 1:a -c:v copy -c:a aac -b:a 128k -ac 1 -shortest -movflags +faststart /out.mp4",
    )
  })
})

// ---------------------------------------------------------------------------
// The functions that start ffmpeg / ffprobe, against fake tools on PATH.
// ---------------------------------------------------------------------------

test.describe("with fake ffmpeg and ffprobe", () => {
  test.describe.configure({ mode: "serial" })
  let tools: FakeMediaTools
  let work: string
  test.beforeAll(() => {
    tools = new FakeMediaTools()
    tools.install()
    work = mkdtempSync(join(tmpdir(), "flowreel-ffmpeg-"))
  })
  test.afterAll(() => {
    tools.uninstall()
    rmSync(work, { recursive: true, force: true })
  })

  test("ffmpegProblem: healthy install", () => {
    tools.rules(HEALTHY)
    expect(ffmpegProblem()).toBeNull()
  })

  test("ffmpegProblem: a missing tool is named", () => {
    tools.rules([{ tool: "ffmpeg", code: 1 }])
    expect(ffmpegProblem()).toBe(
      "ffmpeg not found on PATH (install it, e.g. brew install ffmpeg)",
    )
    tools.rules([{ tool: "ffprobe", code: 1 }])
    expect(ffmpegProblem()).toBe(
      "ffprobe not found on PATH (install it, e.g. brew install ffmpeg)",
    )
  })

  test("ffmpegProblem: no libx264, or the encoder list fails", () => {
    tools.rules([
      { tool: "ffmpeg", match: "-encoders", stdout: " V....D mpeg4\n" },
    ])
    expect(ffmpegProblem()).toBe("ffmpeg has no libx264 encoder")
    tools.rules([{ tool: "ffmpeg", match: "-encoders", code: 2 }])
    expect(ffmpegProblem()).toBe("ffmpeg -encoders failed")
  })

  test("probeDuration reads the container duration", async () => {
    tools.rules([{ tool: "ffprobe", stdout: "12.5\n" }])
    await expect(probeDuration("/v.webm")).resolves.toBe(12.5)
    expect(tools.calls()).toEqual([
      {
        tool: "ffprobe",
        args: [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "default=noprint_wrappers=1:nokey=1",
          "/v.webm",
        ],
      },
    ])
  })

  test("probeDuration falls back to frames / frame rate", async () => {
    tools.rules([
      {
        tool: "ffprobe",
        match: "-count_packets",
        stdout: "r_frame_rate=25/1\nnb_read_packets=100\n",
      },
      { tool: "ffprobe", stdout: "N/A\n" },
    ])
    await expect(probeDuration("/v.webm")).resolves.toBe(4)
    expect(tools.calls()).toHaveLength(2)
  })

  test("probeDuration: unreadable everywhere is an error", async () => {
    tools.rules([{ tool: "ffprobe", stdout: "0\n" }])
    await expect(probeDuration("/v.webm")).rejects.toThrow(
      "could not read the duration of /v.webm",
    )
    // A rate of zero cannot give a duration either.
    tools.rules([
      {
        tool: "ffprobe",
        match: "-count_packets",
        stdout: "r_frame_rate=0/0\nnb_read_packets=10\n",
      },
      { tool: "ffprobe", stdout: "" },
    ])
    await expect(probeDuration("/v.webm")).rejects.toThrow(
      "could not read the duration",
    )
  })

  test("a failing tool reports its last stderr lines", async () => {
    tools.rules([{ tool: "ffprobe", code: 1, stderr: "a\nb\nc\nd\n" }])
    await expect(probeDuration("/v.webm")).rejects.toThrow(
      "ffprobe failed: b | c | d",
    )
    // No stderr: the process error's message.
    tools.rules([{ tool: "ffprobe", code: 1 }])
    await expect(probeDuration("/v.webm")).rejects.toThrow(
      /^ffprobe failed: Command failed/,
    )
  })

  test("hasAudio: a stream index means yes, nothing means no", async () => {
    tools.rules([{ tool: "ffprobe", stdout: "1\n" }])
    await expect(hasAudio("/a.mp4")).resolves.toBe(true)
    expect(tools.calls()[0].args).toEqual([
      "-v",
      "error",
      "-select_streams",
      "a",
      "-show_entries",
      "stream=index",
      "-of",
      "csv=p=0",
      "/a.mp4",
    ])
    tools.rules([{ tool: "ffprobe", stdout: "\n" }])
    await expect(hasAudio("/b.mp4")).resolves.toBe(false)
  })

  test("compose and composeProgram run ffmpeg with their arguments", async () => {
    const tl = timeline([{ kind: "intro", durationSec: 3 }])
    const files: ComposeFiles = {
      ...reelFiles,
      intro: "/w/intro.png",
      outro: "/w/outro.png",
      output: "/w/run.mp4",
    }
    tools.rules([])
    await compose(tl, files)
    await composeProgram(
      [{ kind: "still", path: "/a.png", durationSec: 1 }],
      "/w/p.mp4",
    )
    const calls = tools.calls()
    expect(calls.map((c) => c.tool)).toEqual(["ffmpeg", "ffmpeg"])
    expect(calls[0].args).toEqual(composeArgs(tl, files))
    expect(calls[1].args.at(-1)).toBe("/w/p.mp4")
    // A failure surfaces as an error.
    tools.rules([{ tool: "ffmpeg", code: 1, stderr: "boom" }])
    await expect(compose(tl, files)).rejects.toThrow("ffmpeg failed: boom")
    await expect(composeProgram([], "/x.mp4")).rejects.toThrow(
      "ffmpeg failed: boom",
    )
  })

  test("concatSegments: nothing to join is an error", async () => {
    await expect(
      concatSegments([], "/o.mp4", "/l.txt", () => {}),
    ).rejects.toThrow("nothing to concatenate")
  })

  test("concatSegments: copies the list's files without re-encoding", async () => {
    tools.rules([])
    const written: Record<string, string> = {}
    await concatSegments(["/a.mp4", "/b.mp4"], "/o.mp4", "/l.txt", (p, c) => {
      written[p] = c
    })
    expect(written).toEqual({ "/l.txt": "file '/a.mp4'\nfile '/b.mp4'\n" })
    expect(tools.calls()).toEqual([
      { tool: "ffmpeg", args: concatArgs("/l.txt", "/o.mp4") },
    ])
  })

  test("concatSegments: re-encodes once when the copy join fails", async () => {
    tools.rules([
      { tool: "ffmpeg", match: "-c copy", code: 1, stderr: "mismatch" },
    ])
    await concatSegments(["/a.mp4"], "/o.mp4", "/l.txt", () => {})
    expect(tools.calls().map((c) => c.args)).toEqual([
      concatArgs("/l.txt", "/o.mp4", false, false),
      concatArgs("/l.txt", "/o.mp4", true, false),
    ])
    // Both failing is the second error.
    tools.rules([{ tool: "ffmpeg", code: 1, stderr: "dead" }])
    await expect(
      concatSegments(["/a.mp4"], "/o.mp4", "/l.txt", () => {}),
    ).rejects.toThrow("ffmpeg failed: dead")
  })

  test("concatSegments with audio: silent segments get a silent track once", async () => {
    // a.mp4 has sound ("0"); b.mp4 does not and appears twice.
    tools.rules([
      { tool: "ffprobe", match: "/a.mp4", stdout: "1\n" },
      { tool: "ffprobe", stdout: "" },
    ])
    const written: Record<string, string> = {}
    await concatSegments(
      ["/a.mp4", "/b.mp4", "/b.mp4"],
      "/o.mp4",
      "/l.txt",
      (p, c) => {
        written[p] = c
      },
      undefined,
      { scratchDir: work },
    )
    const silenced = join(work, "with-silence-1.mp4")
    expect(written["/l.txt"]).toBe(
      `file '/a.mp4'\nfile '${silenced}'\nfile '${silenced}'\n`,
    )
    const ffmpegCalls = tools.calls().filter((c) => c.tool === "ffmpeg")
    expect(ffmpegCalls.map((c) => c.args)).toEqual([
      addSilenceArgs("/b.mp4", silenced),
      concatArgs("/l.txt", "/o.mp4", false, true),
    ])
  })

  test("the list writer receives what the demuxer reads", async () => {
    tools.rules([])
    const list = join(work, "list.txt")
    await concatSegments(["/x.mp4"], "/o.mp4", list, writeFileSync)
    expect(readFileSync(list, "utf8")).toBe("file '/x.mp4'\n")
  })
})
