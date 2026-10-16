// SPDX-License-Identifier: Apache-2.0

import type { NarrationLines, Narrator } from "../voice/narrator.js"

import type { AudioTrack } from "./ffmpeg.js"
import type { MailCard } from "./recorder.js"
import {
  type NarrationCue,
  type Timeline,
  narrateTimeline,
  waitCaptions,
} from "./timeline.js"

// One recording's narration, shared by every video kind (a single flow's
// video, the tour reels and a pipeline's combined video): what is said per
// caption and per email card, the narrated timeline (holds, longer cards)
// and the clips placed on its clock. What the lines say and how the badges
// look is the project's copy (ReelCopy); the mechanism is here.

/** The kind of long wait a step contains (what the app is waiting for). */
export type WaitKind = "email" | "other"

export interface ReelStep {
  /** The step title as recorded ("B1.1 The agent …", "T1 inbound"). */
  id: string
  failed: boolean
  error?: string | null
}

/** What a reel says: one line per caption and per recorded mail card. */
export interface ReelTexts {
  captions: (string | null)[]
  mail: (string | null)[]
}

/** The project's narration copy and badge templates. */
export interface ReelCopy {
  /** A step's line (a long wait inside it adds one wait line). */
  stepLine(
    lines: NarrationLines,
    step: { title: string; failed: boolean; error?: string | null },
    wait: WaitKind | null,
  ): string
  /** An email card's line; `occurrence` counts cards of the same step. */
  emailLine(lines: NarrationLines, card: MailCard, occurrence: number): string
  /** The "played N× faster" badge HTML (qa fast-forward). */
  speedBadge(speed: number): string
  /** The wait badge HTML (demo pace) for a wait of this kind. */
  waitBadge(kind: WaitKind): string
}

/** Pure: the reel's lines (a long wait at demo pace adds one wait line). */
export function reelTexts(
  timeline: Pick<Timeline, "segments" | "captions">,
  steps: ReelStep[],
  cards: MailCard[],
  lines: NarrationLines,
  copy: Pick<ReelCopy, "stepLine" | "emailLine">,
): ReelTexts {
  const waits = waitCaptions(timeline)
  return {
    captions: timeline.captions.map((caption, k) => {
      const step = steps[caption.step]
      if (!step) return null
      return copy.stepLine(
        lines,
        { title: step.id, failed: step.failed, error: step.error },
        waits.get(k) ?? null,
      )
    }),
    mail: cards.map((card, k) => {
      // The n-th card of the same step may have its own line.
      const occurrence =
        cards.slice(0, k).filter((c) => c.step === card.step).length + 1
      return copy.emailLine(lines, card, occurrence)
    }),
  }
}

export interface NarratedReel {
  timeline: Timeline
  cues: NarrationCue[]
  /** The clips on the timeline's own clock (offset them in a program). */
  clips: AudioTrack["clips"]
}

/** The narrated timeline and its clips (bookend lines when it has bookends). */
export function narrateReel(
  timeline: Timeline,
  texts: ReelTexts,
  narrator: Narrator,
  bookends: { intro?: string | null; outro?: string | null } = {},
): NarratedReel {
  const narrated = narrateTimeline(timeline, {
    captions: texts.captions.map((t) => narrator.seconds(t)),
    mail: texts.mail.map((t) => narrator.seconds(t)),
    intro: narrator.seconds(bookends.intro),
    outro: narrator.seconds(bookends.outro),
  })
  const textOf = (cue: NarrationCue) =>
    cue.kind === "caption"
      ? texts.captions[cue.index]
      : cue.kind === "mail"
        ? texts.mail[cue.index]
        : cue.kind === "intro"
          ? bookends.intro
          : bookends.outro
  const clips: AudioTrack["clips"] = []
  for (const cue of narrated.cues) {
    const clip = narrator.clip(textOf(cue))
    if (clip) clips.push({ path: clip.path, atSec: cue.atSec })
  }
  return { ...narrated, clips }
}

/**
 * Pure: the overlay badge each app segment needs: "played N× faster" (qa
 * fast-forward) or the wait badge (demo pace).
 */
export function segmentBadges(
  timeline: Pick<Timeline, "segments">,
  copy: Pick<ReelCopy, "speedBadge" | "waitBadge">,
): { index: number; html: string }[] {
  const badges: { index: number; html: string }[] = []
  timeline.segments.forEach((segment, index) => {
    if (segment.kind !== "app") return
    if (segment.speed > 1) {
      badges.push({ index, html: copy.speedBadge(segment.speed) })
    } else if (segment.wait) {
      // A hold may have split the wait: look past its other pieces.
      let j = index + 1
      for (; j < timeline.segments.length; j++) {
        const s = timeline.segments[j]
        const prev = timeline.segments[j - 1]
        if (
          !(s.kind === "app" && s.wait && prev.kind === "app") ||
          s.fromSec !== prev.toSec
        ) {
          break
        }
      }
      const next = timeline.segments[j]
      badges.push({
        index,
        html: copy.waitBadge(next?.kind === "email" ? "email" : "other"),
      })
    }
  })
  return badges
}
