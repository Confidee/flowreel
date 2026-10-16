// SPDX-License-Identifier: Apache-2.0

import type { Env } from "../core/env.js"
import type { NarrationCopy } from "../narration/copy.js"
import {
  type Narration,
  createNarration,
  loadNarration,
} from "../narration/narration.js"
import {
  type NarrationDecision,
  type NarrationLines,
  type NarrationLog,
  type NarrationOutcome,
  type Narrator,
  defaultNarrationLog,
  prepareNarration,
} from "../voice/narrator.js"
import {
  type VoiceEngine,
  defaultVoiceCacheDir,
  engineFor,
} from "../voice/voice.js"

import { type Brand, NEUTRAL_BRAND } from "./brand.js"
import { type Cards, createCards } from "./cards.js"
import type { CardCopy } from "./copy.js"
import type { ReelCopy } from "./reel-voice.js"
import { type TourCards, createTourCards } from "./tour-cards.js"

/** What createVideoKit builds a kit from; everything is optional. */
export interface VideoKitOptions {
  /** Colours, gradient and logos of every card (default NEUTRAL_BRAND). */
  brand?: Brand
  /** Every visible word on the cards (default DEFAULT_CARD_COPY; see defineCardCopy). */
  copy?: CardCopy
  /**
   * What the narration says and may never say (default
   * DEFAULT_NARRATION_COPY; see defineNarrationCopy).
   */
  narrationCopy?: NarrationCopy
  /** Where curated narration lines live (<dir>/<module>.json); none = defaults only. */
  narrationDir?: string | null
  voice?: {
    /** The clip cache (default: defaultVoiceCacheDir(env)). */
    cacheDir?: string
    /** Where narration progress lines go. */
    log?: NarrationLog
    /** The engine for an environment (default: engineFor). */
    engine?: (env: Env) => VoiceEngine
  }
}

/**
 * Everything a project's videos are made with, in one place: its Brand, its
 * card copy, its narration copy (and where its curated lines live) and its
 * voice settings. The video producers (produceVideo, produceTourVideos,
 * produceCombinedVideo, produceCombinedTourVideo) take a kit; a project
 * builds it once in its adapter with {@link createVideoKit}:
 *
 * ```ts
 * export const kit = createVideoKit({
 *   brand: defineBrand({ name: "Acme", colors: { primary: "#1d4ed8" } }),
 *   copy: defineCardCopy({ run: { title: "Order round trip" } }),
 *   narrationCopy: defineNarrationCopy({ featureId: "[A-H]\\d{1,2}" }),
 *   narrationDir: "e2e/flowreel/narration",
 * })
 * ```
 */
export interface VideoKit {
  /** The colours, gradient and logos of every card. */
  readonly brand: Brand
  /** The run and pipeline card templates in the kit's brand and copy. */
  readonly cards: Cards
  /** The feature-tour card templates, built on `cards`. */
  readonly tourCards: TourCards
  /** What each step, email and card says (and may never say). */
  readonly narration: Narration
  /** The reel narration copy (step and email lines, speed and wait badges). */
  readonly reelCopy: ReelCopy
  /** A module's curated lines ({} without a narration dir). */
  lines(module: string): NarrationLines
  /** Says every line once (voice cache first); never throws. */
  prepareNarration(
    decision: NarrationDecision,
    texts: (string | null | undefined)[],
    env: Env,
  ): Promise<{ narrator: Narrator | null; outcome: NarrationOutcome }>
}

/**
 * Builds the kit every video producer takes (produceVideo,
 * produceTourVideos, produceCombinedVideo, produceCombinedTourVideo): the
 * cards in `brand` and `copy`, the narration in `narrationCopy` reading its
 * step labels from those cards, the reel copy, curated lines from
 * `narrationDir`, and the voice (engine, clip cache, progress log). Pure
 * apart from reading curated lines when asked; a project builds it once in
 * its adapter.
 */
export function createVideoKit(options: VideoKitOptions = {}): VideoKit {
  const brand = options.brand ?? NEUTRAL_BRAND
  const cards = createCards({
    brand,
    ...(options.copy ? { copy: options.copy } : {}),
  })
  const tourCards = createTourCards(cards)
  const narration = createNarration({
    ...(options.narrationCopy ? { copy: options.narrationCopy } : {}),
    stepLabel: cards.stepLabel,
  })
  const reelCopy: ReelCopy = {
    stepLine: (lines, step, wait) => narration.stepLine(lines, step, wait),
    emailLine: (lines, card, occurrence) =>
      narration.emailLine(lines, card, occurrence),
    speedBadge: (speed) => cards.speedHtml(speed),
    waitBadge: (kind) => cards.waitHtml(narration.copy.waitCaptions[kind]),
  }
  const dir = options.narrationDir ?? null
  const voice = options.voice ?? {}
  return {
    brand,
    cards,
    tourCards,
    narration,
    reelCopy,
    lines: (module) => (dir ? loadNarration(module, dir) : {}),
    prepareNarration: (decision, texts, env) =>
      prepareNarration(
        decision,
        texts,
        env,
        (voice.engine ?? engineFor)(env),
        voice.cacheDir ?? defaultVoiceCacheDir(env),
        voice.log ?? defaultNarrationLog,
      ),
  }
}
