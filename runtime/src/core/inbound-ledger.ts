// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import type { MailDriver } from "../mail/types.js"

import { InboundBudgetError } from "./errors.js"

// Cross-run inbound-mail ledger (staging only). Many apps rate-limit inbound
// mail per sender (for example: a sender's new records are parked once it
// sent N mails in the last hour, and a parked record fires no notification),
// so a flow that waits for that notification fails. A per-run budget cannot
// see a second run: two staging runs back to back each start with a fresh
// budget. This ledger lives next to the runs (one JSON file shared by every
// module), and refuses a NEW inbound mail (replies are not counted) from a
// sender that has already sent `limit` in the last 60 minutes, before it is
// sent. Keep the limit below the app's own cap: other inbound mail from the
// same sender (canaries, people) shares that bucket and is not in this file.

/** The default per-sender limit per rolling hour. */
export const DEFAULT_SENDER_HOURLY_LIMIT = 8
export const ROLLING_WINDOW_MS = 60 * 60_000

export interface InboundLedgerEntry {
  sender: string
  at: string
  runId: string
  what: string
}

export interface InboundLedgerStore {
  read(): InboundLedgerEntry[]
  write(entries: InboundLedgerEntry[]): void
}

/**
 * Optional wording for the refusal: `reason` says why the limit exists
 * (after the run list), `remedy` what else the user can do (after the wait
 * time). Both are plain sentences without a final full stop.
 */
export interface InboundLedgerHints {
  reason?: string
  remedy?: string
}

export interface InboundLedgerOptions extends InboundLedgerHints {
  /** Default DEFAULT_SENDER_HOURLY_LIMIT. */
  limit?: number
}

export function fileInboundLedger(path: string): InboundLedgerStore {
  return {
    read() {
      try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as {
          sends?: unknown
        }
        return Array.isArray(raw.sends)
          ? (raw.sends as InboundLedgerEntry[]).filter(
              (e) => typeof e?.sender === "string" && typeof e.at === "string",
            )
          : []
      } catch {
        return []
      }
    },
    write(entries) {
      mkdirSync(dirname(path), { recursive: true })
      const tmp = `${path}.tmp`
      writeFileSync(tmp, `${JSON.stringify({ sends: entries }, null, 2)}\n`)
      renameSync(tmp, path)
    },
  }
}

/** Sends from `sender` in the rolling hour before `now`. */
export function recentSends(
  entries: InboundLedgerEntry[],
  sender: string,
  now: Date,
): InboundLedgerEntry[] {
  const from = now.getTime() - ROLLING_WINDOW_MS
  const who = sender.trim().toLowerCase()
  return entries.filter(
    (e) => e.sender.toLowerCase() === who && new Date(e.at).getTime() > from,
  )
}

/**
 * WRITE-AHEAD: records the send before it happens (a send that crashes half
 * way still counts) and throws, before anything is sent, when `sender`
 * already sent the limit in the last hour. Entries older than the window are
 * dropped on write.
 */
export function consumeInbound(
  store: InboundLedgerStore,
  entry: Omit<InboundLedgerEntry, "at">,
  now: Date = new Date(),
  limit: number = DEFAULT_SENDER_HOURLY_LIMIT,
  hints: InboundLedgerHints = {},
): number {
  const entries = store.read()
  const recent = recentSends(entries, entry.sender, now)
  if (recent.length >= limit) {
    const oldest = recent
      .map((e) => new Date(e.at).getTime())
      .reduce((a, b) => Math.min(a, b))
    const freeAt = new Date(oldest + ROLLING_WINDOW_MS).toISOString()
    throw new InboundBudgetError(
      `Refusing inbound mail "${entry.what}": ${entry.sender} already sent ${recent.length} new mails to staging in the last 60 minutes (runs ${[...new Set(recent.map((e) => e.runId))].join(", ")})${hints.reason ? `; ${hints.reason}` : ""}. Nothing was sent. Wait until ${freeAt}${hints.remedy ? `, or ${hints.remedy}` : ""}.`,
    )
  }
  const from = now.getTime() - ROLLING_WINDOW_MS
  store.write([
    ...entries.filter((e) => new Date(e.at).getTime() > from),
    {
      ...entry,
      sender: entry.sender.trim().toLowerCase(),
      at: now.toISOString(),
    },
  ])
  return recent.length + 1
}

/**
 * The driver with its `send` counted in the cross-run ledger (staging
 * only; replies pass through). Every other member is the driver's own.
 */
export function withInboundLedger(
  driver: MailDriver,
  store: InboundLedgerStore,
  runId: string,
  options: InboundLedgerOptions = {},
): MailDriver {
  return {
    kind: driver.kind,
    health: () => driver.health(),
    waitFor: (query) => driver.waitFor(query),
    reply: (original, mail) => driver.reply(original, mail),
    ...(driver.saveEml
      ? { saveEml: (message, dir) => driver.saveEml!(message, dir) }
      : {}),
    send(mail) {
      consumeInbound(
        store,
        {
          sender: mail.from,
          runId,
          what: mail.subject,
        },
        new Date(),
        options.limit ?? DEFAULT_SENDER_HOURLY_LIMIT,
        { reason: options.reason, remedy: options.remedy },
      )
      return driver.send(mail)
    },
  }
}
