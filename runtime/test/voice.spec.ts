// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "@playwright/test"

import { registerEnvAliases } from "../src/core/env.js"
import { prepareNarration } from "../src/voice/narrator.js"
import {
  CLIP_FORMAT_VERSION,
  DEFAULT_RATE,
  type Exec,
  FALLBACK_WARNING,
  cacheKey,
  clipFormat,
  engineFor,
  macosEngine,
  noneEngine,
  normalizeArgs,
  parseVoiceList,
  sayArgs,
  selectVoice,
  synthesizeAll,
  voiceRate,
} from "../src/voice/voice.js"

// Voice engines: voice selection order with the
// Samantha fallback warning, the argument-array invocation (the text is data,
// never a shell string), cache keys and the cache itself, and the "none"
// engine elsewhere. No real `say` or ffmpeg runs here: a fake Exec records
// every call.

const LIST = `Albert              en_US    # Hello! My name is Albert.
Ava (Premium)       en_US    # Hello! My name is Ava.
Samantha (English (US)) en_US    # Hello! My name is Samantha.
Zoe (Premium)       en_US    # Hello! My name is Zoe.
Amélie (Premium)    fr_CA    # Bonjour! Je m’appelle Amélie.
Evan (Enhanced)     en_US    # Hello! My name is Evan.
`

test.describe("voice selection", () => {
  const voices = parseVoiceList(LIST)

  test("parses names and locales, including the new long names", () => {
    expect(voices.map((v) => v.name)).toEqual([
      "Albert",
      "Ava (Premium)",
      "Samantha (English (US))",
      "Zoe (Premium)",
      "Amélie (Premium)",
      "Evan (Enhanced)",
    ])
    expect(voices[4].locale).toBe("fr_CA")
  })

  test("Premium first, preferring Ava, then Zoe, then Jamie", () => {
    expect(selectVoice(voices)).toEqual({
      voice: "Ava (Premium)",
      warning: null,
    })
    const noAva = voices.filter((v) => !v.name.startsWith("Ava"))
    expect(selectVoice(noAva)).toEqual({
      voice: "Zoe (Premium)",
      warning: null,
    })
  })

  test("a non-English Premium voice never wins; then Enhanced; then Samantha with a warning", () => {
    const enhancedOnly = voices.filter((v) => !/^(Ava|Zoe)/.test(v.name))
    expect(selectVoice(enhancedOnly)).toEqual({
      voice: "Evan (Enhanced)",
      warning: null,
    })
    const plain = enhancedOnly.filter((v) => !v.name.includes("Enhanced"))
    expect(selectVoice(plain)).toEqual({
      voice: "Samantha (English (US))",
      warning: FALLBACK_WARNING,
    })
    expect(FALLBACK_WARNING).toContain("using fallback voice Samantha")
    expect(
      "error" in
        selectVoice(plain.filter((v) => !v.name.startsWith("Samantha"))),
    ).toBe(true)
  })

  test("FLOWREEL_VOICE picks an exact installed name, or says it is missing", () => {
    expect(selectVoice(voices, "Zoe (Premium)")).toEqual({
      voice: "Zoe (Premium)",
      warning: null,
    })
    const missing = selectVoice(voices, "Nope")
    expect("error" in missing && missing.error).toContain(
      'FLOWREEL_VOICE "Nope" is not installed',
    )
  })

  test("the rate: 175 wpm by default, 90-360 accepted", () => {
    expect(DEFAULT_RATE).toBe(175)
    expect(voiceRate({})).toBe(175)
    expect(voiceRate({ FLOWREEL_VOICE_RATE: "160" })).toBe(160)
    expect(voiceRate({ FLOWREEL_VOICE_RATE: "9000" })).toBe(175)
  })
})

test.describe("argument-array invocation", () => {
  test("say gets the text as ONE argument after --, shell characters and all", () => {
    const nasty = '-v Bad; rm -rf / && echo "$(whoami)" `id` | tee x'
    const args = sayArgs("Ava (Premium)", 175, "/c/x.aiff", nasty)
    expect(args).toEqual([
      "-v",
      "Ava (Premium)",
      "-r",
      "175",
      "-o",
      "/c/x.aiff",
      "--",
      nasty,
    ])
    expect(normalizeArgs("/c/x.aiff", "/c/x.wav")).toEqual([
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      "/c/x.aiff",
      "-af",
      "loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      "/c/x.wav",
    ])
  })

  test("the macos engine lists voices, then says, normalises and measures, all as argument arrays", async () => {
    const calls: { tool: string; args: string[] }[] = []
    const exec: Exec = (tool, args) => {
      calls.push({ tool, args })
      if (tool === "say" && args[1] === "?") return Promise.resolve(LIST)
      if (tool === "ffprobe") return Promise.resolve("2.5\n")
      return Promise.resolve("")
    }
    const engine = macosEngine({ FLOWREEL_VOICE_RATE: "180" }, exec, "darwin")
    expect(await engine.available()).toBeNull()
    expect(engine.voice).toBe("Ava (Premium)")
    const text = "The agent opens the request; nothing $(else)."
    expect(await engine.synthesize(text, "/c/k.wav")).toBe(2.5)
    expect(calls.map((c) => c.tool)).toEqual([
      "say",
      "say",
      "ffmpeg",
      "ffprobe",
    ])
    expect(calls[1].args).toEqual(
      sayArgs("Ava (Premium)", 180, "/c/k.wav.aiff", text),
    )
    expect(calls.every((c) => Array.isArray(c.args))).toBe(true)
    expect(engine.cacheParts()).toEqual([
      "macos",
      "Ava (Premium)",
      "180",
      clipFormat(),
    ])
  })

  test("off macOS the engine is none: not produced, with the reason", async () => {
    expect(await engineFor({}, "linux").available()).toBe(
      "no voice engine on this platform",
    )
    expect(
      await engineFor({ FLOWREEL_VOICE_ENGINE: "piper" }, "darwin").available(),
    ).toBe("the piper voice engine is not built yet")
    expect(
      await engineFor({ FLOWREEL_VOICE_ENGINE: "none" }, "darwin").available(),
    ).toBe("FLOWREEL_VOICE_ENGINE=none")
    const outcome = await prepareNarration(
      { on: true },
      ["Hello."],
      {},
      noneEngine(),
    )
    expect(outcome).toEqual({
      narrator: null,
      outcome: { produced: false, reason: "no voice engine on this platform" },
    })
  })
})

test.describe("the clip cache", () => {
  test("keys change with engine, voice, rate and text", () => {
    const base = cacheKey(["macos", "Ava (Premium)", "175"], "Hello.")
    expect(base).toMatch(/^[0-9a-f]{64}$/)
    expect(cacheKey(["macos", "Ava (Premium)", "175"], "Hello.")).toBe(base)
    expect(cacheKey(["macos", "Zoe (Premium)", "175"], "Hello.")).not.toBe(base)
    expect(cacheKey(["macos", "Ava (Premium)", "180"], "Hello.")).not.toBe(base)
    expect(cacheKey(["macos", "Ava (Premium)", "175"], "Hello!")).not.toBe(base)
  })

  test("the clip format is part of the key: new normalisation, new clips", () => {
    // clip-v1 plus a hash of normalizeArgs: loudness, sample rate, channels.
    expect(clipFormat()).toMatch(
      new RegExp(`^${CLIP_FORMAT_VERSION}-[0-9a-f]{12}$`),
    )
    expect(clipFormat()).toBe(clipFormat())
    const parts = ["macos", "Ava (Premium)", "175"]
    expect(cacheKey([...parts, clipFormat()], "Hello.")).not.toBe(
      cacheKey([...parts, "clip-v0-000000000000"], "Hello."),
    )
    expect(
      macosEngine({}, () => Promise.resolve(""), "darwin").cacheParts(),
    ).toContain(clipFormat())
  })

  test("a re-run only synthesizes the lines that changed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "voice-cache-"))
    try {
      const said: string[] = []
      const engine = {
        ...noneEngine(),
        name: "fake",
        voice: "Fake",
        cacheParts: () => ["fake", "Fake", "175"],
        available: () => Promise.resolve(null),
        synthesize: (text: string, out: string) => {
          said.push(text)
          writeFileSync(out, "RIFF")
          return Promise.resolve(text.length / 10)
        },
      }
      const first = await synthesizeAll(
        engine,
        ["One.", "Two.", "One.", ""],
        dir,
      )
      expect(first).toMatchObject({ synthesized: 2, cached: 0 })
      expect(first.clips.get("Two.")).toEqual({
        path: join(dir, `${cacheKey(engine.cacheParts(), "Two.")}.wav`),
        seconds: 0.4,
      })
      expect(existsSync(first.clips.get("One.")!.path)).toBe(true)
      const second = await synthesizeAll(engine, ["One.", "Three."], dir)
      expect(second).toMatchObject({ synthesized: 1, cached: 1 })
      expect(said).toEqual(["One.", "Two.", "Three."])
      const narrated = await prepareNarration(
        { on: true },
        ["One.", null, "Three."],
        {},
        engine,
        dir,
      )
      expect(narrated.outcome).toEqual({
        produced: true,
        engine: "fake",
        voice: "Fake",
        warning: null,
        lines: 2,
        synthesized: 0,
        cached: 2,
      })
      expect(narrated.narrator?.seconds("One.")).toBe(0.4)
      expect(narrated.narrator?.seconds(null)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a failing synthesis is not produced, never a throw", async () => {
    const engine = {
      ...noneEngine(),
      available: () => Promise.resolve(null),
      synthesize: () =>
        Promise.reject(new Error("say failed: no audio device\nmore")),
    }
    const dir = mkdtempSync(join(tmpdir(), "voice-cache-"))
    try {
      const { narrator, outcome } = await prepareNarration(
        { on: true },
        ["Hi."],
        {},
        engine,
        dir,
      )
      expect(narrator).toBeNull()
      expect(outcome).toEqual({
        produced: false,
        reason: "say failed: no audio device",
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

test.describe("registered aliases (a project's own names)", () => {
  test("are read after FLOWREEL_VOICE*, and messages name the one that was set", async () => {
    registerEnvAliases({
      VOICE: ["LEGACY_VOICE"],
      VOICE_RATE: ["LEGACY_VOICE_RATE"],
      VOICE_ENGINE: ["LEGACY_VOICE_ENGINE"],
    })
    expect(voiceRate({ LEGACY_VOICE_RATE: "160" })).toBe(160)
    expect(
      voiceRate({ FLOWREEL_VOICE_RATE: "200", LEGACY_VOICE_RATE: "160" }),
    ).toBe(200)
    expect(
      await engineFor({ LEGACY_VOICE_ENGINE: "none" }, "darwin").available(),
    ).toBe("LEGACY_VOICE_ENGINE=none")
    expect(
      await engineFor({ LEGACY_VOICE_ENGINE: "espeak" }, "darwin").available(),
    ).toBe('unknown LEGACY_VOICE_ENGINE "espeak" (macos, none, piper, azure)')
    const exec: Exec = (tool) => Promise.resolve(tool === "say" ? LIST : "")
    const engine = macosEngine({ LEGACY_VOICE: "Nope" }, exec, "darwin")
    expect(await engine.available()).toBe(
      `LEGACY_VOICE "Nope" is not installed (say -v '?' lists the installed voices)`,
    )
    const flowreel = macosEngine(
      { FLOWREEL_VOICE: "Zoe (Premium)" },
      exec,
      "darwin",
    )
    expect(await flowreel.available()).toBeNull()
    expect(flowreel.voice).toBe("Zoe (Premium)")
  })
})
