// SPDX-License-Identifier: Apache-2.0

import type { Env } from "../core/env.js"

import {
  type Clip,
  type VoiceEngine,
  defaultVoiceCacheDir,
  engineFor,
  synthesizeAll,
} from "./voice.js"

/** Whether a run's videos are narrated (and why not). */
export type NarrationDecision = { on: true } | { on: false; reason: string }

/** Curated narration lines, keyed by step title, step code or card key. */
export type NarrationLines = Record<string, string>

/** Where narration progress lines go (one line, no trailing newline). */
export type NarrationLog = (line: string) => void

/** Writes narration progress to the console with a `[flowreel]` prefix. */
export const defaultNarrationLog: NarrationLog = (line) =>
  console.log(`[flowreel] ${line}`)

// The impure half of narration: pick the engine, say
// every line once (cache first) and hand the videos each line's clip and
// length. Never throws: anything that stops it is "narration: not produced
// (<reason>)" and the video is made silent, exactly as without narration.

/** Whether a video was narrated (engine, voice, line counts), or why not. */
export type NarrationOutcome =
  | {
      produced: true
      engine: string
      voice: string
      /** The Samantha fallback warning, or null. */
      warning: string | null
      lines: number
      synthesized: number
      cached: number
    }
  | { produced: false; reason: string }

/** The synthesized lines of one video: each line's clip and length. */
export interface Narrator {
  /** A line's clip, or null for an empty / unknown line. */
  clip(text: string | null | undefined): Clip | null
  /** Its length in seconds, or null. */
  seconds(text: string | null | undefined): number | null
}

const firstLine = (message: string) =>
  (message.split("\n").find((l) => l.trim() !== "") ?? message).slice(0, 200)

/**
 * Says every line (empty ones skipped). Returns a narrator only when the
 * whole set could be synthesized.
 */
export async function prepareNarration(
  decision: NarrationDecision,
  texts: (string | null | undefined)[],
  env: Env = process.env,
  engine: VoiceEngine = engineFor(env),
  cacheDir: string = defaultVoiceCacheDir(env),
  log: NarrationLog = defaultNarrationLog,
): Promise<{ narrator: Narrator | null; outcome: NarrationOutcome }> {
  if (!decision.on) {
    return {
      narrator: null,
      outcome: { produced: false, reason: decision.reason },
    }
  }
  try {
    const problem = await engine.available()
    if (problem) {
      return { narrator: null, outcome: { produced: false, reason: problem } }
    }
    if (engine.warning) log(`narration: ${engine.warning}`)
    const lines = texts.filter(
      (t): t is string => typeof t === "string" && t.trim() !== "",
    )
    const result = await synthesizeAll(engine, lines, cacheDir)
    const narrator: Narrator = {
      clip: (text) => (text ? (result.clips.get(text) ?? null) : null),
      seconds: (text) =>
        text ? (result.clips.get(text)?.seconds ?? null) : null,
    }
    return {
      narrator,
      outcome: {
        produced: true,
        engine: engine.name,
        voice: engine.voice ?? engine.name,
        warning: engine.warning,
        lines: result.clips.size,
        synthesized: result.synthesized,
        cached: result.cached,
      },
    }
  } catch (error) {
    return {
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

/** "narration: Ava (Premium) (n lines, m synthesized, k cached)" */
export function narrationLine(outcome: NarrationOutcome): string {
  if (!outcome.produced) return `narration: not produced (${outcome.reason})`
  const warning = outcome.warning ? `; ${outcome.warning}` : ""
  return `narration: ${outcome.voice} (${outcome.lines} lines, ${outcome.synthesized} synthesized, ${outcome.cached} cached${warning})`
}
