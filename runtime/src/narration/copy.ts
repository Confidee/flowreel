// SPDX-License-Identifier: Apache-2.0

import { defined } from "../core/defined.js"

/** Something a spoken line may never contain, and what to call it. */
export interface SpeakablePattern {
  name: string
  /**
   * What to remove. Every match is removed: a pattern given without the
   * global (g) flag is made global, and a sticky (y) flag is dropped, by
   * neverSpeakOf and defineNarrationCopy, so a missing flag can never let a
   * second match through.
   */
  pattern: RegExp
}

/**
 * The pattern as neverSpeakOf uses it: global (every match is removed) and
 * not sticky (a match anywhere counts). Returns the same object when it
 * already is.
 */
export function everyMatch(pattern: RegExp): RegExp {
  if (pattern.global && !pattern.sticky) return pattern
  const flags = pattern.flags.replace("y", "")
  return new RegExp(pattern.source, flags.includes("g") ? flags : `${flags}g`)
}

const everyMatchOf = (patterns: readonly SpeakablePattern[]) =>
  patterns.map((p) =>
    everyMatch(p.pattern) === p.pattern
      ? p
      : { ...p, pattern: everyMatch(p.pattern) },
  )

/** Why a step failed, as its spoken failure line names it (failureKind). */
export type FailureKind =
  "unfinished" | "timeout" | "unreachable" | "unexpected" | "refused" | "other"

/** Never spoken, in every project (checked first, in this order). */
export const BASE_NEVER_SPEAK: SpeakablePattern[] = [
  { name: "a QA subject prefix", pattern: /\[QA[^\]]*\]/gi },
  { name: "an email address", pattern: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g },
  { name: "a link", pattern: /\b(?:https?:\/\/|www\.)\S+/gi },
  { name: "a run id", pattern: /\b(?:loc|stg)-\d{8}-\d{4}-[0-9a-z]{2,}\b/gi },
]

/** The catch-all, checked last (after a project's own patterns). */
export const OPAQUE_TOKEN: SpeakablePattern = {
  name: "an opaque token",
  pattern:
    /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{16,}\b/g,
}

/**
 * What the narrated videos say when no curated line overrides it, and what
 * may never be said. {@link DEFAULT_NARRATION_COPY} is plain English with no
 * product in it; a project overrides its own words with
 * {@link defineNarrationCopy}, and adds its own never-speak patterns (record
 * numbers, internal ids) as `speakablePatterns`:
 *
 * ```ts
 * const narrationCopy = defineNarrationCopy({
 *   featureId: "[A-H]\\d{1,2}",
 *   speakablePatterns: [{ name: "an order number", pattern: /\bORD-\d+\b/g }],
 *   roundTrip: { intro: "This is the order round trip." },
 * })
 * ```
 */
export interface NarrationCopy {
  /**
   * The project's own never-speak patterns (record numbers and the like),
   * checked after BASE_NEVER_SPEAK and before OPAQUE_TOKEN.
   */
  speakablePatterns: SpeakablePattern[]
  /**
   * Spoken words for {NAME} placeholders in curated lines; a number given
   * at speaking time ({COUNT}) wins, an unknown name is said as "it".
   */
  placeholders: Record<string, string>
  /**
   * A feature id as a regular expression source, without anchors ("B12"):
   * an email card labelled "<id> …" files its line under it, and a spoken
   * subject drops a leading "<id>" or "<id>.<n>". It is anchored as a whole
   * (an alternation "AB|CD\\d" matches only at the start).
   */
  featureId: string
  /**
   * A feature card's line when no curated line exists, before it is made a
   * sentence; `words` is the feature's slug with - and _ as spaces.
   */
  featureFallback(id: string, words: string): string
  /** A failed step's added line; never the error text itself. */
  failure: {
    /** The short reason said for each kind of failure. */
    categories: Record<FailureKind, string>
    /** The line around a category ("This step failed: it timed out."). */
    line(category: string): string
  }
  email: {
    /** A received email, with its spoken subject ("" = none). */
    received(subject: string): string
    /** A sent reply ("Re: …"). */
    reply: string
    /** Any other sent email, with its spoken subject ("" = none). */
    sent(subject: string): string
  }
  /** A step with a long wait in it adds one of these. */
  waitLines: { email: string; other: string }
  /** The demo-pace wait badge's caption. */
  waitCaptions: { email: string; other: string }
  roundTrip: {
    /** The intro card when no curated "intro" line exists. */
    intro: string
    /** The outro card when no curated "outro" line exists. */
    outro(passed: number, count: number): string
  }
  /**
   * The tour's cards. A curated "area" / "outro" line (the area's file)
   * replaces areaIntro / areaOutro; the rest have no curated override.
   */
  tour: {
    /** The tour intro card ("development" / "staging"). */
    intro(target: string, count: number, areas: number): string
    /** An area intro card without a curated "area" line (made a sentence). */
    areaIntro(area: string, title: string, count: number): string
    /** The chapter card before an area's recordings (made a sentence). */
    areaChapter(area: string, title: string): string
    /** Added after a development-only feature's line on staging. */
    devOnly: string
    /** Added after a feature shown read-only on staging. */
    view: string
    /** Added after a feature that did not run. */
    notRun: string
    /** An area scoreboard without a curated "outro" line (made a sentence). */
    areaOutro(area: string, passed: number, count: number): string
    /** The tour summary card. */
    summary(passed: number, count: number, failed: number): string
    /** The full scoreboard's first page. */
    scoreboard: string
  }
  /** The development -> staging pipeline's own cards. */
  pipeline: {
    intro: string
    chapter(title: string, ran: boolean): string
    outro: string
  }
}

/** The neutral English narration every NarrationCopy starts from. */
export const DEFAULT_NARRATION_COPY: NarrationCopy = {
  speakablePatterns: [],
  placeholders: { RUN_ID: "this run" },
  featureId: "[A-Z]\\d{1,3}",
  featureFallback: (id, words) => `Feature ${id}: ${words}`,
  failure: {
    categories: {
      unfinished: "it did not finish",
      timeout: "it timed out",
      unreachable: "the server could not be reached",
      unexpected: "the page did not show what was expected",
      refused: "the app refused it",
      other: "an unexpected error",
    },
    line: (category) => `This step failed: ${category}.`,
  },
  email: {
    received: (subject) =>
      subject ? `An email arrives: ${subject}` : "An email arrives.",
    reply: "A reply is sent by email.",
    sent: (subject) =>
      subject ? `An email is sent: ${subject}` : "An email is sent.",
  },
  waitLines: {
    email: "Now we wait for the email to arrive.",
    other: "Now we wait for the app to finish.",
  },
  waitCaptions: {
    email: "Waiting for the email to arrive…",
    other: "Waiting…",
  },
  roundTrip: {
    intro: "This is the email round trip.",
    outro: (passed, count) => `${passed} of ${count} steps passed`,
  },
  tour: {
    intro: (target, count, areas) =>
      `This is the feature tour on ${target}: ${count} features in ${areas} ${areas === 1 ? "area" : "areas"}, each one recorded as a colleague would use it.`,
    areaIntro: (area, title, count) =>
      `Area ${area}: ${title}. ${count} features`,
    areaChapter: (area, title) => `Area ${area}: ${title}`,
    devOnly:
      "This one runs on development only, so it is not recorded on staging.",
    view: "On staging, the page is shown read-only.",
    notRun: "It did not run this time.",
    areaOutro: (area, passed, count) =>
      `That completes area ${area}: ${passed} of ${count} features passed`,
    summary: (passed, count, failed) =>
      failed > 0
        ? `That is the whole tour: ${passed} of ${count} features passed, and ${failed} failed.`
        : `That is the whole tour: ${passed} of ${count} features passed.`,
    scoreboard: "Here is every feature with its result and how long it took.",
  },
  pipeline: {
    intro:
      "This pipeline checks the same flow twice: first on development, then on staging, which runs only when development passes.",
    chapter: (title, ran) =>
      ran ? `${title}.` : `${title} did not run this time.`,
    outro: "Here are both stages side by side.",
  },
}

/**
 * Overrides for DEFAULT_NARRATION_COPY; nested groups merge field by field,
 * and a key given as `undefined` keeps its default.
 */
export interface NarrationCopyOptions extends Partial<
  Omit<
    NarrationCopy,
    | "email"
    | "failure"
    | "waitLines"
    | "waitCaptions"
    | "roundTrip"
    | "tour"
    | "pipeline"
  >
> {
  failure?: Partial<Omit<NarrationCopy["failure"], "categories">> & {
    categories?: Partial<NarrationCopy["failure"]["categories"]>
  }
  email?: Partial<NarrationCopy["email"]>
  waitLines?: Partial<NarrationCopy["waitLines"]>
  waitCaptions?: Partial<NarrationCopy["waitCaptions"]>
  roundTrip?: Partial<NarrationCopy["roundTrip"]>
  tour?: Partial<NarrationCopy["tour"]>
  pipeline?: Partial<NarrationCopy["pipeline"]>
}

/**
 * A complete NarrationCopy: `base` (the neutral English defaults) with the
 * given overrides; nested groups merge field by field, and an override
 * given as `undefined` keeps the default. Every speakablePatterns entry is
 * made global (everyMatch).
 */
export function defineNarrationCopy(
  options: NarrationCopyOptions = {},
  base: NarrationCopy = DEFAULT_NARRATION_COPY,
): NarrationCopy {
  const o = defined(options)
  const failure = defined(o.failure)
  return {
    ...base,
    ...o,
    speakablePatterns: everyMatchOf(
      o.speakablePatterns ?? base.speakablePatterns,
    ),
    placeholders: { ...base.placeholders, ...defined(o.placeholders) },
    failure: {
      ...base.failure,
      ...failure,
      categories: {
        ...base.failure.categories,
        ...defined(failure.categories),
      },
    },
    email: { ...base.email, ...defined(o.email) },
    waitLines: { ...base.waitLines, ...defined(o.waitLines) },
    waitCaptions: { ...base.waitCaptions, ...defined(o.waitCaptions) },
    roundTrip: { ...base.roundTrip, ...defined(o.roundTrip) },
    tour: { ...base.tour, ...defined(o.tour) },
    pipeline: { ...base.pipeline, ...defined(o.pipeline) },
  }
}

/**
 * Every never-speak pattern in checking order for this copy, each one
 * global (everyMatch), so a copy built without defineNarrationCopy is safe
 * too.
 */
export const neverSpeakOf = (
  copy: Pick<NarrationCopy, "speakablePatterns">,
): SpeakablePattern[] => [
  ...BASE_NEVER_SPEAK,
  ...everyMatchOf(copy.speakablePatterns),
  OPAQUE_TOKEN,
]
