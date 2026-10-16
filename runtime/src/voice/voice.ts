// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join, resolve } from "node:path"

import { type Env, envName, envVar } from "../core/env.js"

// Voice engines for the narrated demo videos. An engine turns one sentence into a
// loudness-normalised mono WAV and says how long it is. The text is DATA:
// every tool is called with an argument array (never a shell string), so a
// sentence can never become a command. Clips are cached by
// sha256(engine, voice, rate, text) in a cache directory (git-ignored; see
// defaultVoiceCacheDir), so a re-run only synthesizes the lines that changed.
//
//   macos  `say -v <voice> -r <rate> -o <clip>.aiff -- <text>`, then one
//          ffmpeg pass (loudnorm I=-16, 48 kHz mono). Default on darwin.
//   none   everywhere else: narration "not produced (no voice engine on this
//          platform)", the video stays silent.
//
// `piper` and `azure` are named seams only (FLOWREEL_VOICE_ENGINE accepts
// them and says they are not built yet). Every FLOWREEL_VOICE* variable also
// accepts any alias a project registered for it (core/env.ts).

/** Runs a tool with an argument array; resolves with its stdout. */
export type Exec = (
  tool: string,
  args: string[],
  timeoutMs?: number,
) => Promise<string>

export const runTool: Exec = (tool, args, timeoutMs = 60_000) =>
  new Promise((done, fail) => {
    execFile(
      tool,
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim().split("\n").slice(-2).join(" | ")
          fail(new Error(`${tool} failed: ${detail || error.message}`))
        } else {
          done(stdout)
        }
      },
    )
  })

export interface VoiceEngine {
  /** "macos", "none", … */
  name: string
  /** The voice in use, known once available() returned null. */
  voice: string | null
  /** A fallback warning for the summary (Samantha), or null. */
  warning: string | null
  /** Everything besides the text that changes the audio (the cache key). */
  cacheParts(): string[]
  /** Null when the engine can speak, else why not. */
  available(): Promise<string | null>
  /** Writes a normalised WAV to outPath; resolves with its length (s). */
  synthesize(text: string, outPath: string): Promise<number>
}

// ---------------------------------------------------------------------------
// Voice selection (pure)
// ---------------------------------------------------------------------------

export interface InstalledVoice {
  name: string
  /** "en_US" */
  locale: string
}

/** `say -v '?'` lines ("Ava (Premium)       en_US    # Hello! …"). */
export function parseVoiceList(output: string): InstalledVoice[] {
  const voices: InstalledVoice[] = []
  for (const line of output.split("\n")) {
    const m = /^(.+?)\s+([a-z]{2,3}_[A-Za-z0-9]+)\s+#/.exec(line)
    if (m && !voices.some((v) => v.name === m[1].trim())) {
      voices.push({ name: m[1].trim(), locale: m[2] })
    }
  }
  return voices
}

export const PREFERRED_VOICES = ["Ava", "Zoe", "Jamie"]

export const FALLBACK_WARNING =
  "using fallback voice Samantha: install a Premium voice (System Settings → Accessibility → Spoken Content)"

export type VoiceChoice =
  { voice: string; warning: string | null } | { error: string }

/**
 * FLOWREEL_VOICE (exact name) if set; else the first installed English
 * "(Premium)" voice, preferring Ava, Zoe, Jamie; then an "(Enhanced)" one
 * (same preference); then Samantha, with a warning. `variable` is the name
 * the requested voice came from (for the "not installed" message).
 */
export function selectVoice(
  installed: InstalledVoice[],
  requested?: string,
  variable = "FLOWREEL_VOICE",
): VoiceChoice {
  const wanted = requested?.trim()
  if (wanted) {
    return installed.some((v) => v.name === wanted)
      ? { voice: wanted, warning: null }
      : {
          error: `${variable} "${wanted}" is not installed (say -v '?' lists the installed voices)`,
        }
  }
  const english = installed.filter((v) => v.locale.startsWith("en"))
  const best = (tier: string) => {
    const pool = english.filter((v) => v.name.includes(tier))
    for (const name of PREFERRED_VOICES) {
      const hit = pool.find((v) => v.name.startsWith(`${name} `))
      if (hit) return hit.name
    }
    return pool[0]?.name ?? null
  }
  const voice = best("(Premium)") ?? best("(Enhanced)")
  if (voice) return { voice, warning: null }
  const samantha = english.find((v) => v.name.startsWith("Samantha"))
  if (samantha) return { voice: samantha.name, warning: FALLBACK_WARNING }
  return {
    error:
      "no English Premium, Enhanced or Samantha voice is installed (System Settings → Accessibility → Spoken Content)",
  }
}

export const DEFAULT_RATE = 175

/** FLOWREEL_VOICE_RATE in words per minute (default 175, 90–360). */
export function voiceRate(env: Env): number {
  const raw = envVar(env, "VOICE_RATE")?.value.trim()
  if (!raw) return DEFAULT_RATE
  const rate = Number(raw)
  return Number.isInteger(rate) && rate >= 90 && rate <= 360
    ? rate
    : DEFAULT_RATE
}

/** Pure: the `say` arguments (the text is the last, after "--"). */
export function sayArgs(
  voice: string,
  rate: number,
  aiffPath: string,
  text: string,
): string[] {
  return ["-v", voice, "-r", String(rate), "-o", aiffPath, "--", text]
}

/** Pure: one ffmpeg pass to a loudness-normalised 48 kHz mono WAV. */
export function normalizeArgs(input: string, output: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    input,
    "-af",
    "loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    output,
  ]
}

/**
 * The clip format's fingerprint, part of every macOS cache key: bump the
 * version when the WAV changes in a way normalizeArgs does not show (the
 * `say` intermediate, a post-step); a change to normalizeArgs (loudness
 * targets, sample rate, channels, codec) changes the hash by itself. Either
 * way old clips in the cache are never mixed with new ones.
 */
export const CLIP_FORMAT_VERSION = "clip-v1"

export function clipFormat(): string {
  const args = createHash("sha256")
    .update(JSON.stringify(normalizeArgs("in", "out")))
    .digest("hex")
    .slice(0, 12)
  return `${CLIP_FORMAT_VERSION}-${args}`
}

async function probeSeconds(exec: Exec, path: string): Promise<number> {
  const out = await exec("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    path,
  ])
  const seconds = Number.parseFloat(out.trim())
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`could not read the length of ${path}`)
  }
  return seconds
}

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------

export function macosEngine(
  env: Env,
  exec: Exec = runTool,
  platform: string = process.platform,
): VoiceEngine {
  const rate = voiceRate(env)
  const engine: VoiceEngine = {
    name: "macos",
    voice: null,
    warning: null,
    cacheParts: () => ["macos", engine.voice ?? "", String(rate), clipFormat()],
    async available() {
      if (platform !== "darwin") return "the macos voice engine needs macOS"
      let list: string
      try {
        list = await exec("say", ["-v", "?"], 30_000)
      } catch (error) {
        return `say is not usable (${error instanceof Error ? error.message : String(error)})`
      }
      const requested = envVar(env, "VOICE")
      const choice = selectVoice(
        parseVoiceList(list),
        requested?.value,
        requested?.name,
      )
      if ("error" in choice) return choice.error
      engine.voice = choice.voice
      engine.warning = choice.warning
      return null
    },
    async synthesize(text, outPath) {
      if (!engine.voice) throw new Error("no voice selected (call available())")
      const aiff = `${outPath}.aiff`
      try {
        await exec("say", sayArgs(engine.voice, rate, aiff, text), 120_000)
        await exec("ffmpeg", normalizeArgs(aiff, outPath), 120_000)
      } finally {
        rmSync(aiff, { force: true })
      }
      return probeSeconds(exec, outPath)
    },
  }
  return engine
}

export function noneEngine(
  reason = "no voice engine on this platform",
): VoiceEngine {
  return {
    name: "none",
    voice: null,
    warning: null,
    cacheParts: () => ["none"],
    available: () => Promise.resolve(reason),
    synthesize: () => Promise.reject(new Error(reason)),
  }
}

export const ENGINES = ["macos", "none", "piper", "azure"] as const

/**
 * FLOWREEL_VOICE_ENGINE picks one (macos | none; piper and azure are
 * seams, not built yet); unset = macos on darwin, none elsewhere.
 */
export function engineFor(
  env: Env,
  platform: string = process.platform,
  exec: Exec = runTool,
): VoiceEngine {
  const variable = envName(env, "VOICE_ENGINE")
  const wanted = envVar(env, "VOICE_ENGINE")?.value.trim().toLowerCase()
  if (wanted === "piper" || wanted === "azure") {
    return noneEngine(`the ${wanted} voice engine is not built yet`)
  }
  if (wanted && wanted !== "macos" && wanted !== "none") {
    return noneEngine(`unknown ${variable} "${wanted}" (${ENGINES.join(", ")})`)
  }
  if (wanted === "none") return noneEngine(`${variable}=none`)
  if (wanted === "macos" || platform === "darwin") {
    return macosEngine(env, exec, platform)
  }
  return noneEngine()
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/**
 * Where clips are cached unless a caller passes a directory:
 * FLOWREEL_VOICE_CACHE_DIR, else `.flowreel/cache/voice` under the current
 * working directory. Read at call time.
 */
export function defaultVoiceCacheDir(env: Env = process.env): string {
  const configured = envVar(env, "VOICE_CACHE_DIR")?.value.trim()
  return configured
    ? resolve(configured)
    : resolve(process.cwd(), ".flowreel", "cache", "voice")
}

/** Pure: the cache key of one clip. */
export function cacheKey(parts: string[], text: string): string {
  return createHash("sha256")
    .update(JSON.stringify([...parts, text]))
    .digest("hex")
}

export interface Clip {
  path: string
  seconds: number
}

export interface SynthesisResult {
  /** By text. */
  clips: Map<string, Clip>
  synthesized: number
  cached: number
}

/**
 * Every distinct text once: from the cache when its WAV and length are
 * there, else synthesized (a few at a time) and stored. Throws on the first
 * failure (the caller then makes the silent video).
 */
export async function synthesizeAll(
  engine: VoiceEngine,
  texts: string[],
  dir: string = defaultVoiceCacheDir(),
  concurrency = 3,
): Promise<SynthesisResult> {
  mkdirSync(dir, { recursive: true })
  const unique = [...new Set(texts.filter((t) => t.trim() !== ""))]
  const clips = new Map<string, Clip>()
  let synthesized = 0
  let cached = 0
  const todo: { text: string; wav: string; meta: string }[] = []
  for (const text of unique) {
    const key = cacheKey(engine.cacheParts(), text)
    const wav = join(dir, `${key}.wav`)
    const meta = join(dir, `${key}.json`)
    if (existsSync(wav) && existsSync(meta)) {
      try {
        const seconds = Number(
          (JSON.parse(readFileSync(meta, "utf8")) as { seconds?: unknown })
            .seconds,
        )
        if (Number.isFinite(seconds) && seconds > 0) {
          clips.set(text, { path: wav, seconds })
          cached++
          continue
        }
      } catch {
        // A broken entry is synthesized again.
      }
    }
    todo.push({ text, wav, meta })
  }
  let next = 0
  const worker = async () => {
    while (next < todo.length) {
      const job = todo[next++]
      const partial = `${job.wav}.part.wav`
      const seconds = await engine.synthesize(job.text, partial)
      renameSync(partial, job.wav)
      writeFileSync(job.meta, `${JSON.stringify({ seconds })}\n`)
      clips.set(job.text, { path: job.wav, seconds })
      synthesized++
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, todo.length) }, worker),
  )
  return { clips, synthesized, cached }
}
