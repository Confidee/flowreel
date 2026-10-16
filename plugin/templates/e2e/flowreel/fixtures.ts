import { join } from "node:path"

import { requireStorageState } from "@confidee/flowreel/app"
import { currentRunId, fillRunId, jsonTexts } from "@confidee/flowreel/run"
import {
  VIDEO_LOG_ATTACHMENT,
  VideoLog,
  videoEnabled,
} from "@confidee/flowreel/video"
import { test as base } from "@playwright/test"

import { E2E_FLOWREEL, type PersonaKey } from "../../flowreel.config"

import { BRAND, videoKit } from "./brand"

// The `test` every flowreel flow builds on (the round trip directly, the
// tour through ./tour.ts): the recorded page starts signed in as `user`
// (the session global setup made; nothing here signs in), and its video's
// timing log feeds the branded run video. Flows import from here (or from
// ./tour.ts), never from @playwright/test.

/** Who the recorded page is signed in as (the tour's initial persona). */
export const SIGNED_IN_AS: PersonaKey = "user"

export interface FlowFixtures {
  /** The run video's timing log (mail cards: videoLog.mail(step, …)). */
  videoLog: VideoLog
}

export const test = base.extend<FlowFixtures>({
  // eslint-disable-next-line no-empty-pattern
  storageState: async ({}, use) => {
    await use(requireStorageState(SIGNED_IN_AS))
  },

  // eslint-disable-next-line no-empty-pattern
  videoLog: async ({}, use, testInfo) => {
    const log = new VideoLog()
    await use(log)
    // Teardown runs on failure too: a failing run is when the video helps.
    if (videoEnabled()) {
      await testInfo.attach(VIDEO_LOG_ATTACHMENT, {
        body: JSON.stringify(log.toJSON()),
        contentType: "application/json",
      })
    }
  },

  // The page video starts at its first painted frame: paint a standby card
  // at once, then anchor the video clock, so captions line up with the
  // picture.
  page: async ({ page, videoLog }, use) => {
    if (videoEnabled()) {
      try {
        await page.setContent(
          videoKit().cards.standbyHtml(BRAND.logos(), currentRunId()),
        )
        await page.evaluate(
          () =>
            new Promise<void>((done) =>
              requestAnimationFrame(() => requestAnimationFrame(() => done())),
            ),
        )
      } catch {
        // Video only: never fails the test.
      }
    }
    videoLog.markVideoStart()
    await use(page)
  },
})

export { expect } from "@playwright/test"

/** Every string the round trip types or sends (texts/smoke.json). */
const texts = jsonTexts(join(E2E_FLOWREEL, "texts", "smoke.json"))

/** A body text with {RUN_ID} filled in. */
export function text(key: string): string {
  return fillRunId(texts.raw("bodies", key), currentRunId())
}

/**
 * Records a fact for the summary (summary.json `facts`); a key starting
 * with "latency." is a hop latency in milliseconds.
 */
export function note(step: string, key: string, value: unknown): void {
  test.info().annotations.push({
    type: "qa",
    description: JSON.stringify({ step, key, value }),
  })
}

/** Something this run could not verify (the summary's "could not check"). */
export function couldNotCheck(step: string, reason: string): void {
  test.info().annotations.push({
    type: "could-not-check",
    description: `${step}: ${reason}`,
  })
}
