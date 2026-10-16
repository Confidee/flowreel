import { join } from "node:path"

import { type StorageState, requireStorageState } from "@confidee/flowreel/app"
import { resultsDir } from "@confidee/flowreel/config"
import { envName, envValue, fileUndoStore } from "@confidee/flowreel/core"
import {
  type TextGroup,
  currentRunId,
  interpolateText,
  jsonTexts,
} from "@confidee/flowreel/run"
import {
  type CatalogueEntry,
  type FeatureContext,
  type FeatureOptions,
  type FeatureTest,
  InboundMailBudget,
  type TourArea,
  declareFeature,
  defineTourManifest,
  fileBudgetStore,
  parsePace,
  tourFixtures,
} from "@confidee/flowreel/tour"
import type { APIRequestContext } from "@playwright/test"

import { E2E_FLOWREEL, type PersonaKey, flowreel } from "../../flowreel.config"

import { appAdapter, loadRun } from "./adapter"
import { SIGNED_IN_AS, test as base } from "./fixtures"

// The feature tour: areas (one Playwright project each, behind the
// tour-setup project), the feature catalogue mirror, feature(), the
// tour's `test` and areaText(). Flows import `test`, `expect`, `feature`
// and `areaText` from here, never from @playwright/test.

/** The tour's areas: one capital letter each, in catalogue order. */
export const TOUR_AREAS: readonly TourArea[] = [
  // TODO(flowreel): one entry per area of your catalogue.
  { letter: "A", slug: "example", title: "Getting around" },
]

/**
 * The committed mirror of the catalogue (e2e/flowreel/CATALOGUE.md): every
 * feature's slug and owner-approved staging policy. feature() refuses a
 * test whose id, slug or policy differs. Change the catalogue first, then
 * this mirror, never a flow alone.
 */
export const TOUR_CATALOGUE: Readonly<Record<string, CatalogueEntry>> = {
  A1: { slug: "home-page", policy: "both" },
}

export const TOUR = defineTourManifest({
  areas: TOUR_AREAS,
  setupProject: "tour-setup",
  catalogue: TOUR_CATALOGUE,
})

/** Who the recorded page is signed in as (./fixtures.ts). */
export const INITIAL_PERSONA: PersonaKey = SIGNED_IN_AS

const stateFor = (persona: PersonaKey): StorageState =>
  requireStorageState(persona, {
    message: (p, variable) =>
      `The ${p} persona is not signed in for this run (${variable} unset): configure it for this target, or make the feature development-only.`,
  })

let run: ReturnType<typeof loadRun> | undefined
const config = () => (run ??= loadRun())

/**
 * The tour's test: the shared flow fixtures (signed-in recorded page, video
 * log) plus flowreel's tour fixtures (pace, personas, undo, budget).
 */
export const test = base.extend(
  tourFixtures<PersonaKey, APIRequestContext>({
    personas: flowreel.personas,
    baseURL: () => config().baseURL,
    runId: () => currentRunId(),
    pace: () =>
      parsePace(envValue(process.env, "PACE"), envName(process.env, "PACE")),
    stateFor,
    // A persona's client: its signed-in request context. Wrap it in your
    // own API client if your flows set up data off camera.
    client: (context) => context,
    undoStore: (runId) => fileUndoStore(resultsDir(flowreel, runId), runId),
    inboundBudget: (runId) =>
      new InboundMailBudget(
        fileBudgetStore(join(resultsDir(flowreel, runId), "inbound-mail.json")),
        config().target,
      ),
    featureKey: (info) => TOUR.parseFeatureTitle(info.title)?.id ?? info.title,
    app: appAdapter,
  }),
)

export { expect } from "@playwright/test"

/**
 * The FIRST call of every tour test: declares it as catalogue feature
 * `options.id` and applies its staging policy (a `dev` feature is skipped on
 * staging, a `view` feature gets mode "view").
 */
export function feature(
  t: FeatureTest,
  options: FeatureOptions,
): FeatureContext {
  return declareFeature(t, options, {
    target: config().target,
    runId: () => currentRunId(),
    manifest: TOUR,
    catalogue: {
      source: "e2e/flowreel/tour.ts TOUR_CATALOGUE",
      change: "e2e/flowreel/CATALOGUE.md",
    },
    titleReference: "see e2e/flowreel/plans/tour-<area>.md",
  })
}

const areaTexts = new Map<string, ReturnType<typeof jsonTexts>>()

/**
 * A string tour area `letter` types or sends, from texts/tour-<letter>.json
 * (`group` "bodies" by default, or "subjects"): {RUN_ID} is filled in, and
 * any other {NAME} must be in `vars` (an unknown placeholder throws, so a
 * typo never reaches the app).
 */
export function areaText(
  letter: string,
  key: string,
  vars: Record<string, string> = {},
  group: TextGroup = "bodies",
): string {
  const name = `tour-${letter.toLowerCase()}`
  let texts = areaTexts.get(name)
  if (!texts) {
    texts = jsonTexts(join(E2E_FLOWREEL, "texts", `${name}.json`))
    areaTexts.set(name, texts)
  }
  return interpolateText(texts.raw(group, key), {
    RUN_ID: currentRunId(),
    ...vars,
  })
}
