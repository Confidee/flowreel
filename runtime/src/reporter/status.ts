// SPDX-License-Identifier: Apache-2.0

import type { Location, TestResult, TestStep } from "@playwright/test/reporter"

import { DEV_ONLY_PREFIX, type Policy } from "../tour/policy.js"

import type { Verdict } from "./module.js"

// The reporter's pure rules: a step's outcome, where a failed step's line
// points, a tour feature's status from its result, the tour's verdict and
// summary.md's feature table. Unit-tested; the reporter only reports.

/** A feature's outcome as the tables and the videos show it. */
export type FeatureStatus =
  "passed" | "failed" | "dev-only" | "view-only" | "N/A" | "not run"

/** How feature() ran a feature: everything, or read-only on staging. */
export type FeatureMode = "full" | "view"

/** The annotation feature() records (the reporter and the videos read it). */
export interface FeatureAnnotation {
  id: string
  /** As feature() recorded it (parseFeatureAnnotation checks only that it is a string). */
  policy: Policy
  devOnlyReason: string | null
  mode: FeatureMode
}

/**
 * The default skip-reason prefix of a development-only feature: the one
 * feature() skips with (tour/policy.ts), never a copy of it.
 */
export const DEFAULT_DEV_ONLY_PREFIX = DEV_ONLY_PREFIX

/** The Playwright result statuses that count as a failure. */
export const FAILED_STATUSES: ReadonlySet<string> = new Set([
  "failed",
  "timedOut",
  "interrupted",
])

/**
 * A tour feature's status from its result: failed; dev-only (skipped with
 * the development-only prefix); N/A (any other skip); view-only (ran
 * read-only on staging); passed. A test that did not record its policy
 * through feature() (no / unparsable annotation) is FAILED whenever it
 * started: its policy was never applied, so on staging a development-only
 * flow may have run. Only a test that never started (a failed dependency,
 * an interrupted run: skipped with no reason) is "not run".
 */
export function featureStatus(
  resultStatus: string,
  skipReason: string | null,
  annotation: Pick<FeatureAnnotation, "mode"> | null,
  target: string,
  devOnlyPrefix: string = DEFAULT_DEV_ONLY_PREFIX,
): FeatureStatus {
  if (FAILED_STATUSES.has(resultStatus)) return "failed"
  if (!annotation) {
    return resultStatus === "skipped" && !skipReason ? "not run" : "failed"
  }
  if (resultStatus === "skipped") {
    return skipReason?.startsWith(devOnlyPrefix) ? "dev-only" : "N/A"
  }
  if (resultStatus !== "passed") return "not run"
  return target === "staging" && annotation?.mode === "view"
    ? "view-only"
    : "passed"
}

/** Why a feature without a recorded policy failed (summary.md's note). */
export const NO_FEATURE_REASON =
  "did not call feature() first: no staging policy was recorded or applied"

/**
 * The feature annotation feature() records, or null when it is missing or
 * not a well-formed record (then the policy was never applied).
 */
export function parseFeatureAnnotation(
  description: string | undefined,
): FeatureAnnotation | null {
  if (!description) return null
  try {
    const value = JSON.parse(description) as Partial<FeatureAnnotation>
    return typeof value.id === "string" &&
      typeof value.policy === "string" &&
      (value.mode === "full" || value.mode === "view")
      ? (value as FeatureAnnotation)
      : null
  } catch {
    return null
  }
}

/**
 * The tour's verdict when no round trip ran: FAIL on any failed feature;
 * PASS when at least one feature was verified (passed or view-only) and none
 * failed; N/A when nothing was verified (every feature dev-only / skipped).
 */
export function tourVerdict(
  features: { status: FeatureStatus; id: string }[],
): {
  verdict: Verdict
  reason: string
} {
  const failed = features.filter((f) => f.status === "failed")
  if (failed.length > 0) {
    return {
      verdict: "FAIL",
      reason: `Failed: ${failed.map((f) => f.id).join(", ")}.`,
    }
  }
  const verified = features.filter(
    (f) => f.status === "passed" || f.status === "view-only",
  )
  if (verified.length === 0) {
    return {
      verdict: "N/A",
      reason:
        features.length === 0
          ? "No tour feature ran."
          : "No tour feature was verified on this target (all development-only or skipped).",
    }
  }
  const devOnly = features.filter((f) => f.status === "dev-only").length
  return {
    verdict: "PASS",
    reason: `${verified.length} tour feature(s) verified${devOnly ? `, ${devOnly} development-only` : ""}.`,
  }
}

/** The most precise location of a failed step: its error, else a failing child. */
function failureLocation(step: TestStep): Location | undefined {
  if (step.error?.location) return step.error.location
  for (const child of step.steps) {
    if (child.error) return failureLocation(child) ?? child.location
  }
  return step.location
}

/**
 * Where a failed step's summary line points. The deeper failure location only
 * when it is in the step's own spec file (an `expect` line); a waiter's
 * TimeoutError is located in a library file, and the problem matcher must
 * land on the step, so that case falls back to the step itself.
 */
export function stepFailureLocation(step: TestStep): Location | undefined {
  const deeper = failureLocation(step)
  if (!step.location || deeper?.file === step.location.file) return deeper
  return step.location
}

/**
 * A step's outcome as the table and the video show it. A test-level timeout
 * (or an interrupt) leaves the step that was running with `duration === -1`
 * and no `error`: on a failed result that open step is the one that failed,
 * and it lasted until the test ended.
 */
export function stepOutcome(
  step: Pick<TestStep, "duration" | "error" | "startTime">,
  result: Pick<TestResult, "duration" | "startTime" | "status">,
): { failed: boolean; open: boolean; durationMs: number } {
  const open = step.duration < 0
  return {
    failed: !!step.error || (open && FAILED_STATUSES.has(result.status)),
    open,
    durationMs: open
      ? Math.max(
          0,
          result.startTime.getTime() +
            result.duration -
            step.startTime.getTime(),
        )
      : step.duration,
  }
}

/** One tour feature in summary.json / summary.md. */
export interface FeatureRow {
  id: string
  title: string
  area: string
  policy: string | null
  status: FeatureStatus
  reason: string | null
  durationMs: number | null
  /** Where the feature starts in the tour MP4 (seconds); null = no video. */
  videoAtSec: number | null
  file: string
  line: number
}

/** summary.json's tour video section. */
export type TourVideoSummary =
  | {
      produced: true
      tour: { path: string; file: string; durationSec: number }
      areas: { area: string; path: string; file: string; durationSec: number }[]
    }
  | { produced: false; reason: string }

/** A table cell: no pipes, no newlines. */
export function cell(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value)
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ")
}

/** "12.3s", or "—" when unknown. */
export function duration(ms: number | null): string {
  return ms === null ? "—" : `${(ms / 1000).toFixed(1)}s`
}

const clock = (sec: number | null) =>
  sec === null
    ? "—"
    : `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`

/** summary.md's feature table. */
export function featureTable(
  features: FeatureRow[],
  tourVideo: TourVideoSummary | null,
): string[] {
  const out = ["## Tour features", ""]
  if (tourVideo?.produced) {
    out.push(
      `Tour video: [${tourVideo.tour.file}](${encodeURI(tourVideo.tour.file)}) (${tourVideo.tour.durationSec.toFixed(1)}s). Areas: ${tourVideo.areas
        .map((a) => `[${a.area}](${encodeURI(a.file)})`)
        .join(", ")}.`,
      "",
    )
  } else if (tourVideo) {
    out.push(`Tour video: not produced (${cell(tourVideo.reason)}).`, "")
  }
  out.push(
    "| Feature | Title | Area | Status | Duration | Video at | Note |",
    "|---|---|---|---|---|---|---|",
    ...features.map(
      (f) =>
        `| ${f.id} | ${cell(f.title)} | ${f.area} | ${f.status} | ${duration(f.durationMs)} | ${clock(f.videoAtSec)} | ${cell(f.reason ?? "")} |`,
    ),
  )
  return out
}
