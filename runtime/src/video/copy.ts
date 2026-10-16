// SPDX-License-Identifier: Apache-2.0

import { defined } from "../core/defined.js"
import type { FeatureStatus } from "../reporter/status.js"
import type { Policy } from "../tour/policy.js"

/** What the recorded page shows before the first step (the video anchor). */
export interface StandbyText {
  heading: string
  line: string
}

/**
 * What the video cards say: every visible word of the intro, email, outro,
 * caption, frame, badge, pipeline and tour cards. {@link DEFAULT_CARD_COPY}
 * is plain English with no product in it; a project overrides what it names
 * differently (its run's title, its step titles, its latency labels) with
 * {@link defineCardCopy}:
 *
 * ```ts
 * const copy = defineCardCopy({
 *   run: { title: "Order round trip" },
 *   stepTitles: { "T1 inbound": "A customer emails support" },
 *   latencyLabels: { sendToOrderMs: "Email to order" },
 * })
 * ```
 *
 * Fields documented as HTML are inserted as they are: escape anything
 * interpolated into them (the arguments they receive are already escaped).
 */
export interface CardCopy {
  /**
   * Step id -> its plain-language caption title. A step id not listed is
   * split by `stepCode` into its code and the sentence after it.
   */
  stepTitles: Record<string, string>
  /**
   * The step code at the start of a step id ("A4.1 Search finds …" ->
   * "A4.1"); must be anchored at the start. No match = no code. It is used
   * statelessly: defineCardCopy and createCards drop a global (g) or sticky
   * (y) flag, which would make each match start where the last one ended.
   */
  stepCode: RegExp
  /** The single-flow run video (intro, frame, outro). */
  run: {
    /** The intro's heading and the frame's label. */
    title: string
    /** The intro's subtitle by target. */
    subtitle: { staging: string; local: string }
    /** The intro's target pill by target. */
    target: { staging: string; local: string }
  }
  /** The default standby page text. */
  standby: StandbyText
  mail: {
    /** The badge of a mail card whose step has no code. */
    code: string
    sent: string
    received: string
    fields: { from: string; to: string; replyTo: string; subject: string }
    /** Under every mail card. */
    note: string
  }
  caption: {
    /** The badge of a caption whose step has no code. */
    code: string
    passed: string
    failed: string
  }
  outro: {
    /** The heading over the latency list. */
    latencies: string
    noSteps: string
  }
  /** Latency key -> label; a key not listed shows as it is. */
  latencyLabels: Record<string, string>
  /** HTML: the fast-forward badge ("played 4× faster"). */
  speedBadge(speed: number): string
  /** HTML: the demo-pace wait badge around an escaped caption. */
  waitBadge(escapedText: string): string
  pipeline: {
    /** HTML: the pipeline intro's heading for an escaped module label. */
    heading(escapedModule: string): string
    /** "Stage 1" (n counts from 1). */
    stage(n: number): string
    /** The comparison table's step column. */
    step: string
  }
  tour: {
    /** The tour intro's heading and the tour summary's heading. */
    title: string
    /** The frame label before a feature's id and title. */
    frameLabel: string
    /** The area intro's kicker (the chapter card says `area`). */
    areaKicker: string
    /** "Area" (chapter kicker, "Area B" on a feature card). */
    area: string
    /** "3 features" */
    features(n: number): string
    /** The target pill (intro) by target. */
    targetPill: { staging: string; development: string }
    /** The target as a word (pills, subheadings). */
    targetName: { staging: string; development: string }
    pace: { demo: string; qa: string }
    /** A feature's staging policy, as its title card names it. */
    policies: Record<Policy, string>
    statuses: Record<FeatureStatus, string>
    devOnly: string
    view: { head: string; text: string }
    notRun: string
    /** The persona badge's prefix ("as agent"). */
    persona: string
    /** The scoreboard's feature column. */
    feature: string
    noFeatures: string
    page(n: number, of: number): string
    /** An area scoreboard's heading. */
    areaHeading(letter: string, title: string): string
    /** A tour summary row ("Listing · 3/4 verified"). */
    areaSummary(title: string, verified: number, of: number): string
    /** The full scoreboard's heading. */
    everyFeature: string
    /** The combined tour scoreboard's heading. */
    comparison: string
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/** The neutral English card copy every CardCopy starts from. */
export const DEFAULT_CARD_COPY: CardCopy = {
  stepTitles: {},
  stepCode: /^[A-Z]\d{1,3}(?:\.\d{1,3})?(?=\s|$)/,
  run: {
    title: "Round trip",
    subtitle: { staging: "Staging", local: "Local dry-run" },
    target: { staging: "STAGING", local: "LOCAL" },
  },
  standby: {
    heading: "Recorded browser",
    line: "Waiting for the first step…",
  },
  mail: {
    code: "Mail",
    sent: "Email sent",
    received: "Email received",
    fields: { from: "From", to: "To", replyTo: "Reply-To", subject: "Subject" },
    note: "Reply tokens and links are redacted.",
  },
  caption: { code: "Step", passed: "Passed", failed: "Failed" },
  outro: { latencies: "Latencies", noSteps: "No steps ran." },
  latencyLabels: {},
  speedBadge: (speed) =>
    `&#9193; waiting, played ${String(Math.round(speed))}&times; faster`,
  waitBadge: (text) => `&#8987; ${text}`,
  pipeline: {
    heading: (module) => `${module}: development &rarr; staging`,
    stage: (n) => `Stage ${n}`,
    step: "Step",
  },
  tour: {
    title: "Feature tour",
    frameLabel: "Tour",
    areaKicker: "Feature tour · area",
    area: "Area",
    features: (n) => plural(n, "feature"),
    targetPill: { staging: "STAGING", development: "DEVELOPMENT" },
    targetName: { staging: "Staging", development: "Development" },
    pace: { demo: "Demo pace", qa: "QA pace" },
    policies: {
      both: "Development + staging",
      "both+undo": "Development + staging · restored",
      dev: "Development only",
      view: "Staging read-only",
    },
    statuses: {
      passed: "Passed",
      failed: "Failed",
      "dev-only": "Dev only",
      "view-only": "View only",
      "N/A": "N/A",
      "not run": "Not run",
    },
    devOnly: "Development only",
    view: {
      head: "Read-only on staging",
      text: "The page is shown without making any change.",
    },
    notRun: "Not run",
    persona: "as",
    feature: "Feature",
    noFeatures: "No features ran.",
    page: (n, of) => `Page ${n} of ${of}`,
    areaHeading: (letter, title) => `Area ${letter}: ${title}`,
    areaSummary: (title, verified, of) =>
      `${title} · ${verified}/${of} verified`,
    everyFeature: "Every feature",
    comparison: "Development vs staging",
  },
}

/**
 * Overrides for DEFAULT_CARD_COPY; nested groups merge field by field, and
 * a key given as `undefined` keeps its default.
 */
export interface CardCopyOptions extends Partial<
  Omit<
    CardCopy,
    "run" | "standby" | "mail" | "caption" | "outro" | "pipeline" | "tour"
  >
> {
  run?: Partial<CardCopy["run"]>
  standby?: Partial<StandbyText>
  mail?: Partial<Omit<CardCopy["mail"], "fields">> & {
    fields?: Partial<CardCopy["mail"]["fields"]>
  }
  caption?: Partial<CardCopy["caption"]>
  outro?: Partial<CardCopy["outro"]>
  pipeline?: Partial<CardCopy["pipeline"]>
  tour?: Partial<Omit<CardCopy["tour"], "policies" | "statuses" | "view">> & {
    policies?: Partial<CardCopy["tour"]["policies"]>
    statuses?: Partial<CardCopy["tour"]["statuses"]>
    view?: Partial<CardCopy["tour"]["view"]>
  }
}

/**
 * The regular expression without a global (g) or sticky (y) flag, so exec()
 * keeps no position between calls. Returns the same object when it has
 * neither.
 */
export function stateless(pattern: RegExp): RegExp {
  if (!pattern.global && !pattern.sticky) return pattern
  return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ""))
}

/**
 * A complete CardCopy: `base` (the neutral English DEFAULT_CARD_COPY) with
 * the given overrides; nested groups merge field by field, an override
 * given as `undefined` keeps the default, and stepCode is made stateless.
 */
export function defineCardCopy(
  options: CardCopyOptions = {},
  base: CardCopy = DEFAULT_CARD_COPY,
): CardCopy {
  const o = defined(options)
  const tour = defined(o.tour)
  return {
    ...base,
    ...o,
    stepCode: stateless(o.stepCode ?? base.stepCode),
    run: { ...base.run, ...defined(o.run) },
    standby: { ...base.standby, ...defined(o.standby) },
    mail: {
      ...base.mail,
      ...defined(o.mail),
      fields: { ...base.mail.fields, ...defined(o.mail?.fields) },
    },
    caption: { ...base.caption, ...defined(o.caption) },
    outro: { ...base.outro, ...defined(o.outro) },
    pipeline: { ...base.pipeline, ...defined(o.pipeline) },
    tour: {
      ...base.tour,
      ...tour,
      policies: { ...base.tour.policies, ...defined(tour.policies) },
      statuses: { ...base.tour.statuses, ...defined(tour.statuses) },
      view: { ...base.tour.view, ...defined(tour.view) },
    },
  }
}
