// SPDX-License-Identifier: Apache-2.0

import type { TargetName } from "../config/targets.js"
import { ConfigError } from "../core/errors.js"

import {
  type CataloguePolicyOptions,
  assertCataloguePolicy,
} from "./catalogue.js"
import type { TourManifest } from "./manifest.js"
import {
  DEV_ONLY_PREFIX,
  type FeatureOptions,
  featureDecision,
} from "./policy.js"

// feature(): the first call of every tour test. It declares the running
// test as catalogue feature `options.id` and applies its staging policy: on
// staging a `dev` feature is skipped as "development only: <reason>"
// (counted dev-only, never FAIL), a `view` feature gets mode "view". The
// test title must be "<id> <slug>" with the catalogue's slug, and the
// policy must be the catalogue's. The target always comes from the run's
// config: a flow cannot choose it. The annotation it records is what the
// reporter and the videos read.

/** The annotation type feature() records (the reporter reads it). */
export const FEATURE_ANNOTATION = "tour-feature"

/**
 * What feature() returns to the test: its id, policy, target, mode and
 * run id. A `view` feature on staging gets mode "view" and must not write.
 */
export interface FeatureContext {
  id: string
  policy: FeatureOptions["policy"]
  target: TargetName
  /** "view" on staging for a `view` feature: render, never write. */
  mode: "full" | "view"
  runId: string
}

/** The slice of Playwright's `test` that feature() uses. */
export interface FeatureTest {
  info(): {
    title: string
    annotations: { type: string; description?: string }[]
  }
  skip(condition: boolean, description: string): void
}

/**
 * The run-level inputs feature() needs, supplied by the project's tour
 * fixture: the target (from config, never the flow), the run id and the
 * manifest, plus the annotation strings shared with tourModuleFrom().
 */
export interface FeatureRun {
  target: TargetName
  /** Read after the policy is applied (a skipped feature never asks). */
  runId: () => string
  manifest: Pick<TourManifest, "catalogue" | "parseFeatureTitle">
  /**
   * Default FEATURE_ANNOTATION. Pass the same value to tourModuleFrom() so
   * the reporter reads what feature() writes.
   */
  annotationType?: string
  /** Default DEV_ONLY_PREFIX (same rule: pass it to tourModuleFrom() too). */
  devOnlyPrefix?: string
  /** Wording of the catalogue refusals. */
  catalogue?: CataloguePolicyOptions
  /** Appended to the title refusal, e.g. a reference to the plan. */
  titleReference?: string
}

/** Declares the running test as a catalogue feature; see the file comment. */
export function declareFeature(
  t: FeatureTest,
  options: FeatureOptions,
  run: FeatureRun,
): FeatureContext {
  const info = t.info()
  const parsed = run.manifest.parseFeatureTitle(info.title)
  if (parsed?.id !== options.id) {
    throw new ConfigError(
      `feature(): the test title "${info.title}" must be "${options.id} <slug>"${run.titleReference ? ` (${run.titleReference})` : ""}.`,
    )
  }
  const entry = assertCataloguePolicy(
    options,
    run.manifest.catalogue,
    run.catalogue,
  )
  if (parsed.slug !== entry.slug) {
    throw new ConfigError(
      `feature(): the test title "${info.title}" must be "${options.id} ${entry.slug}" (the catalogue's slug).`,
    )
  }
  const decision = featureDecision(
    options,
    run.target,
    run.devOnlyPrefix ?? DEV_ONLY_PREFIX,
  )
  const annotation = {
    id: options.id,
    policy: options.policy,
    devOnlyReason: options.devOnlyReason?.trim()
      ? options.devOnlyReason.trim()
      : null,
    mode: decision.mode,
  }
  info.annotations.push({
    type: run.annotationType ?? FEATURE_ANNOTATION,
    description: JSON.stringify(annotation),
  })
  if (decision.skip) t.skip(true, decision.skip)
  return {
    id: options.id,
    policy: options.policy,
    target: run.target,
    mode: decision.mode,
    runId: run.runId(),
  }
}
