// SPDX-License-Identifier: Apache-2.0

import { type Env, envName, envValue } from "../core/env.js"

import { excerpt, redactAddress, redactText } from "./redact.js"

// The test side of the branded run video. A `videoLog` fixture anchors the
// page video's start on the worker clock and collects one card per mail step
// (each mail sent or received); at teardown it attaches the log as
// VIDEO_LOG_ATTACHMENT for the summary reporter, which composes the MP4 after
// the run. Step
// timing comes from Playwright's own step records (TestStep.startTime and
// duration, the same worker clock), so the spec does not time steps itself.
//
// Never secrets: cards are redacted here (reply+/notify+ tokens, links,
// opaque strings), and the log holds no storageState, password or header.

export const VIDEO_LOG_ATTACHMENT = "video-log.json"

/**
 * Default on; FLOWREEL_VIDEO=off (or 0/false/no) disables the video (or any
 * alias a project registered for VIDEO; core/env.ts).
 */
export function videoEnabled(env: Env = process.env): boolean {
  const value = (envValue(env, "VIDEO") ?? "").trim().toLowerCase()
  return !["off", "0", "false", "no"].includes(value)
}

/**
 * The "not produced" reason when videoEnabled(env) is false, naming the
 * variable that was actually set (FLOWREEL_VIDEO or a registered alias).
 */
export function videoOffReason(env: Env = process.env): string {
  return `${envName(env, "VIDEO")}=off`
}

export type MailDirection = "sent" | "received"

/** What an email card shows, already redacted. */
export interface MailCard {
  step: string
  direction: MailDirection
  from: string
  to: string[]
  replyTo: string[]
  subject: string
  excerpt: string
}

export interface MailEvent extends MailCard {
  /** Worker wall clock (epoch ms) when the mail was sent or found. */
  at: number
}

/** The recorded page switched persona (a flow's persona swap). */
export interface PersonaEvent {
  /** PersonaKey ("agent", "admin", …). */
  persona: string
  /** Worker wall clock (epoch ms). */
  at: number
}

export interface VideoLogData {
  /** Worker wall clock (epoch ms) when the agent page (and its video) began. */
  videoStartedAt: number | null
  mail: MailEvent[]
  /** Persona switches on the recorded page (tour only; absent = none). */
  personas?: PersonaEvent[]
}

/** The fields a card needs; both MailMessage and OutgoingMail fit. */
export interface CardSource {
  from: string
  to: string | string[]
  replyTo?: string[]
  subject: string
  text: string
  /** Text the step expects in the body; the card's excerpt starts there. */
  focus?: string
}

export function mailCard(
  step: string,
  direction: MailDirection,
  source: CardSource,
): MailCard {
  const to = Array.isArray(source.to) ? source.to : [source.to]
  return {
    step,
    direction,
    from: redactAddress(source.from),
    to: to.map(redactAddress),
    replyTo: (source.replyTo ?? []).map(redactAddress),
    subject: redactText(source.subject),
    excerpt: excerpt(source.text, undefined, source.focus),
  }
}

export class VideoLog {
  private videoStartedAt: number | null = null
  private readonly events: MailEvent[] = []
  private readonly personaEvents: PersonaEvent[] = []

  /** Called once the agent page exists (its video starts with it). */
  markVideoStart(now: number = Date.now()): void {
    this.videoStartedAt ??= now
  }

  /** Records a mail step's card at the moment it was sent or found. */
  mail(
    step: string,
    direction: MailDirection,
    source: CardSource,
    now: number = Date.now(),
  ): void {
    this.events.push({ ...mailCard(step, direction, source), at: now })
  }

  /** The recorded page now acts as `persona` (the brand strip shows it). */
  persona(persona: string, now: number = Date.now()): void {
    this.personaEvents.push({ persona, at: now })
  }

  toJSON(): VideoLogData {
    return {
      videoStartedAt: this.videoStartedAt,
      mail: [...this.events],
      ...(this.personaEvents.length > 0
        ? { personas: [...this.personaEvents] }
        : {}),
    }
  }
}

/** Parses an attached log; null when absent or not ours. */
export function parseVideoLog(raw: string | null): VideoLogData | null {
  if (!raw) return null
  try {
    const data = JSON.parse(raw) as Partial<VideoLogData>
    if (!Array.isArray(data.mail)) return null
    const personas = Array.isArray(data.personas)
      ? data.personas.filter(
          (p): p is PersonaEvent =>
            typeof p?.persona === "string" && typeof p?.at === "number",
        )
      : []
    return {
      videoStartedAt:
        typeof data.videoStartedAt === "number" ? data.videoStartedAt : null,
      mail: data.mail,
      ...(personas.length > 0 ? { personas } : {}),
    }
  } catch {
    return null
  }
}
