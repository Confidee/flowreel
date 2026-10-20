// SPDX-License-Identifier: Apache-2.0

import { chromium } from "@playwright/test"

import { FRAME, OUTPUT_SCALE } from "./geometry.js"
import { mediaSignal } from "./stop.js"

// Renders card/caption HTML to 1920x1080 PNGs (laid out at 1280x720, 1.5x).
// Runs in the reporter process after the
// tests, in its own browser and an UNRECORDED context: no recordVideo, no
// trace, no storageState, so nothing here can reach the evidence of the run
// and no session is involved.

export interface PngJob {
  html: string
  path: string
  /** Keep the page background transparent (overlays). */
  transparent?: boolean
}

/**
 * Renders each job to its PNG in one unrecorded browser context. A stopped
 * composition (mediaSignal) closes the browser, which ends the render with
 * an error; one stopped before it starts launches nothing.
 */
export async function renderPngs(jobs: PngJob[]): Promise<void> {
  const signal = mediaSignal()
  if (signal?.aborted) throw new Error("card rendering stopped")
  const browser = await chromium.launch()
  const stop = () => {
    browser.close().catch(() => undefined)
  }
  signal?.addEventListener("abort", stop, { once: true })
  try {
    if (signal?.aborted) throw new Error("card rendering stopped")
    const context = await browser.newContext({
      // Laid out at FRAME, painted at OUTPUT (Full HD) pixels.
      viewport: { width: FRAME.width, height: FRAME.height },
      deviceScaleFactor: OUTPUT_SCALE,
    })
    const page = await context.newPage()
    for (const job of jobs) {
      await page.setContent(job.html, { waitUntil: "load" })
      await page.screenshot({
        path: job.path,
        omitBackground: job.transparent ?? false,
      })
    }
    await context.close()
  } finally {
    signal?.removeEventListener("abort", stop)
    await browser.close()
  }
}
