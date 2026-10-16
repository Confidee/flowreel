// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path"

import { requireStorageState } from "@confidee/flowreel/app"
import {
  type TextGroup,
  interpolateText,
  jsonTexts,
} from "@confidee/flowreel/run"
import {
  type FeatureContext,
  type FeatureOptions,
  type TourTestFixtures,
  type TourWorkerFixtures,
  declareFeature,
  swapPersona,
  tourFixtures,
} from "@confidee/flowreel/tour"
import {
  type StandbyText,
  VIDEO_LOG_ATTACHMENT,
  VideoLog,
  videoEnabled,
} from "@confidee/flowreel/video"
import { type Page, test as base } from "@playwright/test"

import { EXAMPLE_DIR, type PersonaKey } from "../../flowreel.config"

import type { NotesApi } from "./adapter"
import {
  INITIAL_PERSONA,
  NOTES_CARD_COPY,
  NOTES_TOUR,
  PERSONA_LABELS,
  TOUR_FIXTURES,
  currentRun,
  notesVideoKit,
} from "./tour"

// What every flow imports: `test` (Playwright's, extended with flowreel's
// tour fixtures and the recorded page), `expect`, feature() and text().
//
//   test("A1 create-note", async ({ appPage: page, pause }) => {
//     feature(test, { id: "A1", policy: "both" })
//     await test.step("A1.1 The notes list opens", async () => { … })
//   })
//
// No fixture signs in: every persona's session comes from global setup.

export interface NotesFixtures extends TourTestFixtures<PersonaKey, NotesApi> {
  /** What the recorded page shows before the first step. */
  standby: StandbyText
  runId: string
  /** The video anchor and the persona switches, attached for the reporter. */
  videoLog: VideoLog
  /** The recorded browser page, signed in as the editor. */
  appPage: Page
  /** Switches the RECORDED page to another persona (no sign-in). */
  asPersona: (page: Page, persona: PersonaKey) => Promise<void>
}

export const test = base.extend<
  NotesFixtures,
  TourWorkerFixtures<PersonaKey, NotesApi>
>({
  // pace, personaApis, the bounded session keepalive, undoLedger,
  // inboundBudget, as(persona), undo and pause().
  ...tourFixtures(TOUR_FIXTURES),

  standby: [NOTES_CARD_COPY.standby, { option: true }],

  // eslint-disable-next-line no-empty-pattern
  runId: async ({}, use) => {
    await use(TOUR_FIXTURES.runId())
  },

  // Every browser context opens as the editor (the session from setup).
  // eslint-disable-next-line no-empty-pattern
  storageState: async ({}, use) => {
    await use(requireStorageState(INITIAL_PERSONA))
  },

  // eslint-disable-next-line no-empty-pattern
  videoLog: async ({}, use, testInfo) => {
    const log = new VideoLog()
    await use(log)
    // Runs on failure too: a failing feature is when the video helps most.
    if (videoEnabled()) {
      await testInfo.attach(VIDEO_LOG_ATTACHMENT, {
        body: JSON.stringify(log.toJSON()),
        contentType: "application/json",
      })
    }
  },

  // The page video starts at its first painted frame: paint the standby
  // card, wait two animation frames, then anchor the captions' clock.
  appPage: async ({ page, videoLog, runId, standby }, use) => {
    if (videoEnabled()) {
      const kit = notesVideoKit()
      await page.setContent(
        kit.cards.standbyHtml(kit.brand.logos(), runId, standby),
      )
      await page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          ),
      )
    }
    videoLog.markVideoStart()
    await use(page)
  },

  asPersona: async ({ videoLog }, use) => {
    await use(async (page, persona) => {
      await swapPersona(page, requireStorageState(persona))
      videoLog.persona(PERSONA_LABELS[persona])
    })
  },
})

export { expect } from "@playwright/test"
export type { FeatureContext }

/**
 * Declares the running test as catalogue feature `options.id` and applies
 * its policy: call it FIRST in every feature test. The title must be
 * "<id> <slug>" and the policy the plan's; on staging a `dev` feature is
 * skipped as "development only: <reason>". The target is the run's, never
 * the flow's.
 */
export function feature(
  t: Pick<typeof test, "info" | "skip">,
  options: FeatureOptions,
): FeatureContext {
  return declareFeature(t, options, {
    target: currentRun().target,
    runId: TOUR_FIXTURES.runId,
    manifest: NOTES_TOUR,
    catalogue: {
      source: "e2e/flowreel/plans/tour-a.md",
      change: "the plan's catalogue table",
    },
  })
}

const TEXTS = jsonTexts(
  join(EXAMPLE_DIR, "e2e", "flowreel", "texts", "tour-a.json"),
)

/**
 * A string the flow types or sends, from texts/tour-a.json, with its
 * {PLACEHOLDERS} filled ({RUN_ID} always): every word a flow puts into the
 * app lives in that one file.
 */
export function text(
  group: TextGroup,
  key: string,
  vars: Record<string, string> = {},
): string {
  return interpolateText(TEXTS.raw(group, key), {
    RUN_ID: TOUR_FIXTURES.runId(),
    ...vars,
  })
}
