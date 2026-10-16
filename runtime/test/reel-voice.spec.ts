// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "@playwright/test"

import type { MailCard } from "../src/video/recorder.js"
import {
  type ReelCopy,
  reelTexts,
  segmentBadges,
} from "../src/video/reel-voice.js"
import type { Caption, Segment } from "../src/video/timeline.js"

// The reel narration mechanism with the project's copy injected: which line
// each caption and card gets, and which badge each app segment gets. (The
// harness binding is tested with its own copy where that copy lives.)

const copy: ReelCopy = {
  stepLine: (lines, step, wait) =>
    `${lines[step.title] ?? step.title}${step.failed ? " (failed)" : ""}${wait ? ` [wait:${wait}]` : ""}`,
  emailLine: (_lines, card, occurrence) => `${card.step}#${occurrence}`,
  speedBadge: (speed) => `<speed ${speed}>`,
  waitBadge: (kind) => `<wait ${kind}>`,
}

const card = (step: string): MailCard => ({
  step,
  direction: "received",
  from: "a@example.test",
  to: ["b@example.test"],
  replyTo: [],
  subject: "s",
  excerpt: "e",
})

test("captions use stepLine (with the wait kind); cards count occurrences", () => {
  const segments: Segment[] = [
    { kind: "app", fromSec: 0, toSec: 5, speed: 1, durationSec: 5, wait: true },
    { kind: "email", mail: 0, durationSec: 3 },
  ]
  const captions: Caption[] = [
    { step: 0, fromSec: 0, toSec: 5 },
    { step: 7, fromSec: 5, toSec: 6 },
  ]
  const timeline = { segments, captions }
  const texts = reelTexts(
    timeline,
    [{ id: "S1 open", failed: true, error: "x" }],
    [card("S2 mail"), card("S2 mail"), card("S3 mail")],
    { "S1 open": "Opening" },
    copy,
  )
  expect(texts.captions).toEqual(["Opening (failed) [wait:email]", null])
  expect(texts.mail).toEqual(["S2 mail#1", "S2 mail#2", "S3 mail#1"])
})

test("badges: speed for fast-forwarded pieces, wait kind from what follows", () => {
  const app = (fromSec: number, toSec: number, speed: number, wait = false) =>
    ({
      kind: "app",
      fromSec,
      toSec,
      speed,
      durationSec: (toSec - fromSec) / speed,
      ...(wait ? { wait: true as const } : {}),
    }) satisfies Segment
  const timeline: { segments: Segment[] } = {
    segments: [
      app(0, 4, 3),
      app(4, 9, 1, true),
      app(9, 12, 1, true),
      { kind: "email", mail: 0, durationSec: 3 },
      app(12, 20, 1, true),
    ],
  }
  expect(segmentBadges(timeline, copy)).toEqual([
    { index: 0, html: "<speed 3>" },
    { index: 1, html: "<wait email>" },
    { index: 2, html: "<wait email>" },
    { index: 4, html: "<wait other>" },
  ])
})
