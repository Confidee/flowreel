// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "@playwright/test"

import { DEFAULT_NARRATION_COPY, everyMatch } from "../src/narration/copy.js"
import {
  type Exec,
  type VoiceEngine,
  cacheKey,
  engineFor,
  macosEngine,
  noneEngine,
  runTool,
  synthesizeAll,
} from "../src/voice/index.js"
import { narrationLine, prepareNarration } from "../src/voice/narrator.js"

// Voice engines and the narrator: tool failures, platform refusals and
// cache entries that cannot be trusted. No real say or ffmpeg runs: a fake
// Exec stands in, and runTool is exercised with the node binary itself.

const LIST = "Ava (Premium)       en_US    # Hello! My name is Ava.\n"

test.describe("runTool", () => {
  test("resolves with the tool's stdout", async () => {
    const out = await runTool(process.execPath, [
      "-e",
      "process.stdout.write('hello')",
    ])
    expect(out).toBe("hello")
  })

  test("a failing tool names itself and the last two stderr lines", async () => {
    await expect(
      runTool(process.execPath, [
        "-e",
        "console.error('one\\ntwo\\nthree'); process.exit(3)",
      ]),
    ).rejects.toThrow(`${process.execPath} failed: two | three`)
  })

  test("a tool that cannot start falls back to the system error", async () => {
    await expect(runTool("/nonexistent/flowreel-tool", [])).rejects.toThrow(
      "/nonexistent/flowreel-tool failed: spawn /nonexistent/flowreel-tool ENOENT",
    )
  })
})

test.describe("the macos engine", () => {
  test("off macOS it refuses with a reason", async () => {
    const engine = macosEngine({}, () => Promise.resolve(""), "linux")
    expect(await engine.available()).toBe("the macos voice engine needs macOS")
  })

  test("a say that cannot list voices is reported, Error or not", async () => {
    const failing =
      (thrown: unknown): Exec =>
      () =>
        Promise.reject(thrown)
    expect(
      await macosEngine({}, failing(new Error("no say")), "darwin").available(),
    ).toBe("say is not usable (no say)")
    expect(await macosEngine({}, failing("plain"), "darwin").available()).toBe(
      "say is not usable (plain)",
    )
  })

  test("a requested voice that is not installed is the engine's problem", async () => {
    const engine = macosEngine(
      { FLOWREEL_VOICE: "Nobody" },
      () => Promise.resolve(LIST),
      "darwin",
    )
    const problem = await engine.available()
    expect(problem).toContain("Nobody")
    expect(engine.voice).toBeNull()
  })

  test("synthesize needs available() first and refuses an unreadable length", async () => {
    const calls: string[] = []
    const exec: Exec = (tool) => {
      calls.push(tool)
      if (tool === "say" && calls.length === 1) return Promise.resolve(LIST)
      if (tool === "ffprobe") return Promise.resolve("not a number\n")
      return Promise.resolve("")
    }
    const engine = macosEngine({}, exec, "darwin")
    await expect(engine.synthesize("Hi.", "/tmp/x.wav")).rejects.toThrow(
      "no voice selected (call available())",
    )
    expect(calls).toEqual([])
    expect(await engine.available()).toBeNull()
    await expect(engine.synthesize("Hi.", "/tmp/x.wav")).rejects.toThrow(
      "could not read the length of /tmp/x.wav",
    )
    const zero: Exec = (tool) =>
      Promise.resolve(tool === "ffprobe" ? "0\n" : tool === "say" ? LIST : "")
    const silent = macosEngine({}, zero, "darwin")
    await silent.available()
    await expect(silent.synthesize("Hi.", "/tmp/y.wav")).rejects.toThrow(
      "could not read the length",
    )
  })
})

test.describe("engine choice", () => {
  test("none refuses to synthesize and says why", async () => {
    const engine = noneEngine("custom reason")
    expect(await engine.available()).toBe("custom reason")
    await expect(engine.synthesize("x", "/tmp/x")).rejects.toThrow(
      "custom reason",
    )
  })

  test("naming macos picks it on any platform; the engine then needs macOS", async () => {
    const engine = engineFor(
      { FLOWREEL_VOICE_ENGINE: " MacOS " },
      "linux",
      () => Promise.resolve(""),
    )
    expect(engine.name).toBe("macos")
    expect(await engine.available()).toBe("the macos voice engine needs macOS")
  })

  test("the seams and unknown names are none with their reason", async () => {
    expect(
      await engineFor({ FLOWREEL_VOICE_ENGINE: "piper" }, "darwin").available(),
    ).toBe("the piper voice engine is not built yet")
    expect(
      await engineFor({ FLOWREEL_VOICE_ENGINE: "none" }, "darwin").available(),
    ).toBe("FLOWREEL_VOICE_ENGINE=none")
    expect(
      await engineFor(
        { FLOWREEL_VOICE_ENGINE: "festival" },
        "darwin",
      ).available(),
    ).toContain('unknown FLOWREEL_VOICE_ENGINE "festival"')
  })
})

test.describe("the clip cache", () => {
  const fake = (said: string[]): VoiceEngine => ({
    ...noneEngine(),
    name: "fake",
    voice: "Fake",
    cacheParts: () => ["fake"],
    available: () => Promise.resolve(null),
    synthesize: (text, out) => {
      said.push(text)
      writeFileSync(out, "RIFF")
      return Promise.resolve(1.5)
    },
  })

  test("a cache entry with unreadable or non-positive length is synthesized again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flowreel-voice-"))
    try {
      const said: string[] = []
      const engine = fake(said)
      const entry = (text: string, meta: string) => {
        const key = cacheKey(engine.cacheParts(), text)
        writeFileSync(join(dir, `${key}.wav`), "RIFF")
        writeFileSync(join(dir, `${key}.json`), meta)
      }
      entry("Broken.", "{not json")
      entry("Zero.", JSON.stringify({ seconds: 0 }))
      entry("Good.", JSON.stringify({ seconds: 2 }))
      const result = await synthesizeAll(
        engine,
        ["Broken.", "Zero.", "Good."],
        dir,
      )
      expect(said.sort()).toEqual(["Broken.", "Zero."])
      expect(result).toMatchObject({ synthesized: 2, cached: 1 })
      expect(result.clips.get("Good.")?.seconds).toBe(2)
      expect(result.clips.get("Broken.")?.seconds).toBe(1.5)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

test.describe("the narrator", () => {
  const dirOf = () => mkdtempSync(join(tmpdir(), "flowreel-narr-"))
  const engine = (over: Partial<VoiceEngine> = {}): VoiceEngine => ({
    name: "fake",
    voice: "Fake",
    warning: null,
    cacheParts: () => ["fake"],
    available: () => Promise.resolve(null),
    synthesize: (_text, out) => {
      writeFileSync(out, "RIFF")
      return Promise.resolve(2)
    },
    ...over,
  })

  test("a fallback warning is logged, empty lines are ignored and the voice defaults to the engine name", async () => {
    const dir = dirOf()
    try {
      const logged: string[] = []
      const { narrator, outcome } = await prepareNarration(
        { on: true },
        ["Hello.", "", null, undefined, "   "],
        {},
        engine({ voice: null, warning: "using the fallback voice" }),
        dir,
        (line) => logged.push(line),
      )
      expect(logged).toEqual(["narration: using the fallback voice"])
      expect(outcome).toMatchObject({
        produced: true,
        engine: "fake",
        voice: "fake",
        warning: "using the fallback voice",
        lines: 1,
      })
      expect(narrator?.clip("Hello.")?.seconds).toBe(2)
      expect(narrator?.clip("")).toBeNull()
      expect(narrator?.clip(null)).toBeNull()
      expect(narrator?.clip("Unknown.")).toBeNull()
      expect(narrator?.seconds("Hello.")).toBe(2)
      expect(narrator?.seconds(undefined)).toBeNull()
      expect(narrator?.seconds("Unknown.")).toBeNull()
      // Another engine's line carries no Apple notice.
      expect(narrationLine(outcome)).toBe(
        "narration: fake (1 lines, 1 synthesized, 0 cached; using the fallback voice)",
      )
      // A macOS voice's line always carries Apple's licence terms.
      expect(
        narrationLine({
          produced: true,
          engine: "macos",
          voice: "Ava (Premium)",
          warning: "using the fallback voice",
          lines: 1,
          synthesized: 1,
          cached: 0,
        }),
      ).toBe(
        "narration: Ava (Premium) (1 lines, 1 synthesized, 0 cached; using the fallback voice). Apple licenses the macOS voices for personal, non-commercial use only (macOS licence §2F); for work or public videos, ask Apple or use another voice.",
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("with the default log, progress goes to the console with a prefix", async () => {
    const dir = dirOf()
    const original = console.log
    const printed: string[] = []
    try {
      console.log = (line: string) => void printed.push(line)
      await prepareNarration(
        { on: true },
        ["Hi."],
        {},
        engine({ warning: "careful" }),
        dir,
      )
      expect(printed).toEqual(["[flowreel] narration: careful"])
    } finally {
      console.log = original
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a synthesis failure is a not-produced outcome with its first non-blank line", async () => {
    const dir = dirOf()
    try {
      const failWith = (thrown: unknown) =>
        prepareNarration(
          { on: true },
          ["Hi."],
          {},
          engine({ synthesize: () => Promise.reject(thrown) }),
          dir,
          () => undefined,
        )
      expect(
        (await failWith(new Error("\n  \nreal cause\nmore"))).outcome,
      ).toEqual({ produced: false, reason: "real cause" })
      expect((await failWith("plain text")).outcome).toEqual({
        produced: false,
        reason: "plain text",
      })
      // A message with no non-blank line is kept whole.
      expect((await failWith(new Error("  "))).outcome).toEqual({
        produced: false,
        reason: "  ",
      })
      expect((await failWith("x".repeat(300))).outcome).toMatchObject({
        reason: "x".repeat(200),
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

test.describe("narration copy", () => {
  test("emails without a subject, and a tour that passed everything", () => {
    const { email, tour } = DEFAULT_NARRATION_COPY
    expect(email.received("")).toBe("An email arrives.")
    expect(email.received("Hello")).toBe("An email arrives: Hello")
    expect(email.sent("")).toBe("An email is sent.")
    expect(email.sent("Hello")).toBe("An email is sent: Hello")
    expect(tour.summary(3, 3, 0)).toBe(
      "That is the whole tour: 3 of 3 features passed.",
    )
    expect(tour.summary(2, 3, 1)).toBe(
      "That is the whole tour: 2 of 3 features passed, and 1 failed.",
    )
  })

  test("everyMatch drops sticky and keeps a global flag already there", () => {
    const sticky = /a+/gy
    const fixed = everyMatch(sticky)
    expect(fixed.flags).toBe("g")
    expect(fixed).not.toBe(sticky)
    expect(everyMatch(/a/i).flags).toBe("gi")
    const already = /a/g
    expect(everyMatch(already)).toBe(already)
  })
})
