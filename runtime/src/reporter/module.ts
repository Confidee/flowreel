// SPDX-License-Identifier: Apache-2.0

import type { DemoArea, DemoFile } from "../demos/catalogue.js"

/** A run's verdict. The reporter reports it; it never decides an assertion. */
export type Verdict = "PASS" | "FAIL" | "N/A"

/**
 * A round-trip module: one gate test in one Playwright project (the release
 * gate). Its verdict rule: PASS only when the gate test passed; N/A when it
 * skipped with an "N/A:" reason (or did not run); FAIL on any failure
 * anywhere in the run. Its plan file's step table is the source of truth
 * for the step ids: every one appears in the summary, run or not.
 *
 * Latency labels are not here: the video's CardCopy owns them
 * (CardCopy.latencyLabels); summary.md lists the raw `latency.<key>` keys.
 */
export interface RoundTripModule {
  /** The discriminant SummaryReporterOptions.modules narrows on. */
  kind: "round-trip"
  /** The module name summary.json records. */
  name: string
  /** The Playwright project whose (single) test is the gate. */
  project: string
  /** The plan file whose step table lists every step id. */
  planFile?: string
  /**
   * Pulls the step ids out of the plan file (capture group 1; run as global
   * whatever its flags), e.g. /^\|\s*(S\d+ [^|]*?)\s*\|/gm for "| S1 send |"
   * rows.
   */
  planStepPattern?: RegExp
  /** The verdict sentences. */
  verdictCopy: {
    /** PASS: e.g. "Every round-trip step passed." */
    passed: string
    /** N/A when the gate project was not part of the run. */
    notInRun: string
    /** N/A when the gate test skipped without a reason. */
    skipped: string
  }
  /** The fixed demo file of this module's video in latest/. */
  demo?: DemoFile
}

/** A feature test's title, parsed: "A1 sign-up" → { id: "A1", slug: "sign-up" }. */
export interface FeatureTitle {
  id: string
  slug: string
}

/**
 * A feature step's title, parsed: "A1.2 The form accepts an email" →
 * { feature: "A1", n: 2, sentence: "The form accepts an email" }.
 */
export interface StepTitle {
  feature: string
  n: number
  sentence: string
}

/**
 * A feature-tour module: one feature test per area project, each starting
 * with feature(). Its verdict rule (when no round trip ran): FAIL on any
 * failed feature; PASS when at least one feature was verified (passed or
 * view-only) and none failed; N/A when nothing was verified.
 */
export interface TourModule {
  /** The discriminant SummaryReporterOptions.modules narrows on. */
  kind: "tour"
  /** The module name summary.json records. */
  name: string
  /**
   * Every project of the tour, its setup project included: tabulated in
   * the summary (never counted as another project's failure).
   */
  isProject(project: string): boolean
  /** The area (key) a feature project covers; null for a setup project. */
  areaOfProject(project: string): string | null
  /** A feature test's title as id + slug, or null when it is not one. */
  parseFeatureTitle(title: string): FeatureTitle | null
  /** A step title as feature + number + caption, or null when it is not one. */
  parseStepTitle(title: string): StepTitle | null
  /** The annotation type feature() records its policy under. */
  featureAnnotation: string
  /** The skip-reason prefix of a development-only feature. */
  devOnlyPrefix: string
  /** The area videos (and the full tour) in latest/. */
  demos?: { areas: DemoArea[]; fullTour: DemoFile }
}

/**
 * What the summary reporter (and the demos) need to know about one of a
 * project's modules, defined once. `kind` picks the verdict rule:
 * "round-trip" (the release gate) or "tour" (the feature tour).
 */
export type ModuleDescriptor = RoundTripModule | TourModule

/**
 * A project's modules split by kind: exactly one round trip (the gate) and
 * at most one tour. Throws naming the problem otherwise.
 */
export function modulesByKind(modules: readonly ModuleDescriptor[]): {
  roundTrip: RoundTripModule
  tour: TourModule | undefined
} {
  const roundTrips = modules.filter(
    (m): m is RoundTripModule => m.kind === "round-trip",
  )
  const tours = modules.filter((m): m is TourModule => m.kind === "tour")
  if (roundTrips.length !== 1) {
    throw new Error(
      `modules: expected exactly one "round-trip" module, got ${roundTrips.length}.`,
    )
  }
  if (tours.length > 1) {
    throw new Error(
      `modules: expected at most one "tour" module, got ${tours.length}.`,
    )
  }
  return { roundTrip: roundTrips[0], tour: tours[0] }
}

/** Step ids from a plan text, in order (empty without a pattern). */
export function planStepIds(module: RoundTripModule, plan: string): string[] {
  if (!module.planStepPattern) return []
  const flags = module.planStepPattern.flags.includes("g")
    ? module.planStepPattern.flags
    : `${module.planStepPattern.flags}g`
  const pattern = new RegExp(module.planStepPattern.source, flags)
  return [...plan.matchAll(pattern)].map((m) => m[1])
}
