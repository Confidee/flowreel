// SPDX-License-Identifier: Apache-2.0

import { chromium } from "@playwright/test"

import { FRAME, OUTPUT_SCALE } from "./geometry.js"

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

export async function renderPngs(jobs: PngJob[]): Promise<void> {
  const browser = await chromium.launch()
  try {
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
    await browser.close()
  }
}
