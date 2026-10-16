// SPDX-License-Identifier: Apache-2.0

import { type Env, envName, envValue } from "../core/env.js"
import { runStartOf } from "../run/ids.js"

import type { SessionAnswer } from "./session.js"

// Keeps a run's persona sessions inside the app's idle window.
//
// Personas are signed in ONCE per run and never again, and a demo-pace run
// can last far longer than an app's idle sign-out. So a worker sends one
// authenticated request per session every few minutes while it runs. It
// never signs in: a session the app has already signed out is reported
// once and left alone.
//
// Bounded: never past its deadline (FLOWREEL_KEEPALIVE_MAX_MIN after the run
// started, default 2 h, so a hung test or a paused debugging session cannot
// hold the sessions open), never under the Playwright inspector (PWDEBUG),
// and global teardown signs every persona out at the end of the run. Where
// the target has an idle-timeout control, running this there is a
// documented exception for the QA accounts only.

/** What one keepalive request answered. */
export type KeepaliveAnswer = SessionAnswer

/** Well inside a 15-minute idle window. */
export const KEEPALIVE_INTERVAL_MS = 4 * 60_000

/** Default hard bound: no ping later than this after the run started. */
export const KEEPALIVE_MAX_MS = 2 * 60 * 60_000
const KEEPALIVE_MAX_MIN_RANGE = [15, 480] as const

export interface KeepaliveBoundOptions {
  /** The app's idle sign-out in minutes, for the message (default 15). */
  idleMinutes?: number
  /**
   * The highest FLOWREEL_KEEPALIVE_MAX_MIN this project accepts (15-480,
   * default 480). A project whose policy allows a shorter exception sets it
   * lower; a larger value is refused.
   */
  maxMinutes?: number
}

/**
 * When the keepalive must stop for good (epoch ms), or null when it must not
 * run at all (the Playwright inspector: PWDEBUG). The run's start comes from
 * its RUN_ID stamp, else `fallbackStart` (the worker's start).
 * FLOWREEL_KEEPALIVE_MAX_MIN (or its alias; 15 to `maxMinutes`, default
 * 480) overrides the 2-hour default for a longer run.
 */
export function keepaliveDeadline(
  runId: string,
  env: Env,
  fallbackStart: number,
  options: KeepaliveBoundOptions = {},
): { deadline: number | null; why: string } {
  const [min, ceiling] = KEEPALIVE_MAX_MIN_RANGE
  const max = options.maxMinutes ?? ceiling
  if (!Number.isInteger(max) || max < min || max > ceiling) {
    throw new Error(
      `keepalive maxMinutes must be a whole number of minutes from ${min} to ${ceiling} (got ${max}).`,
    )
  }
  if (env.PWDEBUG?.trim() && env.PWDEBUG.trim() !== "0") {
    return {
      deadline: null,
      why: `off under the Playwright inspector (PWDEBUG): an idle debugging session is signed out after ${options.idleMinutes ?? 15} minutes as usual`,
    }
  }
  let maxMs = Math.min(KEEPALIVE_MAX_MS, max * 60_000)
  const raw = envValue(env, "KEEPALIVE_MAX_MIN")?.trim()
  if (raw) {
    const minutes = Number(raw)
    if (!Number.isInteger(minutes) || minutes < min || minutes > max) {
      throw new Error(
        `${envName(env, "KEEPALIVE_MAX_MIN")} must be a whole number of minutes from ${min} to ${max} (got ${JSON.stringify(raw)}).`,
      )
    }
    maxMs = minutes * 60_000
  }
  const start = runStartOf(runId) ?? fallbackStart
  return {
    deadline: start + maxMs,
    why: `until ${new Date(start + maxMs).toISOString()} at most (${Math.round(maxMs / 60_000)} min after the run started)`,
  }
}

export interface KeepaliveOptions {
  /** True when an answer means the app has signed the session out. */
  isSignedOut: (answer: SessionAnswer) => boolean
  /** Where lines go (default console.log). */
  log?: (line: string) => void
  /** Epoch ms after which nothing is pinged again (null = no bound). */
  deadline?: number | null
  now?: () => number
  /** The log prefix, shown as "[<logPrefix>]" (default "flowreel"). */
  logPrefix?: string
  /** The app's idle sign-out in minutes, for the log (default 15). */
  idleMinutes?: number
  /** A reference appended to the signed-out line, e.g. a runbook item. */
  signedOutReference?: string
}

export class SessionKeepalive<K extends string> {
  private readonly lost = new Set<K>()
  private running = false
  private expired = false
  private readonly log: (line: string) => void
  private readonly deadline: number | null
  private readonly now: () => number
  private readonly prefix: string

  constructor(
    /** One persona per distinct session (personas sharing one are pinged once). */
    private readonly personas: readonly K[],
    private readonly ping: (persona: K) => Promise<SessionAnswer>,
    private readonly options: KeepaliveOptions,
  ) {
    this.log = options.log ?? ((line) => console.log(line))
    this.deadline = options.deadline ?? null
    this.now = options.now ?? (() => Date.now())
    this.prefix = `[${options.logPrefix ?? "flowreel"}]`
  }

  /** True once the deadline passed: the keepalive has stopped for good. */
  get stopped(): boolean {
    return this.expired
  }

  /** Personas the app had already signed out (never signed in again). */
  get signedOut(): K[] {
    return [...this.lost]
  }

  /**
   * One request per live session. Never throws (a failed request is logged
   * and tried again on the next tick); a tick that is still running when the
   * next one is due is skipped.
   */
  async tick(): Promise<void> {
    if (this.running || this.expired) return
    if (this.deadline !== null && this.now() >= this.deadline) {
      this.expired = true
      this.log(
        `${this.prefix} keepalive: stopped at its deadline (${new Date(this.deadline).toISOString()}); the sessions now follow the app's ${this.options.idleMinutes ?? 15}-minute idle sign-out.`,
      )
      return
    }
    this.running = true
    try {
      for (const persona of this.personas) {
        if (this.lost.has(persona)) continue
        try {
          const answer = await this.ping(persona)
          if (this.options.isSignedOut(answer)) {
            this.lost.add(persona)
            const ref = this.options.signedOutReference
            this.log(
              `${this.prefix} keepalive: the ${persona} session is already signed out (HTTP ${answer.status}); it is not signed in again${ref ? ` (${ref})` : ""}.`,
            )
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          this.log(
            `${this.prefix} keepalive: ${persona} request failed (${message.split("\n")[0]}); trying again on the next tick.`,
          )
        }
      }
    } finally {
      this.running = false
    }
  }

  /** Pings now, then every `intervalMs`; the returned function stops it. */
  start(
    intervalMs: number = KEEPALIVE_INTERVAL_MS,
    timers: {
      setInterval: (fn: () => void, ms: number) => unknown
      clearInterval: (handle: unknown) => void
    } = {
      setInterval: (fn, ms) => {
        const handle = setInterval(fn, ms)
        // Never keeps the worker alive on its own.
        handle.unref()
        return handle
      },
      clearInterval: (handle) =>
        clearInterval(handle as ReturnType<typeof setInterval>),
    },
  ): () => Promise<void> {
    let current = this.tick()
    const handle = timers.setInterval(() => {
      current = this.tick()
    }, intervalMs)
    return async () => {
      timers.clearInterval(handle)
      await current
    }
  }
}
