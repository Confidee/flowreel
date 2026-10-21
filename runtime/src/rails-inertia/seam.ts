// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto"

import type { APIRequest, APIRequestContext } from "@playwright/test"

import type { StorageState } from "../app/personas.js"
import { LoginError } from "../core/errors.js"
import {
  type BoundTimers,
  DEFAULT_REQUEST_TIMEOUT_MS,
  type FetchLike,
  assertRequestTimeoutMs,
  fetchWithin,
  formatBound,
} from "../core/http.js"
import { poll } from "../core/poll.js"
import {
  addressOf,
  describeCandidates,
  describeQuery,
  matchMessage,
} from "../mail/match.js"
import type {
  MailDriver,
  MailMessage,
  MailQuery,
  OutgoingMail,
  ReplyMail,
  SendResult,
} from "../mail/types.js"

// The client of the test-seam protocol (docs/adapters.md "The seam
// protocol"; the Rails seam kit in plugin/templates/rails implements the
// server side). Development stage only: the local target is loopback-only,
// and every seam answers 404 unless the app runs in a local environment
// with the seam flag set. Every POST carries a JSON body (`{}` when it has
// no fields): the Rails kit's gate refuses any other POST, so a cross-site
// page cannot post to a seam.
//
// Both HTTP clients bound every request as a whole (headers and body) by
// requestTimeoutMs, 30 s by default: a seam that never answers fails the
// run instead of hanging it.
//
// - seamSignIn(): POST <signIn> {email, …} -> 2xx + the session cookie.
// - HttpSeamMailDriver: no real mail. Inbound goes through POST
//   <inboundEmails>, outbound is read from the app's test delivery list via
//   GET <mailDeliveries>?after=<cursor>. The test queue adapter runs nothing
//   by itself, so the driver drains the queue (POST <performEnqueuedJobs>)
//   after every send/reply and before every poll: that is what turns
//   deliver_later into actual deliveries.

/** The seam paths (relative to the app's base URL). */
export interface SeamPaths {
  signIn: string
  mailDeliveries: string
  performEnqueuedJobs: string
  inboundEmails: string
}

export const DEFAULT_SEAM_PATHS: SeamPaths = {
  signIn: "/test/sign_in_as",
  mailDeliveries: "/test/mail_deliveries",
  performEnqueuedJobs: "/test/perform_enqueued_jobs",
  inboundEmails: "/test/inbound_emails",
}

export interface SeamResponse {
  status: number
  /** Parsed JSON, or the raw text when the body is not JSON. */
  body: unknown
}

/** Minimal HTTP surface the driver needs; paths are relative to the server. */
export type SeamHttp = (
  method: "GET" | "POST",
  path: string,
  json?: unknown,
) => Promise<SeamResponse>

function parseBody(text: string): unknown {
  if (text === "") return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** The JSON body a request sends: `{}` for a POST without one. */
function jsonBody(method: "GET" | "POST", json: unknown): unknown {
  return json === undefined && method === "POST" ? {} : json
}

export type { FetchLike }

export interface SeamRequestOptions {
  /**
   * The longest one seam request may take, headers and body included.
   * Default 30 000 ms. A whole number of milliseconds from 1 to
   * 2 147 483 647; anything else is a ConfigError. Raise it when a job
   * drain (POST <performEnqueuedJobs>) legitimately takes longer.
   */
  requestTimeoutMs?: number
}

/**
 * SeamHttp over a Playwright APIRequestContext created with the baseURL.
 * Every call passes Playwright's own per-call `timeout` (requestTimeoutMs,
 * 30 s by default), which covers the body too: inside @playwright/test a
 * request context has no timeout of its own unless the project sets
 * `actionTimeout`. A timeout rejects with Playwright's error.
 *
 * Throws a ConfigError for a bad requestTimeoutMs (the message names the
 * option, never its value). Makes no request until called.
 */
export function seamHttpFromRequest(
  request: APIRequestContext,
  options: SeamRequestOptions = {},
): SeamHttp {
  const timeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  assertRequestTimeoutMs(timeout, "seamHttpFromRequest option requestTimeoutMs")
  return async (method, path, json) => {
    const body = jsonBody(method, json)
    const response = await request.fetch(path, {
      method,
      timeout,
      ...(body === undefined
        ? {}
        : { data: body, headers: { "Content-Type": "application/json" } }),
    })
    return { status: response.status(), body: parseBody(await response.text()) }
  }
}

/** The options of seamHttpFromFetch. */
export interface SeamFetchOptions extends SeamRequestOptions, BoundTimers {
  /** Default: the global fetch. */
  fetch?: FetchLike
}

/**
 * SeamHttp over fetch (global by default) against `baseURL`. The second
 * argument is either the fetch to use (the original form) or
 * SeamFetchOptions.
 *
 * Every request gets one AbortController and one unref'd timer of
 * requestTimeoutMs (30 s by default) over the headers and the whole body,
 * cleared however it ends. At the bound the request is aborted and the
 * call rejects with a plain Error naming the method, the path (without its
 * query) and the bound, never the body. Any other failure is passed on as
 * is; a non-2xx whose body cannot be read comes back with a null body.
 * Never retried.
 *
 * Throws a ConfigError for a bad requestTimeoutMs (the message names the
 * option, never its value). Makes no request until called.
 */
export function seamHttpFromFetch(
  baseURL: string,
  fetchOrOptions: FetchLike | SeamFetchOptions = {},
): SeamHttp {
  const options: SeamFetchOptions =
    typeof fetchOrOptions === "function"
      ? { fetch: fetchOrOptions }
      : fetchOrOptions
  const ms = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  assertRequestTimeoutMs(ms, "seamHttpFromFetch option requestTimeoutMs")
  const fetchImpl: FetchLike =
    options.fetch ?? ((input, init) => fetch(input, init))
  const timers: BoundTimers = {
    setTimeout: options.setTimeout,
    clearTimeout: options.clearTimeout,
  }
  return async (method, path, json) => {
    const body = jsonBody(method, json)
    const timeout = new Error(
      `Seam ${method} ${path.split("?")[0]} got no answer within ${formatBound(ms)}; raise requestTimeoutMs if a job drain legitimately takes longer`,
    )
    const reply = await fetchWithin(
      fetchImpl,
      new URL(path, baseURL).toString(),
      {
        method,
        headers:
          body === undefined
            ? { Accept: "application/json" }
            : {
                Accept: "application/json",
                "Content-Type": "application/json",
              },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      ms,
      timeout,
      timers,
    )
    return { status: reply.status, body: parseBody(reply.text) }
  }
}

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

export interface SeamSignInOptions {
  /** The JSON body (at least the seeded account's `email`). */
  body: Record<string, unknown>
  /**
   * Default DEFAULT_SEAM_PATHS.signIn. Keep it under /test/: the Rails
   * kit's gate tripwire covers only paths with a test/ segment.
   */
  path?: string
  /** Which statuses mean "signed in". Default: any 2xx. */
  accept?: (status: number) => boolean
  /** The LoginError text for a refused sign-in (never a password). */
  failure?: (status: number) => string
}

/**
 * Signs in through the sign-in seam in a fresh request context and returns
 * its storageState. Called once per persona by the AppAdapter; never
 * retried: any other status is a LoginError.
 */
export async function seamSignIn(
  api: APIRequest,
  baseURL: string,
  options: SeamSignInOptions,
): Promise<StorageState> {
  const path = options.path ?? DEFAULT_SEAM_PATHS.signIn
  const accept = options.accept ?? ((s: number) => s >= 200 && s < 300)
  const context = await api.newContext({ baseURL })
  try {
    const response = await context.post(path, { data: options.body })
    if (!accept(response.status())) {
      throw new LoginError(
        options.failure?.(response.status()) ??
          `Test sign-in (POST ${path}) returned HTTP ${response.status()}; is the development server (${baseURL}) running with the test seams enabled and the account seeded?`,
      )
    }
    return await context.storageState()
  } finally {
    await context.dispose()
  }
}

// ---------------------------------------------------------------------------
// The mail driver
// ---------------------------------------------------------------------------

export interface HttpSeamMailDriverOptions {
  http: SeamHttp
  /** Default per-hop wait. */
  defaultTimeoutMs: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Injectable for deterministic Message-IDs in unit tests. */
  uuid?: () => string
  /**
   * Override any seam path (defaults: DEFAULT_SEAM_PATHS). Keep every path
   * under /test/: the Rails kit's gate tripwire covers only paths with a
   * test/ segment.
   */
  paths?: Partial<Omit<SeamPaths, "signIn">>
  /**
   * The Message-ID of a mail the driver sends, from a fresh uuid, angle
   * brackets included. Default `<flowreel-<uuid>@flowreel.invalid>`.
   */
  messageId?: (uuid: string) => string
  /**
   * Other recipients a `to:` query also accepts: the app's development
   * mail sandbox may rewrite an external recipient to a catch-all address.
   * A match through one comes back with `sandboxed: true`. Default none.
   */
  alternateRecipients?: (to: string) => string[]
  /** Appended to a 404 failure: what to check (no secrets). */
  notFoundHint?: string
}

/** One entry of GET <mailDeliveries>. */
interface SeamDelivery {
  index?: number
  messageId?: string
  from?: string[]
  to?: string[]
  cc?: string[]
  replyTo?: string[]
  subject?: string
  text?: string
  inReplyTo?: string | null
  references?: string[]
  headers?: Record<string, string>
  deliveredAt?: string
}

interface DeliveriesBody {
  deliveries?: SeamDelivery[]
  cursor?: number
}

interface DrainBody {
  performed?: number
  discarded?: number
  errors?: { job?: string; error?: string }[]
}

const DEFAULT_NOT_FOUND_HINT =
  " (404: is the development server running with the test seams enabled: a local Rails environment and the seam flag set?)"

function bracketed(messageId: string | undefined): string {
  if (!messageId) return ""
  return messageId.startsWith("<") ? messageId : `<${messageId}>`
}

/** A delivery-list entry as a MailMessage. */
export function seamDeliveryToMailMessage(
  entry: SeamDelivery,
  fallbackId: number,
): MailMessage {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(entry.headers ?? {})) {
    headers[name.toLowerCase()] = value
  }
  // Prefer the From header: it keeps the display name.
  const fromHeader = headers.from
  return {
    id: String(entry.index ?? fallbackId),
    messageId: bracketed(entry.messageId),
    from: fromHeader?.includes("@") ? fromHeader : (entry.from?.[0] ?? ""),
    to: entry.to ?? [],
    cc: entry.cc ?? [],
    replyTo: entry.replyTo ?? [],
    subject: entry.subject ?? "",
    text: entry.text ?? "",
    inReplyTo: entry.inReplyTo ? bracketed(entry.inReplyTo) : undefined,
    references: entry.references?.map(bracketed),
    headers,
    receivedAt: entry.deliveredAt ?? "",
  }
}

/** The MailDriver of the development stage, over the HTTP test seams. */
export class HttpSeamMailDriver implements MailDriver {
  readonly kind = "seam" as const
  private readonly http: SeamHttp
  private readonly uuid: () => string
  private readonly paths: Omit<SeamPaths, "signIn">
  /** Every delivery seen so far, in delivery order. */
  private seen: MailMessage[] = []
  /** Server cursor from the previous response; undefined = from start. */
  private cursor: number | undefined
  /** Job errors reported by the drain, surfaced in timeout messages. */
  private drainErrors: string[] = []

  constructor(private readonly options: HttpSeamMailDriverOptions) {
    this.http = options.http
    this.uuid = options.uuid ?? (() => randomUUID())
    this.paths = {
      mailDeliveries: DEFAULT_SEAM_PATHS.mailDeliveries,
      performEnqueuedJobs: DEFAULT_SEAM_PATHS.performEnqueuedJobs,
      inboundEmails: DEFAULT_SEAM_PATHS.inboundEmails,
      ...options.paths,
    }
  }

  async health(): Promise<void> {
    const list = `GET ${this.paths.mailDeliveries}`
    const deliveries = await this.http("GET", this.paths.mailDeliveries)
    if (deliveries.status !== 200) {
      throw new Error(
        `Mail seam health check failed: ${this.describeFailure(list, deliveries)}`,
      )
    }
    const drainCall = `POST ${this.paths.performEnqueuedJobs}`
    const drain = await this.http("POST", this.paths.performEnqueuedJobs)
    if (drain.status !== 200) {
      throw new Error(
        `Mail seam health check failed: ${this.describeFailure(drainCall, drain)}`,
      )
    }
  }

  async send(mail: OutgoingMail): Promise<SendResult> {
    const messageId = this.newMessageId()
    await this.postInbound("send", {
      mode: "support_address",
      to: mail.to,
      from: mail.from,
      subject: mail.subject,
      body: mail.text,
      message_id: messageId,
      ...(mail.headers ? { headers: mail.headers } : {}),
      ...(mail.attachments ? { attachments: mail.attachments } : {}),
    })
    await this.drain()
    return { messageId }
  }

  async reply(original: MailMessage, mail: ReplyMail): Promise<SendResult> {
    const messageId = this.newMessageId()
    await this.postInbound("reply", {
      mode: "raw",
      to: addressOf(original.replyTo[0] ?? original.from),
      from: mail.from,
      subject: `Re: ${original.subject}`,
      body: mail.text,
      message_id: messageId,
      in_reply_to: original.messageId,
      references: [...(original.references ?? []), original.messageId],
    })
    await this.drain()
    return { messageId }
  }

  /**
   * Polls the delivery list (draining the queue first) until a message
   * matches every criterion of `query`. A match through one of the
   * `alternateRecipients` comes back with `sandboxed: true`.
   */
  async waitFor(query: MailQuery): Promise<MailMessage> {
    const alternates =
      query.to !== undefined
        ? (this.options.alternateRecipients?.(query.to) ?? [])
        : []
    // deliveredAt may come from the Date header (second precision): floor
    // `since` to the second so a same-second delivery is not dropped.
    const guarded: MailQuery = {
      ...query,
      since: new Date(Math.floor(query.since.getTime() / 1000) * 1000),
    }
    return poll<MailMessage>(
      async () => {
        await this.drain()
        await this.fetchNew()
        for (const message of this.seen) {
          const outcome = matchMessage(message, guarded, alternates)
          if (outcome === "direct") return { value: message }
          if (outcome === "alternate") {
            return { value: { ...message, sandboxed: true } }
          }
        }
        const errors =
          this.drainErrors.length > 0
            ? `; job errors: ${this.drainErrors.slice(-3).join(" | ")}`
            : ""
        return {
          observed: describeCandidates(this.seen, guarded.since) + errors,
        }
      },
      {
        waitingFor: describeQuery(query),
        timeoutMs: query.timeoutMs ?? this.options.defaultTimeoutMs,
        now: this.options.now,
        sleep: this.options.sleep,
      },
    )
  }

  private newMessageId(): string {
    const uuid = this.uuid()
    return this.options.messageId
      ? this.options.messageId(uuid)
      : `<flowreel-${uuid}@flowreel.invalid>`
  }

  private describeFailure(call: string, response: SeamResponse): string {
    const hint =
      response.status === 404
        ? (this.options.notFoundHint ?? DEFAULT_NOT_FOUND_HINT)
        : ""
    const body =
      response.body && typeof response.body === "object"
        ? ` ${JSON.stringify(response.body)}`
        : ""
    return `${call} returned HTTP ${response.status}${hint}${body}`
  }

  /** Never retried: a retry can create a duplicate record. */
  private async postInbound(
    action: "send" | "reply",
    payload: Record<string, unknown>,
  ): Promise<void> {
    const path = this.paths.inboundEmails
    const response = await this.http("POST", path, payload)
    if (response.status === 201) return
    if (response.status === 422) {
      const body = (response.body ?? {}) as Record<string, unknown>
      const fields = ["mailbox", "outcome", "reason", "status"]
        .filter((key) => body[key] !== undefined && body[key] !== null)
        .map((key) => `${key}=${String(body[key])}`)
        .join(" ")
      throw new Error(
        `Mail seam ${action} (mode=${String(payload.mode)}) was not captured: ${fields || "no details"}`,
      )
    }
    throw new Error(
      `Mail seam ${action} failed: ${this.describeFailure(`POST ${path}`, response)}`,
    )
  }

  /** POST <performEnqueuedJobs>. Per-job errors are recorded, not thrown. */
  private async drain(): Promise<void> {
    const path = this.paths.performEnqueuedJobs
    const response = await this.http("POST", path)
    if (response.status !== 200) {
      throw new Error(
        `Job drain failed: ${this.describeFailure(`POST ${path}`, response)}`,
      )
    }
    const body = (response.body ?? {}) as DrainBody
    for (const e of body.errors ?? []) {
      this.drainErrors.push(`${e.job ?? "job"}: ${e.error ?? "error"}`)
    }
  }

  /** GET <mailDeliveries>?after=<cursor>; appends to `seen`. */
  private async fetchNew(): Promise<void> {
    const base = this.paths.mailDeliveries
    const path =
      this.cursor === undefined ? base : `${base}?after=${this.cursor}`
    const response = await this.http("GET", path)
    if (response.status !== 200) {
      throw new Error(
        `Reading deliveries failed: ${this.describeFailure(`GET ${path}`, response)}`,
      )
    }
    const body = (response.body ?? {}) as DeliveriesBody
    if (
      this.cursor !== undefined &&
      typeof body.cursor === "number" &&
      body.cursor < this.cursor
    ) {
      // The list was cleared since our last read: start over.
      this.seen = []
      this.cursor = undefined
      return this.fetchNew()
    }
    for (const entry of body.deliveries ?? []) {
      this.seen.push(seamDeliveryToMailMessage(entry, this.seen.length))
    }
    if (typeof body.cursor === "number") this.cursor = body.cursor
  }
}
