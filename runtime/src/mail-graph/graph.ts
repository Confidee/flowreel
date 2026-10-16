// SPDX-License-Identifier: Apache-2.0

import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { SendRefusedError } from "../core/errors.js"
import { poll } from "../core/poll.js"
import {
  DEFAULT_SEND_GUARD_COPY,
  type SendGuardCopy,
  assertReplyDomainRecipient,
} from "../mail/guard.js"
import { addressOf, describeQuery, matchMessage } from "../mail/match.js"
import type {
  MailDriver,
  MailMessage,
  MailQuery,
  OutgoingMail,
  ReplyMail,
  SendResult,
} from "../mail/types.js"

// The staging mail driver: one Microsoft 365 mailbox (the QA mailbox) that
// is both the requester the flows send as and where the app's staging mail
// to the personas lands, driven app-only (client credentials) through
// Microsoft Graph. The app registration must be scoped to that mailbox
// alone (an application access policy, or RBAC for Applications; see
// docs/adapters.md). Every send and reply passes the reply-domain guard
// (mail/guard.ts) BEFORE any request, so a run can never mail a real
// mailbox such as the product's support address. Errors carry the HTTP
// status and the Graph error code but NEVER the access token or the client
// secret.
//
// The QA mailbox may also be the staging sandbox sink (where every
// redirected staging mail lands), so waitFor reads as little of it as it
// can: the list asks Graph for the run's own subject (a record number or
// the run id) and only id, subject and time; body, recipients and headers
// are fetched per message, only for one whose subject matched; and a
// timeout reports counts, never another mail's subject or recipients (that
// text reaches summary.md, the gate evidence).

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0"
const TOKEN_SKEW_MS = 60_000
const TOKEN_OPERATION = "token request"
// Throttling / gateway blips on the waitFor list READ are re-polled. Sends and
// replies are never retried (a retry can mail twice); auth, permission and
// token errors are real failures, so they stay fatal too.
const TRANSIENT_READ_STATUSES = new Set([429, 503, 504])
// The list: just enough to pick the harness's own mail by subject and time.
const LIST_FIELDS = ["id", "subject", "receivedDateTime"].join(",")
// One candidate whose subject matched: everything matching and the flows need.
const MESSAGE_FIELDS = [
  "id",
  "internetMessageId",
  "subject",
  "from",
  "toRecipients",
  "ccRecipients",
  "replyTo",
  "receivedDateTime",
  "body",
  "internetMessageHeaders",
].join(",")
const TEXT_BODY = { Prefer: 'outlook.body-content-type="text"' }

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** The wording of the driver's refusals and hints that a project may tailor. */
export interface GraphDriverCopy {
  /** The send guard's refusal wording (mail/guard.ts). */
  guard: SendGuardCopy
  /**
   * Appended to a failed health check: what to check, by setting name
   * (never a value).
   */
  healthHint: string
  /** The refusal of a waitFor without `subjectIncludes`. */
  subjectRequired: string
}

export const DEFAULT_GRAPH_DRIVER_COPY: GraphDriverCopy = {
  guard: DEFAULT_SEND_GUARD_COPY,
  healthHint:
    "Check the tenant id, client id and client secret, and the app's mailbox scope: with RBAC for Applications, an Application Mail Full Access assignment scoped to the mailbox and no Entra Mail.* consent (a change can take up to 2 hours to reach live calls); with an existing application access policy, the Entra consent and the policy group.",
  subjectRequired:
    "Graph waitFor needs subjectIncludes (a record number or the run id): the driver never reads mail it cannot tie to this run.",
}

export interface GraphMailDriverOptions {
  /** Directory (tenant) id of the app registration. */
  tenantId: string
  /** Application (client) id. */
  clientId: string
  /** A client secret of the app (client-credentials grant). */
  clientSecret: string
  /** The QA mailbox (UPN or SMTP address). */
  mailbox: string
  /** The only domain send/reply may address (the staging reply domain). */
  replyDomain: string
  /** Default per-hop wait. */
  defaultTimeoutMs: number
  /** Override any of the refusal and hint wording. */
  copy?: Partial<GraphDriverCopy>
  fetch?: FetchLike
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

interface GraphRecipient {
  emailAddress?: { name?: string; address?: string }
}

interface GraphMessage {
  id: string
  internetMessageId?: string
  subject?: string
  from?: GraphRecipient
  toRecipients?: GraphRecipient[]
  ccRecipients?: GraphRecipient[]
  replyTo?: GraphRecipient[]
  receivedDateTime?: string
  body?: { contentType?: string; content?: string }
  internetMessageHeaders?: { name: string; value: string }[]
}

/** A non-2xx Graph/AAD response. The message is already redacted. */
export class GraphHttpError extends Error {
  constructor(
    message: string,
    readonly operation: string,
    readonly status: number,
    /** From Retry-After (seconds or HTTP date), when the response sent one. */
    readonly retryAfterMs: number | undefined,
  ) {
    super(message)
    this.name = "GraphHttpError"
  }
}

function parseRetryAfter(
  value: string | null,
  now: number,
): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const at = Date.parse(value)
  return Number.isNaN(at) ? undefined : Math.max(0, at - now)
}

/** "Name <a@b>" when Graph gives a display name. */
function formatSender(recipient: GraphRecipient | undefined): string {
  const address = recipient?.emailAddress?.address ?? ""
  const name = recipient?.emailAddress?.name
  return name && name !== address ? `${name} <${address}>` : address
}

function addresses(list: GraphRecipient[] | undefined): string[] {
  return (list ?? [])
    .map((r) => r.emailAddress?.address ?? "")
    .filter((a) => a !== "")
}

/**
 * Bare addresses in a raw To/Cc header. Splits on commas outside quotes and
 * angle brackets, so a quoted "Doe, Jane" display name stays one entry.
 */
export function headerAddresses(value: string | undefined): string[] {
  if (!value) return []
  const parts: string[] = []
  let current = ""
  let quoted = false
  let angle = false
  for (const char of value) {
    if (char === '"') quoted = !quoted
    else if (char === "<" && !quoted) angle = true
    else if (char === ">" && !quoted) angle = false
    if (char === "," && !quoted && !angle) {
      parts.push(current)
      current = ""
    } else {
      current += char
    }
  }
  parts.push(current)
  return parts.map(addressOf).filter((a) => a.includes("@"))
}

/** Case-insensitive union, first spelling wins, order preserved. */
function union(...lists: string[][]): string[] {
  const seen = new Set<string>()
  return lists.flat().filter((address) => {
    const key = address.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function toMailMessage(graph: GraphMessage): MailMessage {
  const headers: Record<string, string> = {}
  for (const h of graph.internetMessageHeaders ?? []) {
    headers[h.name.toLowerCase()] = h.value
  }
  const references = headers.references?.split(/\s+/).filter(Boolean)
  // Exchange may list the resolved mailbox (qa@) in toRecipients for a
  // plus-addressed delivery (qa+agent@); the raw header keeps the form the
  // sender used, so matching sees both (a flow may wait on `to: qa+agent@`).
  return {
    id: graph.id,
    messageId: graph.internetMessageId ?? headers["message-id"] ?? "",
    from: formatSender(graph.from),
    to: union(addresses(graph.toRecipients), headerAddresses(headers.to)),
    cc: union(addresses(graph.ccRecipients), headerAddresses(headers.cc)),
    replyTo: addresses(graph.replyTo),
    subject: graph.subject ?? "",
    text: graph.body?.content ?? "",
    inReplyTo: headers["in-reply-to"],
    references,
    headers,
    receivedAt: graph.receivedDateTime ?? "",
  }
}

/** Graph `$filter` takes second precision; flooring keeps `ge` inclusive. */
function graphInstant(date: Date): string {
  return new Date(Math.floor(date.getTime() / 1000) * 1000)
    .toISOString()
    .replace(".000Z", "Z")
}

function slugify(subject: string): string {
  const slug = subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
  return slug || "message"
}

export class GraphMailDriver implements MailDriver {
  readonly kind = "graph" as const
  private readonly fetchImpl: FetchLike
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private token: { value: string; expiresAt: number } | null = null
  private pendingToken: Promise<string> | null = null
  private savedCount = 0
  /** Cleared once Graph refuses `contains(subject,…)` (see listSince). */
  private subjectFilter = true
  private readonly copy: GraphDriverCopy

  constructor(private readonly options: GraphMailDriverOptions) {
    this.copy = { ...DEFAULT_GRAPH_DRIVER_COPY, ...options.copy }
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init))
    this.now = options.now ?? (() => Date.now())
    this.sleep =
      options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  async health(): Promise<void> {
    try {
      // Only an id: proves read access without reading anyone's mail.
      await this.graph(
        "GET",
        `${this.mailboxPath()}/messages?$top=1&$select=id`,
      )
    } catch (error) {
      throw new Error(
        `Graph mailbox health check failed for ${this.options.mailbox}: ${(error as Error).message}. ${this.copy.healthHint}`,
        { cause: error },
      )
    }
  }

  /**
   * Sends from the mailbox itself; only a `from` other than the mailbox (an
   * alias of it) sets `from` and so needs the tenant's
   * SendFromAliasEnabled. Graph's sendMail is 202-with-no-body and forbids
   * setting Message-ID, so callers correlate by subject / run id and the
   * result's messageId is "".
   */
  async send(mail: OutgoingMail): Promise<SendResult> {
    const to = assertReplyDomainRecipient(
      mail.to,
      this.options.replyDomain,
      this.copy.guard,
    )
    // Graph cannot set the automated-mail headers, and files are sent only
    // through the local seam: refused before any request.
    if (mail.headers || mail.attachments) {
      throw new SendRefusedError(
        "Refusing to send extra headers or attachments through Graph: those flows are development only (the local seam).",
      )
    }
    await this.graph("POST", `${this.mailboxPath()}/sendMail`, {
      message: {
        subject: mail.subject,
        body: { contentType: "Text", content: mail.text },
        ...this.fromField(mail.from),
        toRecipients: [{ emailAddress: { address: to } }],
      },
      saveToSentItems: false,
    })
    return { messageId: "" }
  }

  /**
   * Polls the mailbox for a message matching every criterion of `query`,
   * which must name a subject (data minimisation, see the header): Graph is
   * asked for that subject server-side, and a message's body, recipients and
   * headers are read only once its subject matched.
   */
  async waitFor(query: MailQuery): Promise<MailMessage> {
    const subject = query.subjectIncludes
    if (!subject) {
      throw new Error(this.copy.subjectRequired)
    }
    // receivedDateTime has second precision: floor `since` for the client-side
    // match too, or a same-second message the $filter returned is dropped.
    const guarded: MailQuery = {
      ...query,
      since: new Date(Math.floor(query.since.getTime() / 1000) * 1000),
    }
    const timeoutMs = query.timeoutMs ?? this.options.defaultTimeoutMs
    const deadline = this.now() + timeoutMs
    // A message's content does not change: fetch each candidate once.
    const fetched = new Map<string, MailMessage>()
    return poll<MailMessage>(
      async () => {
        try {
          const candidates = (await this.listSince(guarded.since, subject))
            .filter((m) => (m.subject ?? "").includes(subject))
            .filter((m) => !guarded.excludeIds?.includes(m.id))
            .filter(
              (m) =>
                Date.parse(m.receivedDateTime ?? "") >= guarded.since.getTime(),
            )
          for (const candidate of candidates) {
            let message = fetched.get(candidate.id)
            if (!message) {
              message = toMailMessage(
                (await this.graph(
                  "GET",
                  `${this.mailboxPath()}/messages/${encodeURIComponent(candidate.id)}?$select=${MESSAGE_FIELDS}`,
                  undefined,
                  TEXT_BODY,
                )) as GraphMessage,
              )
              fetched.set(candidate.id, message)
            }
            if (matchMessage(message, guarded) !== "none") {
              return { value: message }
            }
          }
          // Counts only: the candidates are this run's own mail, but nothing
          // about any message reaches the TimeoutError (and so summary.md).
          return {
            observed:
              candidates.length === 0
                ? `no message with ${JSON.stringify(subject)} in the subject since the query start`
                : `${candidates.length} message(s) with ${JSON.stringify(subject)} in the subject since the query start, none matching`,
          }
        } catch (error) {
          if (!this.isTransientRead(error)) throw error
          const wait = Math.min(
            error.retryAfterMs ?? 0,
            Math.max(0, deadline - this.now()),
          )
          if (wait > 0) await this.sleep(wait)
          return { observed: `Graph HTTP ${error.status}, retrying` }
        }
      },
      {
        waitingFor: describeQuery(query),
        timeoutMs,
        now: this.options.now,
        sleep: this.options.sleep,
      },
    )
  }

  /**
   * id/subject/receivedDateTime of the newest 50 messages since `since`,
   * narrowed server-side to `subject` (receivedDateTime first, as Graph
   * requires of a property that is also the $orderby). Should Graph refuse
   * the contains() clause (HTTP 400), the driver drops it for the rest of the
   * run and narrows client-side: still only the three list fields.
   */
  private async listSince(
    since: Date,
    subject: string,
  ): Promise<GraphMessage[]> {
    let filter = `receivedDateTime ge ${graphInstant(since)}`
    if (this.subjectFilter) {
      filter += ` and contains(subject,'${subject.replaceAll("'", "''")}')`
    }
    const path =
      `${this.mailboxPath()}/messages` +
      `?$filter=${encodeURIComponent(filter)}` +
      `&$orderby=${encodeURIComponent("receivedDateTime desc")}` +
      `&$top=50&$select=${LIST_FIELDS}`
    try {
      const body = (await this.graph("GET", path)) as {
        value?: GraphMessage[]
      } | null
      return body?.value ?? []
    } catch (error) {
      if (
        !this.subjectFilter ||
        !(error instanceof GraphHttpError) ||
        error.operation === TOKEN_OPERATION ||
        error.status !== 400
      ) {
        throw error
      }
      this.subjectFilter = false
      return this.listSince(since, subject)
    }
  }

  /**
   * createReply -> PATCH (recipient, empty Cc/Bcc, text body, From only for
   * an alias) -> send. Graph sets In-Reply-To/References from the original
   * on createReply. The recipient (Reply-To, else From) passes the guard
   * before the draft exists: an app mail without Reply-To would otherwise
   * be answered at its From, the real support address.
   */
  async reply(original: MailMessage, mail: ReplyMail): Promise<SendResult> {
    const to = assertReplyDomainRecipient(
      addressOf(original.replyTo[0] ?? original.from),
      this.options.replyDomain,
      this.copy.guard,
    )
    const messages = `${this.mailboxPath()}/messages`
    const draft = (await this.graph(
      "POST",
      `${messages}/${encodeURIComponent(original.id)}/createReply`,
    )) as GraphMessage
    const draftPath = `${messages}/${encodeURIComponent(draft.id)}`
    // Cc/Bcc cleared explicitly: the single guarded recipient must not depend
    // on what Exchange put on the draft.
    const patched = (await this.graph("PATCH", draftPath, {
      toRecipients: [{ emailAddress: { address: to } }],
      ccRecipients: [],
      bccRecipients: [],
      ...this.fromField(mail.from),
      body: { contentType: "Text", content: mail.text },
    })) as Partial<GraphMessage> | null
    await this.graph("POST", `${draftPath}/send`)
    return { messageId: patched?.internetMessageId ?? "" }
  }

  async saveEml(message: MailMessage, dir: string): Promise<string | null> {
    const raw = await this.graphText(
      `${this.mailboxPath()}/messages/${encodeURIComponent(message.id)}/$value`,
    )
    await mkdir(dir, { recursive: true })
    this.savedCount += 1
    const n = String(this.savedCount).padStart(2, "0")
    const file = join(dir, `${n}-${slugify(message.subject)}.eml`)
    await writeFile(file, raw)
    return file
  }

  private isTransientRead(error: unknown): error is GraphHttpError {
    return (
      error instanceof GraphHttpError &&
      error.operation !== TOKEN_OPERATION &&
      TRANSIENT_READ_STATUSES.has(error.status)
    )
  }

  /** No `from` when sending as the mailbox itself (no send-as needed). */
  private fromField(from: string): { from?: GraphRecipient } {
    const address = addressOf(from).toLowerCase()
    return address === this.options.mailbox.toLowerCase()
      ? {}
      : { from: { emailAddress: { address } } }
  }

  private mailboxPath(): string {
    return `/users/${encodeURIComponent(this.options.mailbox)}`
  }

  /** Client-credentials token, cached until 60 s before expiry. */
  private async accessToken(): Promise<string> {
    if (this.token && this.now() < this.token.expiresAt - TOKEN_SKEW_MS) {
      return this.token.value
    }
    this.pendingToken ??= this.fetchToken().finally(() => {
      this.pendingToken = null
    })
    return this.pendingToken
  }

  private async fetchToken(): Promise<string> {
    const { tenantId, clientId, clientSecret } = this.options
    const url = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`
    const requestedAt = this.now()
    const response = await this.call(TOKEN_OPERATION, url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }).toString(),
    })
    let body: { access_token?: string; expires_in?: number }
    try {
      body = (await response.json()) as typeof body
    } catch {
      throw new Error(
        `Graph token request returned a non-JSON ${response.status} body (${response.headers.get("content-type") ?? "unknown type"})`,
      )
    }
    if (!body.access_token) {
      throw new Error("Graph token request failed: no access_token returned")
    }
    this.token = {
      value: body.access_token,
      expiresAt: requestedAt + (body.expires_in ?? 0) * 1000,
    }
    return body.access_token
  }

  private async graph(
    method: string,
    path: string,
    json?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<unknown> {
    const token = await this.accessToken()
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      ...extraHeaders,
    }
    if (json !== undefined) headers["Content-Type"] = "application/json"
    const operation = `${method} ${path.split("?")[0]}`
    const response = await this.call(operation, `${GRAPH_BASE}${path}`, {
      method,
      headers,
      body: json === undefined ? undefined : JSON.stringify(json),
    })
    const text = await response.text()
    if (text === "") return null
    try {
      return JSON.parse(text) as unknown
    } catch {
      // A proxy/login interstitial or HTML error page: name the call, never
      // echo the body.
      const type = response.headers.get("content-type") ?? "unknown type"
      throw new Error(
        this.redact(
          `Graph ${operation} returned a non-JSON ${response.status} body (${type})`,
        ),
      )
    }
  }

  private async graphText(path: string): Promise<string> {
    const token = await this.accessToken()
    const response = await this.call(`GET ${path}`, `${GRAPH_BASE}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    })
    return response.text()
  }

  /** fetch + non-2xx mapping; every message passes through redact(). */
  private async call(
    operation: string,
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    let response: Response
    try {
      response = await this.fetchImpl(url, init)
    } catch (error) {
      // No `cause`: a transport error's message/stack may echo the request
      // (Authorization header); only the redacted text may leave this method.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(
        this.redact(
          `Graph ${operation} failed: ${(error as Error).message ?? error}`,
        ),
      )
    }
    if (response.ok) return response

    const detail = await errorDetail(response)
    throw new GraphHttpError(
      this.redact(
        `Graph ${operation} failed: HTTP ${response.status}${detail ? ` ${detail}` : ""}`,
      ),
      operation,
      response.status,
      parseRetryAfter(response.headers.get("retry-after"), this.now()),
    )
  }

  private redact(message: string): string {
    let out = message.replace(
      /Bearer\s+[A-Za-z0-9._~+/=-]+/g,
      "Bearer [redacted]",
    )
    for (const secret of [this.token?.value, this.options.clientSecret]) {
      if (secret) out = out.split(secret).join("[redacted]")
    }
    return out
  }
}

/** Graph `{error:{code,message}}` or AAD `{error, error_description}`. */
async function errorDetail(response: Response): Promise<string> {
  let text: string
  try {
    text = await response.text()
  } catch {
    return ""
  }
  try {
    const body = JSON.parse(text) as {
      error?: string | { code?: string; message?: string }
      error_description?: string
    }
    if (typeof body.error === "object" && body.error !== null) {
      const message = body.error.message
        ? `: ${body.error.message.slice(0, 200)}`
        : ""
      return `${body.error.code ?? "UnknownError"}${message}`
    }
    if (typeof body.error === "string") {
      // AAD descriptions start with the AADSTS code; keep the first line.
      const description = body.error_description?.split(/\r?\n/)[0] ?? ""
      return `${body.error}${description ? `: ${description.slice(0, 200)}` : ""}`
    }
  } catch {
    // Not JSON: fall through with no detail rather than echoing a body.
  }
  return ""
}
