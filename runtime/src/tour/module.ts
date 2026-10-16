// SPDX-License-Identifier: Apache-2.0

import type { TourModule } from "../reporter/module.js"

import { FEATURE_ANNOTATION, type FeatureRun } from "./feature.js"
import type { TourManifest } from "./manifest.js"
import { DEV_ONLY_PREFIX } from "./policy.js"

// The reporter's tour descriptor, built from the same source feature()
// writes with. feature() records its policy under FeatureRun.annotationType
// and skips a development-only feature with FeatureRun.devOnlyPrefix; the
// reporter classifies features by the same two strings and parses titles
// with the manifest. Building the TourModule here (never by hand) keeps the
// two from drifting: a customised prefix the reporter did not know would
// count dev-only skips as N/A, a customised annotation would lose features.

/**
 * Options for tourModuleFrom(): the module name and the same feature()
 * overrides, so the reporter and feature() never drift.
 */
export interface TourModuleOptions {
  /** The module name summary.json records. */
  name: string
  /**
   * The SAME annotationType / devOnlyPrefix overrides the project passes to
   * feature() (FeatureRun); defaults FEATURE_ANNOTATION / DEV_ONLY_PREFIX.
   */
  feature?: Pick<FeatureRun, "annotationType" | "devOnlyPrefix">
  /** The area videos (and the full tour) in latest/. */
  demos?: TourModule["demos"]
}

/** The reporter's TourModule for `manifest` (see the file comment). */
export function tourModuleFrom(
  manifest: Pick<
    TourManifest,
    "isTourProject" | "areaOfProject" | "parseFeatureTitle" | "parseStepTitle"
  >,
  options: TourModuleOptions,
): TourModule {
  return {
    kind: "tour",
    name: options.name,
    isProject: (project) => manifest.isTourProject(project),
    areaOfProject: (project) => manifest.areaOfProject(project)?.letter ?? null,
    parseFeatureTitle: (title) => manifest.parseFeatureTitle(title),
    parseStepTitle: (title) => manifest.parseStepTitle(title),
    featureAnnotation: options.feature?.annotationType ?? FEATURE_ANNOTATION,
    devOnlyPrefix: options.feature?.devOnlyPrefix ?? DEV_ONLY_PREFIX,
    ...(options.demos ? { demos: options.demos } : {}),
  }
}
