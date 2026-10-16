// SPDX-License-Identifier: Apache-2.0

// The video's geometry, shared by the card templates, the PNG renderer and
// the ffmpeg composer.

/**
 * The card layout space. Cards, captions and overlays are laid out in these
 * CSS pixels and rendered at OUTPUT_SCALE device pixels per CSS pixel, so the
 * MP4 is Full HD (OUTPUT) while every card keeps its proportions.
 */
export const FRAME = { width: 1280, height: 720 } as const
export const OUTPUT_SCALE = 1.5
export const OUTPUT = {
  width: FRAME.width * OUTPUT_SCALE,
  height: FRAME.height * OUTPUT_SCALE,
} as const

/**
 * Where the recording sits, in FRAME (layout) pixels: a 36 px brand strip
 * above it (logo watermark, top-right) and a 54 px caption bar below, so the
 * captions never cover the app's own controls.
 */
export const APP_RECT = { x: 80, y: 36, width: 1120, height: 630 } as const

/**
 * The recorded page's viewport and recording size: APP_RECT in output pixels
 * (1680x945), so the app gets the room of a 1680 px wide window and lands in
 * the 1920x1080 frame 1:1, never scaled.
 */
export const APP_VIEWPORT = {
  width: APP_RECT.width * OUTPUT_SCALE,
  height: APP_RECT.height * OUTPUT_SCALE,
} as const
