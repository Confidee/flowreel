// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { type Env, envNames, envValue, envVar } from "../core/env.js"
import { type Pace, parsePace } from "../tour/policy.js"
import type { MailCard } from "../video/recorder.js"
import type { WaitKind } from "../video/reel-voice.js"
import type { TimelineOptions } from "../video/timeline.js"
import type { NarrationDecision, NarrationLines } from "../voice/narrator.js"

import {
  DEFAULT_NARRATION_COPY,
  type FailureKind,
  type NarrationCopy,
  neverSpeakOf,
} from "./copy.js"

// What the narrated demo videos say. Pure apart from reading the curated
// line files.
//
//   - Every step is said by default as its title's sentence ("B1.1 The agent
//     assigns the record to themselves" -> "The agent assigns the record to
//     themselves."), so a new step is narrated with no extra text.
//   - Curated lines override it: <narration dir>/<module>.json, keyed by
//     the full step title (for a step whose title differs per target), the
//     step code ("B1.1"), the feature id ("B1", its title card), "area"
//     (area intro) and "outro" (area scoreboard); placeholders ({RUN_ID},
//     {COUNT}, {PASSED}, {FAILED} and the project's own) are filled with
//     SPOKEN words.
//   - Never spoken: addresses, links, run ids, QA subject prefixes, opaque
//     tokens and the project's own patterns (speakable() removes them).
//   - Email cards say the copy's received / reply / sent line; a failed
//     step adds "This step failed: <short reason>." (never the error text).
//   - Every sentence that is not a curated line comes from the project's
//     NarrationCopy (DEFAULT_NARRATION_COPY: neutral English).

/** "<module>" -> its curated lines from `dir` ({} when none). */
export function loadNarration(module: string, dir: string): NarrationLines {
  try {
    const raw = JSON.parse(
      readFileSync(resolve(dir, `${module}.json`), "utf8"),
    ) as Record<string, unknown>
    const lines: NarrationLines = {}
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === "string" && !key.startsWith("_")) lines[key] = value
    }
    return lines
  } catch {
    return {}
  }
}

/** A tour area's narration module: "tour-<letter>". */
export const tourNarrationModule = (letter: string) =>
  `tour-${letter.toLowerCase()}`

// ---------------------------------------------------------------------------
// On / off, pace, slow factor
// ---------------------------------------------------------------------------

/** Which kind of video a run makes: one flow's round trip, or a tour. */
export type VideoKind = "round-trip" | "tour"

const OFF = ["off", "0", "false", "no"]
const ON = ["on", "1", "true", "yes"]

/**
 * The name a hint should give a setting nobody set: the project's own name
 * for it when it registered one (core/env.ts aliases), else FLOWREEL_<KEY>.
 */
export function settingHintName(key: string): string {
  const names = envNames(key)
  return names[1] ?? names[0]
}

/**
 * Narration is off unless FLOWREEL_NARRATION=on turns it on, whatever the
 * run and its pace: the only voices are the macOS system voices, which
 * Apple licenses for personal, non-commercial use only (macOS licence
 * §2F), so a video is never narrated with one by default.
 * FLOWREEL_NARRATION=off is also honoured (it silences combined videos).
 */
export function narrationDecision(
  env: Env,
  _run: { kind: VideoKind; pace: Pace },
): NarrationDecision {
  const set = envVar(env, "NARRATION")
  const value = (set?.value ?? "").trim().toLowerCase()
  if (OFF.includes(value)) {
    return { on: false, reason: `${set!.name}=off` }
  }
  if (ON.includes(value)) return { on: true }
  return {
    on: false,
    reason: `off unless ${settingHintName("NARRATION")}=on (the macOS voices are licensed for personal, non-commercial use only)`,
  }
}

/** Narration forced off (FLOWREEL_NARRATION=off) also silences combined videos. */
export const narrationForcedOff = (env: Env) =>
  OFF.includes((envValue(env, "NARRATION") ?? "").trim().toLowerCase())

export const DEFAULT_SLOW_FACTOR = 1.5

/** FLOWREEL_SLOW_FACTOR (default 1.5; 1–3, anything else = default). */
export function slowFactorOf(env: Env): number {
  const raw = envValue(env, "SLOW_FACTOR")?.trim()
  if (!raw) return DEFAULT_SLOW_FACTOR
  const value = Number(raw)
  return Number.isFinite(value) && value >= 1 && value <= 3
    ? value
    : DEFAULT_SLOW_FACTOR
}

/**
 * FLOWREEL_PACE as a video pace: parsePace, with "demo" (the default) for a
 * value parsePace refuses; the video never fails over a pace the run itself
 * has already reported.
 */
export function videoPaceOf(raw: string | undefined): Pace {
  try {
    return parsePace(raw)
  } catch {
    return "demo"
  }
}

export interface VideoPace {
  pace: Pace
  /** 1 = real time; 1.5 = recordings play at two-thirds speed. */
  slowFactor: number
  narration: NarrationDecision
}

/**
 * How a run's videos are paced and whether they are narrated. A tour: its
 * pace (`pace`, else FLOWREEL_PACE, demo by default). A round trip has no
 * browser pace of its own: its video is composed at demo pace exactly when
 * it is narrated (FLOWREEL_NARRATION=on), else qa (long waits
 * fast-forwarded). Narration itself is off unless turned on
 * (narrationDecision).
 */
export function videoPaceFor(
  kind: VideoKind,
  env: Env,
  pace?: Pace,
): VideoPace {
  const tourPace = pace ?? videoPaceOf(envValue(env, "PACE"))
  const narration = narrationDecision(env, {
    kind,
    pace: kind === "round-trip" ? "qa" : tourPace,
  })
  const videoPace: Pace =
    kind === "round-trip" ? (narration.on ? "demo" : "qa") : tourPace
  return {
    pace: videoPace,
    slowFactor: videoPace === "demo" ? slowFactorOf(env) : 1,
    narration,
  }
}

/** Demo pace never fast-forwards and plays at 1/slowFactor. */
export function timelineOptionsFor(
  pace: Pick<VideoPace, "pace" | "slowFactor">,
): Partial<TimelineOptions> {
  return pace.pace === "demo"
    ? { slowFactor: pace.slowFactor, fastForward: false }
    : {}
}

// ---------------------------------------------------------------------------
// Pure text rules (no copy)
// ---------------------------------------------------------------------------

/** A sentence ends with punctuation; the first letter is a capital. */
export function asSentence(text: string): string {
  const t = text.trim()
  if (!t) return ""
  const capital = t.charAt(0).toUpperCase() + t.slice(1)
  return /[.!?…]$/.test(capital) ? capital : `${capital}.`
}

/** What kind of failure an error is (its category is what gets said). */
export function failureKind(error: string | null | undefined): FailureKind {
  const text = (error ?? "").toLowerCase()
  if (!text) return "unfinished"
  if (/timeout|timed out|exceeded/.test(text)) return "timeout"
  if (/net::|econn|socket|network|fetch failed|502|503|504/.test(text)) {
    return "unreachable"
  }
  if (/expect|tobe|tohave|tocontain|toequal|received|expected/.test(text)) {
    return "unexpected"
  }
  if (/refus|forbidden|403|401|not allowed/.test(text)) return "refused"
  return "other"
}

/** Short, never the error text itself (in `copy`, default English). */
export function failureCategory(
  error: string | null | undefined,
  copy: Pick<NarrationCopy, "failure"> = DEFAULT_NARRATION_COPY,
): string {
  return copy.failure.categories[failureKind(error)]
}

/** A failed step's added line (in `copy`, default English). */
export function failureLine(
  error: string | null | undefined,
  copy: Pick<NarrationCopy, "failure"> = DEFAULT_NARRATION_COPY,
): string {
  return copy.failure.line(failureCategory(error, copy))
}

/**
 * A feature card's line without a curated one: "list-search" -> "Feature
 * A4: list search." (in `copy`, default English).
 */
export function featureFallback(
  id: string,
  title: string,
  copy: Pick<NarrationCopy, "featureFallback"> = DEFAULT_NARRATION_COPY,
): string {
  return asSentence(copy.featureFallback(id, title.replace(/[-_]+/g, " ")))
}

// ---------------------------------------------------------------------------
// Lines (in a project's copy)
// ---------------------------------------------------------------------------

/** Spoken values of the placeholders (unknown ones become plain words). */
export interface NarrationVars {
  COUNT?: number
  PASSED?: number
  FAILED?: number
}

export interface StepNarration {
  title: string
  failed: boolean
  /** The step's error (only its category is ever spoken). */
  error?: string | null
}

export type TourCardLine =
  | { kind: "tour-intro"; count: number; areas: number; target: string }
  | {
      kind: "area-intro" | "area-chapter"
      area: string
      title: string
      count: number
    }
  | {
      kind: "feature"
      id: string
      title: string
      card: "title" | "dev-only" | "view" | "not-run"
    }
  | {
      kind: "area-scoreboard"
      area: string
      page: number
      count: number
      passed: number
      failed: number
    }
  | { kind: "tour-summary"; count: number; passed: number; failed: number }
  | { kind: "tour-scoreboard"; page: number }

/** The narration rules in one project's copy (createNarration). */
export interface Narration {
  readonly copy: NarrationCopy
  /** What in a line may never be spoken (empty = fine). */
  unspeakableParts: (text: string) => string[]
  /** The line with everything never-speak removed, tidied up. */
  speakable: (text: string) => string
  fillPlaceholders: (text: string, vars: NarrationVars) => string
  /** "B1.1 The agent…" -> "B1.1"; else "" (the cards' step code). */
  stepCode: (title: string) => string
  /** The default line of a step: its caption's sentence. */
  defaultStepLine: (title: string) => string
  /** A curated line (placeholders filled, never-speak removed), or null. */
  curated: (
    lines: NarrationLines,
    keys: string[],
    vars?: NarrationVars,
  ) => string | null
  /**
   * A step's line: curated (full title, then step code) or the title's
   * sentence; a failed step adds its failure line; a long wait inside it
   * adds one wait line.
   */
  stepLine: (
    lines: NarrationLines,
    step: StepNarration,
    wait?: WaitKind | null,
    vars?: NarrationVars,
  ) => string
  /**
   * A subject as it may be said: no QA prefix, record number, "Re:" or
   * leading feature code ("[QA <run>] B8 Copy …" -> "Copy …").
   */
  spokenSubject: (subject: string) => string
  /**
   * The key an email card's curated line is filed under: the step code
   * ("B8.4 …" -> "B8.4"), else a leading feature id ("H5 requester
   * receives the reply" -> "H5"); "" when neither.
   */
  emailCode: (step: string) => string
  /**
   * An email card's line: curated "<code>.email" (the n-th card of the same
   * step tries "<code>.email.<n>" first), else the copy's received / reply /
   * sent line.
   */
  emailLine: (
    lines: NarrationLines,
    card: MailCard,
    occurrence?: number,
  ) => string
  /** A tour card's line, or null for a silent card. */
  tourCardLine: (lines: NarrationLines, card: TourCardLine) => string | null
  /**
   * The round trip's intro and outro lines: curated "intro", and
   * "outro.<verdict>" ("outro.pass", "outro.fail", "outro.n/a") then
   * "outro".
   */
  roundTripCardLine: (
    lines: NarrationLines,
    kind: "intro" | "outro",
    vars: NarrationVars,
    verdict?: string,
  ) => string
}

export interface NarrationOptions {
  copy?: NarrationCopy
  /**
   * The caption's step label (the cards' stepLabel), so a step is said as
   * its caption reads.
   */
  stepLabel: (title: string) => { code: string; title: string }
}

/**
 * The narration rules in one project's copy: what each step, email and card
 * says, and what may never be said. `copy` defaults to the neutral English
 * DEFAULT_NARRATION_COPY; `stepLabel` is the cards' (Cards.stepLabel), so a
 * step is said exactly as its caption reads. Pure; only the curated-line
 * lookups take lines the caller loaded (loadNarration).
 */
export function createNarration(options: NarrationOptions): Narration {
  const copy = options.copy ?? DEFAULT_NARRATION_COPY
  const { stepLabel } = options
  const neverSpeak = neverSpeakOf(copy)
  // The id is grouped so an alternation in it stays anchored as a whole.
  const featureCode = new RegExp(`^(?:${copy.featureId})(?:\\.\\d{1,2})?\\s+`)
  const featureLabel = new RegExp(`^(?:${copy.featureId})(?=\\s|$)`)

  function unspeakableParts(text: string): string[] {
    return neverSpeak
      .filter(({ pattern }) => {
        pattern.lastIndex = 0
        const hit = pattern.test(text)
        pattern.lastIndex = 0
        return hit
      })
      .map(({ name }) => name)
  }

  function speakable(text: string): string {
    let out = text
    for (const { pattern } of neverSpeak) out = out.replace(pattern, " ")
    return out
      .replace(/\s+([,.;:!?])/g, "$1")
      .replace(/([,;:])(?:\s*[,;:])+/g, "$1")
      .replace(/\(\s*\)/g, "")
      .replace(/\s{2,}/g, " ")
      .replace(/^[\s,.;:-]+/, "")
      .trim()
  }

  function fillPlaceholders(text: string, vars: NarrationVars): string {
    return text.replace(/\{([A-Z][A-Z0-9_]*)\}/g, (_, name: string) => {
      const value = (vars as Record<string, unknown>)[name]
      if (typeof value === "number") return String(value)
      return copy.placeholders[name] ?? "it"
    })
  }

  const stepCode = (title: string) => stepLabel(title).code

  const defaultStepLine = (title: string) => asSentence(stepLabel(title).title)

  function curated(
    lines: NarrationLines,
    keys: string[],
    vars: NarrationVars = {},
  ): string | null {
    for (const key of keys) {
      const value = lines[key]
      if (typeof value === "string" && value.trim()) {
        const line = speakable(fillPlaceholders(value, vars))
        if (line) return asSentence(line)
      }
    }
    return null
  }

  function stepLine(
    lines: NarrationLines,
    step: StepNarration,
    wait: WaitKind | null = null,
    vars: NarrationVars = {},
  ): string {
    const code = stepCode(step.title)
    const base =
      curated(lines, [step.title.trim(), code].filter(Boolean), vars) ??
      asSentence(speakable(stepLabel(step.title).title))
    return [
      base,
      step.failed ? failureLine(step.error, copy) : "",
      wait ? copy.waitLines[wait] : "",
    ]
      .filter(Boolean)
      .join(" ")
  }

  function spokenSubject(subject: string): string {
    return speakable(subject)
      .replace(/^(?:(?:re|fwd?|aw|wg)\s*:\s*)+/i, "")
      .replace(/^[\s:–-]+/, "")
      .replace(featureCode, "")
      .trim()
  }

  function emailCode(step: string): string {
    return stepCode(step) || (featureLabel.exec(step)?.[0] ?? "")
  }

  function emailLine(
    lines: NarrationLines,
    card: MailCard,
    occurrence = 1,
  ): string {
    const code = emailCode(card.step)
    const keys = code
      ? [
          ...(occurrence > 1 ? [`${code}.email.${occurrence}`] : []),
          `${code}.email`,
        ]
      : []
    const own = curated(lines, keys)
    if (own) return own
    const subject = spokenSubject(card.subject)
    if (card.direction === "received") {
      return subject
        ? asSentence(copy.email.received(subject))
        : copy.email.received("")
    }
    if (/^\s*(?:\[[^\]]*\]\s*)*re\s*:/i.test(card.subject)) {
      return copy.email.reply
    }
    return subject ? asSentence(copy.email.sent(subject)) : copy.email.sent("")
  }

  const targetWord = (target: string) =>
    target === "staging" ? "staging" : "development"

  function tourCardLine(
    lines: NarrationLines,
    card: TourCardLine,
  ): string | null {
    switch (card.kind) {
      case "tour-intro":
        return copy.tour.intro(targetWord(card.target), card.count, card.areas)
      case "area-intro":
        return (
          curated(lines, ["area"], { COUNT: card.count }) ??
          asSentence(copy.tour.areaIntro(card.area, card.title, card.count))
        )
      case "area-chapter":
        return asSentence(copy.tour.areaChapter(card.area, card.title))
      case "feature": {
        const base =
          curated(lines, [card.id]) ??
          featureFallback(card.id, card.title, copy)
        if (card.card === "dev-only") return `${base} ${copy.tour.devOnly}`
        if (card.card === "view") return `${base} ${copy.tour.view}`
        if (card.card === "not-run") return `${base} ${copy.tour.notRun}`
        return base
      }
      case "area-scoreboard":
        if (card.page > 1) return null
        return (
          curated(lines, ["outro"], {
            COUNT: card.count,
            PASSED: card.passed,
            FAILED: card.failed,
          }) ??
          asSentence(copy.tour.areaOutro(card.area, card.passed, card.count))
        )
      case "tour-summary":
        return copy.tour.summary(card.passed, card.count, card.failed)
      case "tour-scoreboard":
        return card.page === 1 ? copy.tour.scoreboard : null
    }
  }

  function roundTripCardLine(
    lines: NarrationLines,
    kind: "intro" | "outro",
    vars: NarrationVars,
    verdict = "",
  ): string {
    const keys =
      kind === "outro" && verdict
        ? [`outro.${verdict.toLowerCase()}`, kind]
        : [kind]
    return (
      curated(lines, keys, vars) ??
      (kind === "intro"
        ? copy.roundTrip.intro
        : asSentence(copy.roundTrip.outro(vars.PASSED ?? 0, vars.COUNT ?? 0)))
    )
  }

  return {
    copy,
    unspeakableParts,
    speakable,
    fillPlaceholders,
    stepCode,
    defaultStepLine,
    curated,
    stepLine,
    spokenSubject,
    emailCode,
    emailLine,
    tourCardLine,
    roundTripCardLine,
  }
}
