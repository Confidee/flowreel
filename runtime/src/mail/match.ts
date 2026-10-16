// SPDX-License-Identifier: Apache-2.0

import type { MailMessage, MailQuery } from "./types.js"

// Pure MailQuery x MailMessage matching shared by both drivers. Every
// criterion is ANDed; there is no "latest email" shortcut: the
// `since` guard plus a RUN_ID in subject/body is what makes a match unique.

/** "Name <a@b>" -> "a@b"; a bare address is returned trimmed. */
export function addressOf(value: string): string {
  const angle = /<([^<>]*)>\s*$/.exec(value)
  return (angle ? angle[1] : value).trim()
}

function sameAddress(a: string, b: string): boolean {
  return addressOf(a).toLowerCase() === addressOf(b).toLowerCase()
}

/**
 * "direct": matched on the query's own `to`. "alternate": the recipient
 * matched only via one of `alternateTo` (the seam's sandbox rewrite).
 * "none": some criterion failed.
 */
export type MatchOutcome = "direct" | "alternate" | "none"

export function matchMessage(
  message: MailMessage,
  query: MailQuery,
  alternateTo: string[] = [],
): MatchOutcome {
  if (query.excludeIds?.includes(message.id)) return "none"
  const received = Date.parse(message.receivedAt)
  if (Number.isNaN(received) || received < query.since.getTime()) {
    return "none"
  }
  if (
    query.subjectIncludes !== undefined &&
    !message.subject.includes(query.subjectIncludes)
  ) {
    return "none"
  }
  if (
    query.bodyIncludes !== undefined &&
    !message.text.includes(query.bodyIncludes)
  ) {
    return "none"
  }
  if (query.to === undefined) return "direct"

  const recipients = [...message.to, ...message.cc]
  if (recipients.some((r) => sameAddress(r, query.to!))) return "direct"
  if (recipients.some((r) => alternateTo.some((alt) => sameAddress(r, alt)))) {
    return "alternate"
  }
  return "none"
}

export function matchesQuery(message: MailMessage, query: MailQuery): boolean {
  return matchMessage(message, query) !== "none"
}

/** Short human description of a query, for TimeoutError messages. */
export function describeQuery(query: MailQuery): string {
  const parts = ["mail"]
  if (query.to !== undefined) parts.push(`to=${query.to}`)
  if (query.subjectIncludes !== undefined) {
    parts.push(`subject~${JSON.stringify(query.subjectIncludes)}`)
  }
  if (query.bodyIncludes !== undefined) {
    parts.push(`body~${JSON.stringify(query.bodyIncludes)}`)
  }
  parts.push(`since=${query.since.toISOString()}`)
  return parts.join(" ")
}

/** Last-observed summary for a poll attempt that found nothing. */
export function describeCandidates(
  messages: MailMessage[],
  since: Date,
): string {
  const recent = messages.filter(
    (m) => Date.parse(m.receivedAt) >= since.getTime(),
  )
  if (recent.length === 0) return "no messages since the query start"
  const newest = recent.reduce((a, b) =>
    Date.parse(b.receivedAt) > Date.parse(a.receivedAt) ? b : a,
  )
  return `${recent.length} message(s) since the query start, none matching; newest ${JSON.stringify(newest.subject)} to ${newest.to.join(", ") || "(none)"}`
}
