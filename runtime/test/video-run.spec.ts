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
import { join } from "node:path"

import { expect, test } from "@playwright/test"

import { type VideoKit, createVideoKit } from "../src/video/kit.js"
import { mailCard } from "../src/video/recorder.js"
import {
  REEL_FILE,
  type ReelManifest,
  type VideoRequest,
  produceVideo,
  readReel,
} from "../src/video/run-video.js"
import type { VoiceEngine } from "../src/voice/voice.js"

import { installFakeBrowser } from "./fake-browser.js"
import { FakeMediaTools, HEALTHY } from "./fake-media-tools.js"

// produceVideo end to end with a fake browser and fake ffmpeg / ffprobe:
// what it renders, what it asks ffmpeg for, and what it writes.

const cleanup: string[] = []
const tmp = (prefix = "flowreel-run-") => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanup.push(dir)
  return dir
}
test.afterAll(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

const readJson = (path: string) =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>

test.describe("produceVideo", () => {
  test.describe.configure({ mode: "serial" })
  let tools: FakeMediaTools
  let browser: ReturnType<typeof installFakeBrowser>
  test.beforeAll(() => {
    tools = new FakeMediaTools()
    tools.install()
  })
  test.afterAll(() => {
    tools.uninstall()
  })
  test.beforeEach(() => {
    browser = installFakeBrowser()
    tools.rules([
      ...HEALTHY,
      { tool: "ffprobe", match: ".webm", stdout: "100\n" },
      { tool: "ffprobe", match: ".mp4", stdout: "42.26\n" },
    ])
  })
  test.afterEach(() => {
    browser.restore()
  })

  const makeRequest = (dir: string): VideoRequest => ({
    module: "orbit",
    runId: "loc-1",
    target: "local",
    dir,
    startedAt: new Date(0),
    verdict: "FAIL",
    verdictReason: "R2 failed.",
    flow: {
      status: "failed",
      videoPath: join(dir, "page.webm"),
      log: {
        videoStartedAt: 1_000,
        mail: [
          {
            ...mailCard("R1 inbound", "received", {
              from: "a@example.test",
              to: "b@example.test",
              subject: "Hello",
              text: "Body text",
            }),
            at: 12_000,
          },
        ],
      },
      steps: [
        // 2 s .. 6 s
        { id: "R1 inbound", startMs: 3_000, durationMs: 4_000, failed: false },
        // starts at 40 s and never ended: runs to the end of the recording
        {
          id: "R2 reply",
          startMs: 41_000,
          durationMs: -1,
          failed: true,
          error: "Timeout 5000ms exceeded",
        },
      ],
    },
    table: [
      { id: "R1 inbound", status: "passed", durationMs: 4_000 },
      { id: "R2 reply", status: "failed", durationMs: null },
      { id: "R3 close", status: "skipped", durationMs: null },
    ] as VideoRequest["table"],
    latenciesMs: {},
  })

  const narratingKit = (
    engine: Partial<VoiceEngine> = {},
    seconds = 6,
  ): { kit: VideoKit; spoken: string[] } => {
    const spoken: string[] = []
    const kit = createVideoKit({
      voice: {
        cacheDir: tmp("flowreel-voice-"),
        log: () => {},
        engine: () => ({
          name: "fake",
          voice: "Fake",
          warning: null,
          cacheParts: () => ["fake"],
          available: () => Promise.resolve(null),
          synthesize: (text, out) => {
            spoken.push(text)
            writeFileSync(out, "")
            return Promise.resolve(seconds)
          },
          ...engine,
        }),
      },
    })
    return { kit, spoken }
  }

  test("the silent round-trip video: PNGs, one ffmpeg compose, timeline + reel files", async () => {
    const dir = tmp()
    const req = makeRequest(dir)
    const outcome = await produceVideo(req, createVideoKit(), {})
    const output = join(dir, "orbit-loc-1.mp4")
    expect(outcome).toEqual({
      produced: true,
      path: output,
      durationSec: 42.3,
      narration: {
        produced: false,
        reason:
          "off unless FLOWREEL_NARRATION=on (the macOS voices are licensed for personal, non-commercial use only)",
      },
      pace: { pace: "qa", slowFactor: 1 },
    })

    // Every card and overlay is rendered, by name, in one browser session.
    const work = join(dir, "video")
    const names = browser.log.shots.map((s) => s.path.slice(work.length + 1))
    expect(names).toEqual([
      "intro.png",
      "outro.png",
      "frame.png",
      "email-1.png",
      "caption-1.png",
      "caption-2.png",
      // The long stretch of recording was fast-forwarded: one speed badge.
      ...names.filter((n) => n.startsWith("speed-")),
    ])
    expect(names.some((n) => n.startsWith("speed-"))).toBe(true)
    expect(browser.log.launches).toBe(1)
    const transparent = browser.log.shots
      .filter((s) => s.omitBackground)
      .map((s) => s.path.slice(work.length + 1))
    expect(transparent).toEqual(
      expect.arrayContaining(["frame.png", "caption-1.png", "caption-2.png"]),
    )
    expect(transparent).not.toContain("intro.png")

    // One compose call with the page recording and the PNGs.
    const compose = tools.calls().filter((c) => c.tool === "ffmpeg")
    const composeCall = compose.find((c) => c.args.includes(output))!
    expect(composeCall.args.join(" ")).toContain(`-i ${join(dir, "page.webm")}`)
    expect(composeCall.args).toContain("-an")
    expect(composeCall.args.at(-1)).toBe(output)

    // The timeline file: where each segment starts, the steps, the pace.
    const timeline = readJson(join(work, "timeline.json")) as {
      segments: { kind: string; startSec: number }[]
      steps: { id: string; startSec: number; endSec: number; status: string }[]
      pace: unknown
      narration: unknown[]
    }
    expect(timeline.segments[0]).toMatchObject({ kind: "intro", startSec: 0 })
    expect(timeline.segments[1].startSec).toBe(3)
    expect(timeline.steps).toEqual([
      { id: "R1 inbound", startSec: 2, endSec: 6, status: "passed" },
      // Never ended: runs to the recording's end (100 s).
      { id: "R2 reply", startSec: 40, endSec: 100, status: "failed" },
    ])
    expect(timeline.pace).toEqual({ pace: "qa", slowFactor: 1 })
    expect(timeline.narration).toEqual([])

    // The reel manifest a pipeline splices from: relative paths, no narration.
    const reel = readReel(dir)!
    expect(reel.input.videoDurationSec).toBe(100)
    expect(reel.input.mail).toEqual([{ atSec: 11 }])
    expect(reel.frame).toBe(join(work, "frame.png"))
    expect(reel.emails).toEqual([join(work, "email-1.png")])
    expect(reel.captions).toEqual([
      join(work, "caption-1.png"),
      join(work, "caption-2.png"),
    ])
    expect(reel.narration).toBeUndefined()
    expect(reel.timeline).toBeUndefined()
    const raw = readJson(join(dir, REEL_FILE)) as unknown as ReelManifest
    expect(raw.appVideo).toBe("page.webm")
    expect(raw.frame).toBe(join("video", "frame.png"))
  })

  test("narrated: demo pace, one AAC track, the sentences in the files", async () => {
    const dir = tmp()
    const { kit, spoken } = narratingKit()
    const outcome = await produceVideo(makeRequest(dir), kit, {
      FLOWREEL_NARRATION: "on",
    })
    expect(outcome).toMatchObject({
      produced: true,
      narration: { produced: true, engine: "fake", voice: "Fake" },
      pace: { pace: "demo", slowFactor: 1.5 },
    })
    expect(spoken.length).toBeGreaterThan(0)
    const compose = tools
      .calls()
      .find((c) => c.tool === "ffmpeg" && c.args.includes("-filter_complex"))!
    expect(compose.args.join(" ")).toContain("-map [aout] -c:a aac")
    expect(compose.args.join(" ")).toContain("amix=inputs=")

    const timeline = readJson(join(dir, "video", "timeline.json")) as {
      narration: { kind: string; text: string }[]
    }
    expect(timeline.narration.map((c) => c.kind)).toEqual(
      expect.arrayContaining(["intro", "caption", "mail", "outro"]),
    )
    expect(timeline.narration.every((c) => c.text.length > 0)).toBe(true)

    const reel = readReel(dir)!
    expect(reel.timeline).toEqual({ slowFactor: 1.5, fastForward: false })
    expect(reel.narration?.captions).toHaveLength(2)
    expect(reel.narration?.mail).toHaveLength(1)
  })

  test("a curated intro / outro line is spoken, with the run's counts", async () => {
    const dir = tmp()
    const narrationDir = tmp("flowreel-lines-")
    writeFileSync(
      join(narrationDir, "orbit.json"),
      JSON.stringify({
        intro: "Welcome to the Acme round trip.",
        "outro.fail": "{PASSED} of {COUNT} steps passed, {FAILED} failed.",
      }),
    )
    const { kit, spoken } = narratingKit()
    const withLines = createVideoKit({ narrationDir })
    // Same voice, curated lines from the dir.
    const merged: VideoKit = {
      ...withLines,
      prepareNarration: kit.prepareNarration,
    }
    await produceVideo(makeRequest(dir), merged, { FLOWREEL_NARRATION: "on" })
    expect(spoken).toContain("Welcome to the Acme round trip.")
    expect(spoken.some((t) => /1 of 3 steps passed, 1 failed/i.test(t))).toBe(
      true,
    )
  })

  test("narration problems cost the narration only, never the video", async () => {
    const unavailable = narratingKit({
      available: () => Promise.resolve("no voice installed"),
    })
    const a = await produceVideo(makeRequest(tmp()), unavailable.kit, {
      FLOWREEL_NARRATION: "on",
    })
    expect(a).toMatchObject({
      produced: true,
      narration: { produced: false, reason: "no voice installed" },
    })

    const broken: VideoKit = {
      ...createVideoKit(),
      lines: () => {
        throw new Error("bad curated file\nsecond line")
      },
    }
    const b = await produceVideo(makeRequest(tmp()), broken, {
      FLOWREEL_NARRATION: "on",
    })
    expect(b).toMatchObject({
      produced: true,
      narration: { produced: false, reason: "bad curated file" },
    })
    const c = await produceVideo(
      makeRequest(tmp()),
      {
        ...createVideoKit(),
        lines: () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw "plain string"
        },
      },
      { FLOWREEL_NARRATION: "on" },
    )
    expect(c).toMatchObject({
      produced: true,
      narration: { produced: false, reason: "plain string" },
    })
  })

  test("an error with a blank message gives an empty reason, not a crash", async () => {
    const blank: VideoKit = {
      ...createVideoKit(),
      lines: () => {
        throw new Error("  \n ")
      },
    }
    const outcome = await produceVideo(makeRequest(tmp()), blank, {
      FLOWREEL_NARRATION: "on",
    })
    expect(outcome).toMatchObject({
      produced: true,
      narration: { produced: false, reason: "  \n " },
    })
  })

  test("a narrated compose that fails falls back to the silent cut", async () => {
    tools.rules([
      ...HEALTHY,
      { tool: "ffmpeg", match: "[aout]", code: 1, stderr: "audio graph bad" },
      { tool: "ffprobe", match: ".webm", stdout: "100\n" },
      { tool: "ffprobe", match: ".mp4", stdout: "42.26\n" },
    ])
    const dir = tmp()
    const outcome = await produceVideo(makeRequest(dir), narratingKit().kit, {
      FLOWREEL_NARRATION: "on",
    })
    expect(outcome).toMatchObject({
      produced: true,
      narration: {
        produced: false,
        reason: "the narrated video failed (ffmpeg failed: audio graph bad)",
      },
    })
    const composes = tools
      .calls()
      .filter((c) => c.tool === "ffmpeg" && c.args.includes("-filter_complex"))
    expect(composes).toHaveLength(2)
    expect(composes[0].args).toContain("[aout]")
    expect(composes[1].args).toContain("-an")
    // The silent cut's own speed badges were rendered; no narration saved.
    expect(browser.log.launches).toBe(2)
    expect(readReel(dir)?.narration).toBeUndefined()
    const timeline = readJson(join(dir, "video", "timeline.json")) as {
      narration: unknown[]
    }
    expect(timeline.narration).toEqual([])
  })

  test("a failing silent compose is the reason, first line only", async () => {
    tools.rules([
      ...HEALTHY,
      { tool: "ffprobe", stdout: "100\n" },
      {
        tool: "ffmpeg",
        match: "-filter_complex",
        code: 1,
        stderr: "x\ny\nz\n",
      },
    ])
    const outcome = await produceVideo(makeRequest(tmp()), createVideoKit(), {})
    expect(outcome).toMatchObject({
      produced: false,
      reason: "ffmpeg failed: x | y | z",
    })
    // The narrated variant fails the same way when the silent cut fails too.
    const narrated = await produceVideo(
      makeRequest(tmp()),
      narratingKit().kit,
      { FLOWREEL_NARRATION: "on" },
    )
    expect(narrated).toMatchObject({
      produced: false,
      reason: "ffmpeg failed: x | y | z",
    })
  })

  test("no usable ffmpeg is the reason; nothing is rendered", async () => {
    tools.rules([{ tool: "ffmpeg", code: 1 }])
    const dir = tmp()
    const outcome = await produceVideo(makeRequest(dir), createVideoKit(), {})
    expect(outcome).toMatchObject({
      produced: false,
      reason: "ffmpeg not found on PATH (install it, e.g. brew install ffmpeg)",
    })
    expect(browser.log.launches).toBe(0)
    expect(existsSync(join(dir, "video"))).toBe(false)
  })

  test("narration is announced as not produced when the video is blocked", async () => {
    const outcome = await produceVideo(
      { ...makeRequest(tmp()), flow: null },
      narratingKit().kit,
      { FLOWREEL_NARRATION: "on" },
    )
    expect(outcome).toEqual({
      produced: false,
      reason: "the orbit test did not run",
      narration: { produced: false, reason: "the video was not produced" },
      pace: { pace: "demo", slowFactor: 1.5 },
    })
  })

  test("a run directory that cannot be written is a reason, not a throw", async () => {
    const dir = tmp()
    // A FILE where the work folder should be.
    writeFileSync(join(dir, "video"), "")
    const outcome = await produceVideo(makeRequest(dir), createVideoKit(), {})
    expect(outcome.produced).toBe(false)
  })
})

// ---------------------------------------------------------------------------

test.describe("readReel", () => {
  const manifest = (over: Record<string, unknown> = {}) => ({
    input: { videoDurationSec: 10, steps: [], mail: [] },
    appVideo: "../page.webm",
    frame: "video/frame.png",
    captions: ["video/caption-1.png"],
    emails: ["video/email-1.png"],
    ...over,
  })
  const write = (dir: string, value: unknown, raw?: string) => {
    mkdirSync(join(dir, "video"), { recursive: true })
    writeFileSync(join(dir, REEL_FILE), raw ?? JSON.stringify(value, null, 2))
  }

  test("a good manifest comes back with absolute paths", () => {
    const dir = tmp()
    write(dir, manifest({ appVideo: "page.webm" }))
    const reel = readReel(dir)!
    expect(reel.appVideo).toBe(join(dir, "page.webm"))
    expect(reel.frame).toBe(join(dir, "video", "frame.png"))
    expect(reel.captions).toEqual([join(dir, "video", "caption-1.png")])
    expect(reel.emails).toEqual([join(dir, "video", "email-1.png")])
    expect(reel.timeline).toBeUndefined()
    expect(reel.narration).toBeUndefined()
  })

  test("timeline options are kept only when valid", () => {
    const dir = tmp()
    write(
      dir,
      manifest({
        appVideo: "p.webm",
        timeline: { slowFactor: 1.5, fastForward: false },
      }),
    )
    expect(readReel(dir)?.timeline).toEqual({
      slowFactor: 1.5,
      fastForward: false,
    })
    write(
      dir,
      manifest({
        appVideo: "p.webm",
        timeline: { slowFactor: 0.5, fastForward: "yes" },
      }),
    )
    expect(readReel(dir)?.timeline).toBeUndefined()
    write(
      dir,
      manifest({ appVideo: "p.webm", timeline: { fastForward: true } }),
    )
    expect(readReel(dir)?.timeline).toEqual({ fastForward: true })
  })

  test("narration texts are kept only when every entry is text or null", () => {
    const dir = tmp()
    write(
      dir,
      manifest({
        appVideo: "p.webm",
        narration: { captions: ["a", null], mail: ["m"] },
      }),
    )
    expect(readReel(dir)?.narration).toEqual({
      captions: ["a", null],
      mail: ["m"],
    })
    write(
      dir,
      manifest({
        appVideo: "p.webm",
        narration: { captions: ["a", 3], mail: [] },
      }),
    )
    expect(readReel(dir)?.narration).toBeUndefined()
    write(
      dir,
      manifest({ appVideo: "p.webm", narration: { captions: "a", mail: [] } }),
    )
    expect(readReel(dir)?.narration).toBeUndefined()
    write(
      dir,
      manifest({ appVideo: "p.webm", narration: { captions: [], mail: [1] } }),
    )
    expect(readReel(dir)?.narration).toBeUndefined()
  })

  test("a missing, unparsable or unsafe manifest is null", () => {
    const dir = tmp()
    expect(readReel(dir)).toBeNull()
    write(dir, null, "{ not json")
    expect(readReel(dir)).toBeNull()
    const bad: Record<string, unknown>[] = [
      { input: undefined },
      { appVideo: "/etc/passwd" },
      { appVideo: "" },
      { appVideo: 3 },
      { appVideo: "../../escape.webm" },
      { frame: "video/../../x.png" },
      { frame: undefined },
      { captions: "nope" },
      { emails: null },
      { captions: ["ok.png", "/abs.png"] },
      { emails: ["../../x.png"] },
    ]
    for (const over of bad) {
      write(dir, manifest({ appVideo: "p.webm", ...over }))
      expect(readReel(dir), JSON.stringify(over)).toBeNull()
    }
  })
})
