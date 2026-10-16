// SPDX-License-Identifier: Apache-2.0

// The mail-driver contract. Two kinds of implementation: "graph" (staging, a
// real Microsoft 365 mailbox via Microsoft Graph, the mail-graph subpath) and
// "seam" (development, the app's test-only HTTP seams for inbound mail and
// delivered mail). Flows depend ONLY on this interface so the same round trip
// runs against either target.

export interface MailMessage {
  /** Driver-local id (Graph message id, or the seam delivery index). */
  id: string
  /** RFC 5322 Message-ID including the angle brackets. */
  messageId: string
  from: string
  to: string[]
  cc: string[]
  replyTo: string[]
  subject: string
  text: string
  inReplyTo?: string
  references?: string[]
  /** Header names lower-cased. */
  headers: Record<string, string>
  /** ISO 8601. */
  receivedAt: string
  /**
   * Seam driver only: true when the message matched a `to:` query because
   * the app's development mail sandbox rewrote the recipient to its
   * catch-all address.
   */
  sandboxed?: boolean
}

export interface MailQuery {
  /** Matches to/cc, case-insensitive. */
  to?: string
  subjectIncludes?: string
  bodyIncludes?: string
  /** Only messages received at/after this instant. */
  since: Date
  /**
   * Driver-local ids (MailMessage.id) of messages already consumed. `since`
   * has second precision, and two personas may share one mailbox (or, via a
   * development sandbox rewrite, one catch-all address), so a later hop
   * excludes the earlier hop's message explicitly.
   */
  excludeIds?: string[]
  /** Defaults to the configured per-hop timeout. */
  timeoutMs?: number
}

export interface OutgoingMail {
  from: string
  to: string
  subject: string
  text: string
  /**
   * Development only (the seam): extra headers from the seam's
   * allowlist (Auto-Submitted, Precedence, X-Auto-Response-Suppress) and up
   * to three small files built at run time. The Graph driver refuses both.
   */
  headers?: Record<string, string>
  attachments?: { filename: string; base64: string; mime?: string }[]
}

export interface ReplyMail {
  from: string
  text: string
}

export interface SendResult {
  /** Empty string when the transport does not reveal it (Graph sendMail). */
  messageId: string
}

export interface MailDriver {
  readonly kind: "graph" | "seam"
  /** Throws an actionable Error when the mailbox/seam is unreachable. */
  health(): Promise<void>
  send(mail: OutgoingMail): Promise<SendResult>
  /** Polls until a message matches every criterion; throws TimeoutError. */
  waitFor(query: MailQuery): Promise<MailMessage>
  /**
   * Replies to `original`: To = original.replyTo[0] ?? original.from,
   * In-Reply-To/References set from original.messageId.
   */
  reply(original: MailMessage, mail: ReplyMail): Promise<SendResult>
  /** Saves the raw MIME under `dir`; returns the path, or null if unsupported. */
  saveEml?(message: MailMessage, dir: string): Promise<string | null>
}
