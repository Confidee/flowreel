// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import type { TargetName } from "../config/targets.js"
import { InboundBudgetError } from "../core/errors.js"

// The per-run inbound-mail budget. A staging target usually rate-limits
// inbound mail per sender, and a run's mail shares that sender's allowance
// with every other run; so a tour sends at most a few inbound mails on
// staging and creates the rest of its records through the app instead.
// (The cross-run sender ledger in core/inbound-ledger.ts counts across
// runs; this counts within one.)

/** Default: at most this many inbound mails per staging run. */
export const STAGING_INBOUND_MAX = 3

/** The budget as stored: the count and what was sent when. */
export interface BudgetState {
  count: number
  sends: { what: string; at: string }[]
}

/**
 * Where a run's inbound budget persists (a file in its run folder by
 * default, fileBudgetStore()); a project or test may supply its own.
 */
export interface BudgetStore {
  read(): BudgetState
  write(value: BudgetState): void
}

/** The budget's limit and the wording of its refusal. */
export interface InboundBudgetOptions {
  /** Default STAGING_INBOUND_MAX. */
  max?: number
  /**
   * Appended to the refusal after the counts: why, and what to do instead
   * (default "; create the record through the app instead, or make the
   * feature development-only.").
   */
  refusalHint?: string
}

/**
 * Counts inbound mails across the whole run (a file in the run folder, so a
 * restarted worker keeps counting). consume() is WRITE-AHEAD: the count goes
 * up before the mail is sent, so a send that crashes half way still counts,
 * and it throws BEFORE the (max+1)th send on staging. Locally it only counts.
 */
export class InboundMailBudget {
  private readonly max: number
  private readonly hint: string

  constructor(
    private readonly store: BudgetStore,
    private readonly target: TargetName,
    options: InboundBudgetOptions = {},
  ) {
    this.max = options.max ?? STAGING_INBOUND_MAX
    this.hint =
      options.refusalHint ??
      "; create the record through the app instead, or make the feature development-only."
  }

  get used(): number {
    return this.store.read().count
  }

  consume(what: string, now: Date = new Date()): number {
    const state = this.store.read()
    if (this.target === "staging" && state.count >= this.max) {
      throw new InboundBudgetError(
        `Refusing inbound mail "${what}": this staging tour already sent ${state.count} of at most ${this.max}${this.hint}`,
      )
    }
    const next = {
      count: state.count + 1,
      sends: [...state.sends, { what, at: now.toISOString() }],
    }
    this.store.write(next)
    return next.count
  }
}

/** The budget in a JSON file (a missing or corrupt file counts as zero). */
export function fileBudgetStore(path: string): BudgetStore {
  return {
    read() {
      try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as {
          count?: unknown
          sends?: unknown
        }
        return {
          count: typeof raw.count === "number" ? raw.count : 0,
          sends: Array.isArray(raw.sends)
            ? (raw.sends as { what: string; at: string }[])
            : [],
        }
      } catch {
        return { count: 0, sends: [] }
      }
    },
    write(value) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
    },
  }
}
