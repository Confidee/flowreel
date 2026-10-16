// SPDX-License-Identifier: Apache-2.0

// Pure timeline builder for the branded run video: steps + mail events
// (seconds on the page video's own clock) in, an ordered segment list out.
// The composer (ffmpeg.ts) only executes what this returns, so every rule
// about what the viewer sees lives here and is unit-tested
// (test/video-timeline.spec.ts).
//
//   intro card | app [start, mail1] | email card 1 | app [mail1, mail2] | …
//   | app [mailN, end] | outro card
//
// Captions are on the SOURCE clock (they are overlaid before the recording is
// cut), one per step, clipped to the recorded window and held until the next
// step's caption (the last one through the tail). Each card-to-card stretch
// is also cut at step boundaries, and only a piece longer than
// maxAppSegmentSec (a staging mail or status wait) is played faster, up to
// maxSpeed: a three-minute hop does not become three minutes of a still page,
// while the UI steps around it keep real time.
//
// `bookends: false` leaves out the intro and outro cards: the "body only" a
// development -> staging pipeline splices between its own
// chapter cards, with the same app, email and caption cuts as the stage's
// own video.

export type StepStatus = "passed" | "failed"

export interface TimelineStep {
  id: string
  /** Seconds since the page video started. */
  startSec: number
  endSec: number
  status: StepStatus
}

export interface TimelineMail {
  /** Seconds since the page video started. */
  atSec: number
}

/** The recorded page switched persona at this second (tour). */
export interface TimelinePersona {
  atSec: number
  persona: string
}

export interface TimelineInput {
  /** Length of the page recording (ffprobe). */
  videoDurationSec: number
  steps: TimelineStep[]
  /** In the order the email cards were recorded. */
  mail: TimelineMail[]
  /**
   * Tour reels: who the recorded page acts as. `initial` holds from the start,
   * each switch from its second on. Absent = no persona badge (round trip).
   */
  personas?: { initial: string; switches: TimelinePersona[] }
}

export interface TimelineOptions {
  introSec: number
  emailSec: number
  outroSec: number
  /** Recording kept before the first step starts. */
  leadInSec: number
  /** Recording kept after the last step ends (shows a failure's end state). */
  tailSec: number
  maxAppSegmentSec: number
  maxSpeed: number
  /**
   * App stretches shorter than this are dropped (a flash between two cards,
   * a lead-in or tail squeezed by a card), and no step boundary closer than
   * this to another cut splits a stretch.
   */
  minSegmentSec: number
  /** Intro and outro cards; false = the body only (pipeline video). */
  bookends: boolean
  /**
   * Demo pace: every recorded piece plays this many times
   * slower (1.5 = two-thirds speed); 1 = real time.
   */
  slowFactor: number
  /**
   * Long waits (pieces over maxAppSegmentSec) played faster (qa pace). Off at
   * demo pace: such a piece is flagged `wait` instead and
   * plays in real time (speed 1, not slowed), never faster.
   */
  fastForward: boolean
}

export const DEFAULT_TIMELINE: TimelineOptions = {
  introSec: 3,
  emailSec: 4,
  outroSec: 5,
  leadInSec: 0.5,
  tailSec: 1.5,
  maxAppSegmentSec: 20,
  maxSpeed: 20,
  minSegmentSec: 0.4,
  bookends: true,
  slowFactor: 1,
  fastForward: true,
}

export type Segment =
  | { kind: "intro"; durationSec: number }
  | { kind: "outro"; durationSec: number }
  /** `mail` indexes TimelineInput.mail (and the recorded cards). */
  | { kind: "email"; mail: number; durationSec: number }
  | {
      kind: "app"
      fromSec: number
      toSec: number
      /** 1 = real time; >1 = played faster; <1 = slower (demo pace). */
      speed: number
      /** Played length plus holdSec. */
      durationSec: number
      /** Freeze on the piece's last frame this long (narration). */
      holdSec?: number
      /** A long wait at demo pace (badge + one spoken line). */
      wait?: true
    }

export interface Caption {
  /** Index into TimelineInput.steps. */
  step: number
  fromSec: number
  toSec: number
}

/** A persona badge window on the SOURCE clock (like a caption). */
export interface PersonaWindow {
  persona: string
  fromSec: number
  toSec: number
}

export interface Timeline {
  segments: Segment[]
  captions: Caption[]
  /** Persona badge windows (empty without TimelineInput.personas). */
  personas: PersonaWindow[]
  durationSec: number
  /** The recorded window kept: [fromSec, toSec] on the source clock. */
  app: { fromSec: number; toSec: number }
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max)

/** Millisecond precision keeps ffmpeg arguments short and tests exact. */
const ms = (value: number) => Math.round(value * 1000) / 1000
/** Rounds UP to the millisecond: a slowed piece never comes out shorter. */
const msUp = (value: number) => Math.ceil(value * 1000 - 1e-6) / 1000

/** Played length of `length` source seconds at `speed` (no hold). */
export function playedSec(length: number, speed: number): number {
  return speed < 1 ? msUp(length / speed) : ms(length / speed)
}

export function buildTimeline(
  input: TimelineInput,
  overrides: Partial<TimelineOptions> = {},
): Timeline {
  const o = { ...DEFAULT_TIMELINE, ...overrides }
  const duration = Math.max(0, input.videoDurationSec)
  const finite = (n: number) => Number.isFinite(n)

  const steps = input.steps.filter(
    (s) => finite(s.startSec) && finite(s.endSec) && s.endSec >= s.startSec,
  )
  const firstStart = Math.min(...steps.map((s) => s.startSec))
  const lastEnd = Math.max(...steps.map((s) => s.endSec))
  const appFrom =
    steps.length > 0 ? ms(clamp(firstStart - o.leadInSec, 0, duration)) : 0
  const appTo =
    steps.length > 0
      ? ms(clamp(lastEnd + o.tailSec, appFrom, duration))
      : ms(duration)

  // Cards in recorded order; a card outside the kept window sits at its edge.
  const cuts = input.mail.map((m, index) => ({
    index,
    at: ms(clamp(finite(m.atSec) ? m.atSec : appTo, appFrom, appTo)),
  }))
  cuts.sort((a, b) => a.at - b.at || a.index - b.index)

  // Step boundaries split a card-to-card stretch, so a wait is sped up on its
  // own and the UI steps around it keep real time.
  const boundaries = [
    ...new Set(steps.flatMap((s) => [ms(s.startSec), ms(s.endSec)])),
  ].sort((a, b) => a - b)
  const speedOf = (length: number) =>
    o.fastForward && length > o.maxAppSegmentSec
      ? Math.min(o.maxSpeed, length / o.maxAppSegmentSec)
      : 1
  const isWait = (length: number) =>
    !o.fastForward && length > o.maxAppSegmentSec
  const slow = o.slowFactor > 1 ? o.slowFactor : 1

  const segments: Segment[] = o.bookends
    ? [{ kind: "intro", durationSec: o.introSec }]
    : []
  const pushApp = (fromSec: number, toSec: number) => {
    if (ms(toSec - fromSec) < o.minSegmentSec) return
    const points = [fromSec]
    for (const b of boundaries) {
      if (
        b - points[points.length - 1] >= o.minSegmentSec &&
        toSec - b >= o.minSegmentSec
      ) {
        points.push(b)
      }
    }
    points.push(toSec)
    // Adjacent real-time pieces merge back into one segment (a wait stays
    // its own piece: it carries the wait badge).
    const pieces: {
      fromSec: number
      toSec: number
      speed: number
      wait: boolean
    }[] = []
    for (let k = 0; k + 1 < points.length; k++) {
      const length = ms(points[k + 1] - points[k])
      const speed = speedOf(length)
      const wait = isWait(length)
      const last = pieces[pieces.length - 1]
      if (last?.speed === 1 && speed === 1 && !last.wait && !wait) {
        last.toSec = points[k + 1]
      } else {
        pieces.push({ fromSec: points[k], toSec: points[k + 1], speed, wait })
      }
    }
    for (const { wait, ...piece } of pieces) {
      // Demo pace: never faster than real time. Recorded work plays at
      // 1/slowFactor; a long wait plays in real time (a
      // three-minute email hop is not stretched to four and a half).
      const rate = slow > 1 ? (wait ? 1 : 1 / slow) : piece.speed
      segments.push({
        kind: "app",
        ...piece,
        speed: slow > 1 ? rate : ms(rate),
        durationSec: playedSec(piece.toSec - piece.fromSec, rate),
        ...(wait ? { wait: true as const } : {}),
      })
    }
  }
  let cursor = appFrom
  for (const cut of cuts) {
    pushApp(cursor, cut.at)
    segments.push({ kind: "email", mail: cut.index, durationSec: o.emailSec })
    cursor = cut.at
  }
  pushApp(cursor, appTo)
  if (o.bookends) segments.push({ kind: "outro", durationSec: o.outroSec })

  const captions: Caption[] = []
  input.steps.forEach((s, step) => {
    if (!steps.includes(s)) return
    const fromSec = ms(clamp(s.startSec, appFrom, appTo))
    const toSec = ms(clamp(s.endSec, appFrom, appTo))
    if (toSec > fromSec) captions.push({ step, fromSec, toSec })
  })
  // A caption holds until the next one starts, and the last one through the
  // tail, so the bar never goes blank between steps or over a failure's end
  // state.
  captions.forEach((caption, k) => {
    const next = captions[k + 1]
    caption.toSec = Math.max(caption.toSec, next ? next.fromSec : appTo)
  })

  // Persona badges: the initial persona from the window's start, each switch
  // from its second on (clipped to the kept window), each until the next.
  const personas: PersonaWindow[] = []
  if (input.personas) {
    const changes = [
      { atSec: appFrom, persona: input.personas.initial },
      ...input.personas.switches
        .filter((p) => finite(p.atSec))
        .map((p) => ({
          atSec: ms(clamp(p.atSec, appFrom, appTo)),
          persona: p.persona,
        }))
        .sort((a, b) => a.atSec - b.atSec),
    ]
    changes.forEach((change, k) => {
      const toSec = k + 1 < changes.length ? changes[k + 1].atSec : appTo
      if (toSec <= change.atSec) return
      const last = personas[personas.length - 1]
      if (last?.persona === change.persona && last.toSec === change.atSec) {
        last.toSec = toSec
      } else {
        personas.push({ persona: change.persona, fromSec: change.atSec, toSec })
      }
    })
  }

  return {
    segments,
    captions,
    personas,
    durationSec: ms(segments.reduce((sum, s) => sum + s.durationSec, 0)),
    app: { fromSec: appFrom, toSec: appTo },
  }
}

// ---------------------------------------------------------------------------
// Narration: the sentences drive the pacing.
// ---------------------------------------------------------------------------

/** Silence after a step's sentence before the next one may start. */
export const NARRATION_GAP_SEC = 0.4
/** A card stays up this long after its sentence ends. */
export const CARD_PAD_SEC = 0.6
/** A card's sentence starts this long after the card appears. */
export const CARD_LEAD_SEC = 0.3

/** Sentence lengths in seconds; null = nothing said there. */
export interface NarrationDurations {
  /** Per timeline caption (Timeline.captions order). */
  captions: (number | null)[]
  /** Per recorded mail card (Segment.mail). */
  mail: (number | null)[]
  intro?: number | null
  outro?: number | null
}

/** Where one sentence starts on the OUTPUT clock. */
export interface NarrationCue {
  kind: "caption" | "mail" | "intro" | "outro"
  /** Caption index or mail index; 0 for intro/outro. */
  index: number
  atSec: number
}

/**
 * Pure: which captions contain a long wait (demo pace) and whether the wait
 * ends at an email card. That caption's sentence gets one wait line.
 */
export function waitCaptions(
  timeline: Pick<Timeline, "segments" | "captions">,
): Map<number, "email" | "other"> {
  const out = new Map<number, "email" | "other">()
  timeline.segments.forEach((segment, i) => {
    if (segment.kind !== "app" || !segment.wait) return
    const next = timeline.segments[i + 1]
    const kind = next?.kind === "email" ? "email" : "other"
    let caption = timeline.captions.findIndex(
      (c) => c.fromSec <= segment.fromSec && segment.fromSec < c.toSec,
    )
    if (caption < 0 && timeline.captions.length > 0) caption = 0
    if (caption >= 0 && !out.has(caption)) out.set(caption, kind)
  })
  return out
}

const starts = (segments: Segment[]) => {
  let at = 0
  return segments.map((s) => {
    const start = at
    at += s.durationSec
    return start
  })
}

type AppSegment = Extract<Segment, { kind: "app" }>

/**
 * The output second where source second `src` is shown. "start": the piece
 * that starts at or runs through it; "end": the piece that ends at or runs
 * through it, before that piece's hold.
 */
function outputAt(
  segments: Segment[],
  src: number,
  edge: "start" | "end",
): number | null {
  const at = starts(segments)
  let fallback: number | null = null
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]
    if (s.kind !== "app") continue
    const inside =
      edge === "start"
        ? s.fromSec <= src && src < s.toSec
        : s.fromSec < src && src <= s.toSec
    if (inside) return at[i] + playedSec(src - s.fromSec, s.speed)
    if (edge === "start" && s.toSec === src) {
      fallback = at[i] + s.durationSec
    }
    if (edge === "end" && s.fromSec === src && fallback === null) {
      fallback = at[i]
    }
  }
  return fallback
}

/** Freezes the frame at source second `p` for `hold` s (splits a piece). */
function addHold(segments: Segment[], p: number, hold: number): void {
  let index = segments.findIndex(
    (s) => s.kind === "app" && s.fromSec < p && p <= s.toSec,
  )
  if (index < 0) {
    // No piece ends at p (a squeezed stretch): hold the last piece before it.
    for (let i = segments.length - 1; i >= 0; i--) {
      const s = segments[i]
      if (s.kind === "app" && s.toSec <= p) {
        index = i
        break
      }
    }
  }
  if (index < 0) return
  const s = segments[index] as AppSegment
  const withHold = (piece: AppSegment, holdSec: number): AppSegment => {
    const rest: AppSegment = { ...piece }
    delete rest.holdSec
    const total = ms(holdSec)
    return {
      ...rest,
      durationSec: ms(
        playedSec(piece.toSec - piece.fromSec, piece.speed) + total,
      ),
      ...(total > 0 ? { holdSec: total } : {}),
    }
  }
  if (p < s.toSec && p > s.fromSec) {
    segments.splice(
      index,
      1,
      withHold({ ...s, toSec: p }, hold),
      withHold({ ...s, fromSec: p }, s.holdSec ?? 0),
    )
  } else {
    segments[index] = withHold(s, (s.holdSec ?? 0) + hold)
  }
}

/**
 * Pure: fits the sentences into a timeline. Each
 * step's sentence starts at its caption's start; when it (plus the gap) is
 * longer than the step's on-screen window (until the next caption or email
 * card), the last frame of that window is held until the sentence ends.
 * Intro, outro and email cards last at least lead + sentence + pad. Holds
 * only ever ADD time; with no sentences the timeline is returned unchanged.
 */
export function narrateTimeline(
  timeline: Timeline,
  voice: NarrationDurations,
  options: { gapSec?: number; cardPadSec?: number; cardLeadSec?: number } = {},
): { timeline: Timeline; cues: NarrationCue[] } {
  const gap = options.gapSec ?? NARRATION_GAP_SEC
  const pad = options.cardPadSec ?? CARD_PAD_SEC
  const lead = options.cardLeadSec ?? CARD_LEAD_SEC
  const segments: Segment[] = timeline.segments.map((s) => ({ ...s }))
  const cues: NarrationCue[] = []
  const said = (d: number | null | undefined): d is number =>
    typeof d === "number" && Number.isFinite(d) && d > 0
  const cardFits = (index: number, d: number) => {
    const s = segments[index]
    s.durationSec = ms(Math.max(s.durationSec, lead + d + pad))
  }

  if (said(voice.intro)) {
    const i = segments.findIndex((s) => s.kind === "intro")
    if (i >= 0) {
      cardFits(i, voice.intro)
      cues.push({
        kind: "intro",
        index: 0,
        atSec: ms(starts(segments)[i] + lead),
      })
    }
  }

  // Events on the source clock: each mail card where it cuts the recording,
  // each caption where it starts. A card at the same second comes first (it
  // sits before the piece that starts there).
  const events: { at: number; kind: "mail" | "caption"; index: number }[] = []
  let cursor = timeline.app.fromSec
  for (const s of segments) {
    if (s.kind === "app") cursor = s.toSec
    if (s.kind === "email")
      events.push({ at: cursor, kind: "mail", index: s.mail })
  }
  timeline.captions.forEach((c, index) =>
    events.push({ at: c.fromSec, kind: "caption", index }),
  )
  events.sort(
    (a, b) =>
      a.at - b.at ||
      (a.kind === b.kind ? a.index - b.index : a.kind === "mail" ? -1 : 1),
  )

  events.forEach((event, k) => {
    if (event.kind === "mail") {
      const d = voice.mail[event.index]
      if (!said(d)) return
      const i = segments.findIndex(
        (s) => s.kind === "email" && s.mail === event.index,
      )
      if (i < 0) return
      cardFits(i, d)
      cues.push({
        kind: "mail",
        index: event.index,
        atSec: ms(starts(segments)[i] + lead),
      })
      return
    }
    const d = voice.captions[event.index]
    if (!said(d)) return
    const windowEnd = events[k + 1]?.at ?? timeline.app.toSec
    const start = outputAt(segments, event.at, "start")
    if (start === null) return
    const end = outputAt(segments, windowEnd, "end") ?? start
    const need = ms(d + gap - (end - start))
    if (need > 0) addHold(segments, windowEnd, need)
    cues.push({ kind: "caption", index: event.index, atSec: ms(start) })
  })

  if (said(voice.outro)) {
    const i = segments.findIndex((s) => s.kind === "outro")
    if (i >= 0) {
      cardFits(i, voice.outro)
      cues.push({
        kind: "outro",
        index: 0,
        atSec: ms(starts(segments)[i] + lead),
      })
    }
  }

  return {
    timeline: {
      ...timeline,
      segments,
      durationSec: ms(segments.reduce((sum, s) => sum + s.durationSec, 0)),
    },
    cues,
  }
}
