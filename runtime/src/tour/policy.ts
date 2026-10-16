// SPDX-License-Identifier: Apache-2.0

import type { TargetName } from "../config/targets.js"
import { ConfigError } from "../core/errors.js"

// A feature's staging policy and the tour's pace.
//
// The policy is the project owner's decision per feature (the catalogue),
// applied only by feature():
//   both       development and staging, on QA-created objects;
//   both+undo  changes shared staging config, restored by the undo ledger;
//   dev        development only (staging: a "development only" skip);
//   view       staging renders the page read-only (ctx.mode "view").

export type Policy = "both" | "both+undo" | "dev" | "view"
export const POLICIES: Policy[] = ["both", "both+undo", "dev", "view"]

/** What a tour test passes to feature(): its catalogue id and policy. */
export interface FeatureOptions {
  /** The catalogue id, e.g. "A4". */
  id: string
  policy: Policy
  /** Required for `dev`: why the feature cannot run on staging. */
  devOnlyReason?: string
}

/** featureDecision()'s answer: skip (with its reason) or run in a mode. */
export interface FeatureDecision {
  /** The test.skip reason, or null when the feature runs. */
  skip: string | null
  mode: "full" | "view"
}

/** The skip-reason prefix of a development-only feature on staging. */
export const DEV_ONLY_PREFIX = "development only: "

/** What a feature does on `target`. */
export function featureDecision(
  options: FeatureOptions,
  target: TargetName,
  devOnlyPrefix: string = DEV_ONLY_PREFIX,
): FeatureDecision {
  if (!POLICIES.includes(options.policy)) {
    throw new ConfigError(
      `Feature ${options.id}: unknown policy ${JSON.stringify(options.policy)} (${POLICIES.join(", ")}).`,
    )
  }
  if (options.policy === "dev" && !options.devOnlyReason?.trim()) {
    throw new ConfigError(
      `Feature ${options.id}: a "dev" feature needs devOnlyReason (shown on staging).`,
    )
  }
  if (target === "local") return { skip: null, mode: "full" }
  if (options.policy === "dev") {
    return {
      skip: `${devOnlyPrefix}${options.devOnlyReason!.trim()}`,
      mode: "full",
    }
  }
  return { skip: null, mode: options.policy === "view" ? "view" : "full" }
}

// ---------------------------------------------------------------------------
// Pace
// ---------------------------------------------------------------------------

/** demo: readable (and narrated); qa: as fast as the app allows. */
export type Pace = "demo" | "qa"
export const PACES: Pace[] = ["demo", "qa"]

/**
 * "demo" (the default) or "qa", case-insensitive; `label` names the setting
 * in the error (FLOWREEL_PACE, a CLI flag, …).
 */
export function parsePace(
  raw: string | undefined,
  label = "FLOWREEL_PACE",
): Pace {
  const value = raw?.trim() ? raw.trim().toLowerCase() : "demo"
  if (value === "demo" || value === "qa") return value
  throw new ConfigError(
    `${label} must be "demo" or "qa" (got ${JSON.stringify(raw)}).`,
  )
}

/** Browser slowMo per pace: readable in demo, none in qa. */
export const PACE_SLOW_MO: Record<Pace, number> = { demo: 650, qa: 0 }
/** How long pause() holds after a key assertion. */
export const PACE_PAUSE_MS: Record<Pace, number> = { demo: 1800, qa: 0 }
