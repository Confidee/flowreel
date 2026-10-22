// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { SendRefusedError } from "../core/errors.js"
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  type FetchLike,
  type TimerHandle,
  assertRequestTimeoutMs,
  fetchWithin,
  formatBound,
} from "../core/http.js"
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
import {
  GraphHttpError,
  GraphRequestError,
  GraphRequestTimeoutError,
  GraphTransportError,
  oneLine,
} from "./errors.js"
import {
  TOKEN_OPERATION,
  isTransientRead,
  isTransientToken,
  isTransientTransport,
  noteTransportCause,
  statusMayHaveSent,
  tokenBackoffMs,
  transportCode,
  transportMayHaveSent,
} from "./outcome.js"

export {
  GraphHttpError,
  type GraphHttpErrorDetails,
  GraphRequestError,
  GraphRequestTimeoutError,
  GraphTransportError,
} from "./errors.js"
export type { FetchLike }

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
// Every request, the token request included, is bounded as a whole: from
// the connection to the last byte of the body it gets requestTimeoutMs
// (30 s by default), and inside waitFor never more than the wait has left.
// A request that runs out is aborted and ends in a GraphRequestTimeoutError.
// Every request carries a fresh client-request-id, and every error the
// driver throws is a GraphRequestError naming it. No request follows a
// redirect (`redirect: "manual"`): a 3xx is a failure that sent nothing.
//
// Nothing is retried except inside waitFor: its reads, and its token
// request when that is throttled or meets a server error. A send (sendMail,
// a reply draft's /send) is never retried. Whether a failed send may have
// gone out is decided from what was observed (outcome.ts): a 2xx status
// means sent; a 3xx, a 4xx, 509 and a DNS, connect or TLS failure mean not
// sent; any other 5xx, any other transport failure and no answer mean it
// may have been sent (mayHaveSent), and the message says so and names the
// ids Microsoft support needs.
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
const SEND_HINT =
  ". The mail may have been sent; it is not retried, because a second send could mail twice."
const NO_CONNECTION_HINT =
  "Could not connect, which is a network problem, not a credentials one: check the network path (proxy, firewall, DNS, TLS inspection) from this machine to login.microsoftonline.com and graph.microsoft.com."
const NO_ANSWER_HINT =
  "No answer is a network or timeout problem, not a credentials one: check the network path (proxy, firewall, DNS) from this machine to login.microsoftonline.com and graph.microsoft.com."
/**
 * Transport errors proven never to have left this machine (DNS, connect,
 * TLS): health() blames the network for them, not the credentials.
 */
const NEVER_CONNECTED = new WeakSet<GraphTransportError>()
/** A server-side id (request-id, trace_id, correlation_id): a GUID, nothing else. */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
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
  /**
   * The longest one request may take, from the connection to the last byte
   * of the body, the token request included. Default 30 000 ms. A whole
   * number of milliseconds from 1 to 2 147 483 647; anything else is a
   * ConfigError. Inside waitFor a request also never outlives the wait.
   */
  requestTimeoutMs?: number
  /** Override any of the refusal and hint wording. */
  copy?: Partial<GraphDriverCopy>
  /**
   * For tests, or a project's own transport. It must make one attempt per
   * call and never follow a redirect: honour `redirect: "manual"`.
   */
  fetch?: FetchLike
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Arms a request's bound. Default: setTimeout, unref'd. For tests. */
  setTimeout?: (fn: () => void, ms: number) => TimerHandle
  /** Default: clearTimeout. */
  clearTimeout?: (timer: TimerHandle) => void
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

/** What a Graph request sends and how it is bounded. */
interface GraphRequest {
  json?: unknown
  headers?: Record<string, string>
  /** A wait's deadline (in now() time): the request never outlives it. */
  deadline?: number
  /** The request sends mail: a timeout may have sent it. */
  sends?: boolean
}

/**
 * A transport error's own message plus, when it has one, the system error
 * code (ECONNREFUSED, UND_ERR_SOCKET): nothing else of the cause, which may
 * echo the request.
 */
function describeTransportError(
  error: unknown,
  code: string | undefined,
): string {
  const message =
    (error as { message?: unknown } | null)?.message ?? String(error)
  return code === undefined ? String(message) : `${String(message)} (${code})`
}

/** `value` when it is a GUID, else undefined. */
function guid(value: unknown): string | undefined {
  return typeof value === "string" && GUID.test(value) ? value : undefined
}

/** A Date header as an ISO 8601 instant, when it parses. */
function isoDate(value: string | null): string | undefined {
  if (!value) return undefined
  const at = Date.parse(value)
  return Number.isNaN(at) ? undefined : new Date(at).toISOString()
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
  private readonly requestTimeoutMs: number
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle
  private readonly clearTimer: (timer: TimerHandle) => void
  private token: { value: string; expiresAt: number } | null = null
  private pendingToken: Promise<string> | null = null
  private savedCount = 0
  /**
   * The endpoints that answered this driver at least once (a status line,
   * whatever the status): only then may waitFor re-poll a transient
   * transport error on them (#23). First contact fails fast.
   */
  private readonly answered = new Set<"token" | "graph">()
  /** Cleared once Graph refuses `contains(subject,…)` (see listSince). */
  private subjectFilter = true
  private readonly copy: GraphDriverCopy

  /**
   * Throws a ConfigError when requestTimeoutMs is not a whole number of
   * milliseconds from 1 to 2 147 483 647 (the message names the option,
   * never its value). Makes no request.
   */
  constructor(private readonly options: GraphMailDriverOptions) {
    const requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    assertRequestTimeoutMs(
      requestTimeoutMs,
      "GraphMailDriver option requestTimeoutMs",
    )
    this.requestTimeoutMs = requestTimeoutMs
    this.setTimer = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer =
      options.clearTimeout ??
      ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
    this.copy = { ...DEFAULT_GRAPH_DRIVER_COPY, ...options.copy }
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init))
    this.now = options.now ?? (() => Date.now())
    this.sleep =
      options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  /**
   * Requests a token and reads one message id. A failure names the mailbox
   * and adds what to check: the credentials and mailbox scope
   * (copy.healthHint), or, when a request got no answer, the network path.
   */
  async health(): Promise<void> {
    try {
      // Only an id: proves read access without reading anyone's mail.
      await this.graph(
        "GET",
        `${this.mailboxPath()}/messages?$top=1&$select=id`,
      )
    } catch (error) {
      // A request that got no answer, or could not connect, says nothing
      // about the credentials.
      const hint =
        error instanceof GraphRequestTimeoutError
          ? NO_ANSWER_HINT
          : error instanceof GraphTransportError && NEVER_CONNECTED.has(error)
            ? NO_CONNECTION_HINT
            : this.copy.healthHint
      throw new Error(
        `Graph mailbox health check failed for ${this.options.mailbox}: ${(error as Error).message}. ${hint}`,
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
   *
   * Never retried. A 2xx status means sent, even if its (empty) body then
   * fails. A failure that leaves the outcome open (no answer, any 5xx but
   * 509, a transport failure after the connection) throws a
   * GraphRequestError with mayHaveSent true, whose message says so and
   * names the client-request-id; a 3xx, a 4xx, 509, or a DNS, connect or
   * TLS failure has mayHaveSent false.
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
      json: {
        message: {
          subject: mail.subject,
          body: { contentType: "Text", content: mail.text },
          ...this.fromField(mail.from),
          toRecipients: [{ emailAddress: { address: to } }],
        },
        saveToSentItems: false,
      },
      sends: true,
    })
    return { messageId: "" }
  }

  /**
   * Polls the mailbox for a message matching every criterion of `query`,
   * which must name a subject (data minimisation, see the header): Graph is
   * asked for that subject server-side, and a message's body, recipients and
   * headers are read only once its subject matched.
   *
   * Each request gets at most what the wait has left (at least 1 ms). The
   * first attempt always runs; after it, no request is issued once nothing
   * is left, and the last state observed is reported. A read that got no
   * answer, a throttle (429) or a gateway blip (503, 504) is re-polled. A
   * token request that got no answer, was throttled (429), met a server
   * error (500, 502, 503, 504) or was told temporarily_unavailable is
   * re-polled after Retry-After when sent, else after 5 s, 10 s, 20 s … up
   * to 60 s; never past the wait's end. A temporary network failure on a
   * read or the token request (outcome.ts's allowlist: a reset or closed
   * connection, a timeout, a transient DNS answer) gets the same back-off
   * (#23), counted apart for the token and the reads, once that endpoint
   * has answered this driver: at first contact it ends the wait, so a
   * firewall or broken DNS fails fast. Any other failure ends the wait at
   * once. What a re-poll observed is reported count-only: the step, an OS
   * or undici code and a count, never an error's text.
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
    /** Consecutive transient token failures: the back-off doubles with each. */
    let tokenFailures = 0
    /** Consecutive transient transport failures of the reads (#23). */
    let readFailures = 0
    /** Whether a list read completed in this wait, for what is observed. */
    let listed = false
    let lastObserved: string | undefined
    const observe = (observed: string) => {
      lastObserved = observed
      return { observed }
    }
    return poll<MailMessage>(
      async () => {
        // Out of time (poll's back-off ends on the deadline): report the last
        // state rather than start a request the wait could not see finish.
        if (lastObserved !== undefined && deadline - this.now() <= 0) {
          return { observed: lastObserved }
        }
        try {
          // A token in hand ends a run of token failures: only consecutive
          // ones double the back-off.
          await this.accessToken(deadline)
          tokenFailures = 0
          const list = await this.listSince(guarded.since, subject, deadline)
          listed = true
          const candidates = list
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
                  { headers: TEXT_BODY, deadline },
                )) as GraphMessage,
              )
              fetched.set(candidate.id, message)
            }
            if (matchMessage(message, guarded) !== "none") {
              return { value: message }
            }
          }
          // A completed poll ends a run of read failures.
          readFailures = 0
          // Counts only: the candidates are this run's own mail, but nothing
          // about any message reaches the TimeoutError (and so summary.md).
          return observe(
            candidates.length === 0
              ? `no message with ${JSON.stringify(subject)} in the subject since the query start`
              : `${candidates.length} message(s) with ${JSON.stringify(subject)} in the subject since the query start, none matching`,
          )
        } catch (error) {
          if (isTransientTransport(error)) {
            const token = error.operation === TOKEN_OPERATION
            if (!this.answered.has(token ? "token" : "graph")) throw error
            const failures = token ? ++tokenFailures : ++readFailures
            const wait = tokenBackoffMs(
              undefined,
              failures,
              deadline - this.now(),
            )
            if (wait > 0) await this.sleep(wait)
            // The step, the code (allowlisted) and the count: never the
            // error's text, which can name a host or a peer.
            return observe(
              token
                ? `Graph token request failed (${error.code}), ${failures} in a row, retrying`
                : `Graph read failed (${error.code}), ${failures} in a row${listed ? "" : ", no mailbox read completed in this wait"}, retrying`,
            )
          }
          if (isTransientToken(error)) {
            tokenFailures += 1
            const wait = tokenBackoffMs(
              error instanceof GraphHttpError ? error.retryAfterMs : undefined,
              tokenFailures,
              deadline - this.now(),
            )
            if (wait > 0) await this.sleep(wait)
            // Count-only: never the error's text (an AADSTS description).
            return observe(
              error instanceof GraphHttpError
                ? `Graph token request HTTP ${error.status}, retrying`
                : `Graph token request got no answer within ${formatBound(error.timeoutMs)}, retrying`,
            )
          }
          if (!isTransientRead(error)) throw error
          if (error instanceof GraphRequestTimeoutError) {
            // Count-only like the rest: the operation names a message id.
            return observe(
              `Graph request got no answer within ${formatBound(error.timeoutMs)}, retrying`,
            )
          }
          const wait = Math.min(
            error.retryAfterMs ?? 0,
            Math.max(0, deadline - this.now()),
          )
          if (wait > 0) await this.sleep(wait)
          return observe(`Graph HTTP ${error.status}, retrying`)
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
    deadline: number,
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
      const body = (await this.graph("GET", path, { deadline })) as {
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
      return this.listSince(since, subject, deadline)
    }
  }

  /**
   * createReply -> PATCH (recipient, empty Cc/Bcc, text body, From only for
   * an alias) -> send. Graph sets In-Reply-To/References from the original
   * on createReply. The recipient (Reply-To, else From) passes the guard
   * before the draft exists: an app mail without Reply-To would otherwise
   * be answered at its From, the real support address.
   *
   * Never retried. The send step is classified like send(): a failure
   * that leaves the outcome open has mayHaveSent true. A createReply or
   * PATCH failure, whatever it is, leaves at most an unsent draft in the
   * mailbox (mayHaveSent false).
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
      json: {
        toRecipients: [{ emailAddress: { address: to } }],
        ccRecipients: [],
        bccRecipients: [],
        ...this.fromField(mail.from),
        body: { contentType: "Text", content: mail.text },
      },
    })) as Partial<GraphMessage> | null
    await this.graph("POST", `${draftPath}/send`, { sends: true })
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

  /**
   * Client-credentials token, cached until 60 s before expiry. One token
   * request at a time, shared by every caller and always bounded by the
   * full requestTimeoutMs. A caller with a nearer `deadline` stops waiting
   * for it then (a GraphRequestTimeoutError) without cutting it short for
   * the others.
   */
  private async accessToken(deadline?: number): Promise<string> {
    if (this.token && this.now() < this.token.expiresAt - TOKEN_SKEW_MS) {
      return this.token.value
    }
    if (!this.pendingToken) {
      const pending = this.fetchToken().finally(() => {
        this.pendingToken = null
      })
      // A caller that stopped waiting leaves it unawaited: its failure must
      // not surface as an unhandled rejection.
      pending.catch(() => {})
      this.pendingToken = pending
    }
    const ms = this.boundMs(deadline)
    if (ms >= this.requestTimeoutMs) return this.pendingToken
    return this.within(this.pendingToken, TOKEN_OPERATION, ms)
  }

  private async fetchToken(): Promise<string> {
    const { tenantId, clientId, clientSecret } = this.options
    const url = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`
    const requestedAt = this.now()
    const reply = await this.call(
      TOKEN_OPERATION,
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          // Entra echoes the client-request-id only when asked.
          "return-client-request-id": "true",
        },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          scope: "https://graph.microsoft.com/.default",
          grant_type: "client_credentials",
        }).toString(),
      },
      this.requestTimeoutMs,
    )
    // A bad answer is a GraphRequestError too: it sent nothing.
    const bad = (message: string) =>
      new GraphRequestError(
        this.redact(message),
        TOKEN_OPERATION,
        false,
        reply.clientRequestId,
      )
    let body: { access_token?: string; expires_in?: number } | null
    try {
      body = JSON.parse(reply.text) as typeof body
    } catch {
      throw bad(
        `Graph token request returned a non-JSON ${reply.status} body (${reply.headers.get("content-type") ?? "unknown type"})`,
      )
    }
    if (!body?.access_token) {
      throw bad("Graph token request failed: no access_token returned")
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
    request: GraphRequest = {},
  ): Promise<unknown> {
    const token = await this.accessToken(request.deadline)
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      ...request.headers,
    }
    if (request.json !== undefined) headers["Content-Type"] = "application/json"
    const operation = `${method} ${path.split("?")[0]}`
    const reply = await this.call(
      operation,
      `${GRAPH_BASE}${path}`,
      {
        method,
        headers,
        body:
          request.json === undefined ? undefined : JSON.stringify(request.json),
      },
      this.boundMs(request.deadline),
      request.sends,
    )
    if (reply.text === "") return null
    try {
      return JSON.parse(reply.text) as unknown
    } catch {
      // A proxy/login interstitial or HTML error page: name the call, never
      // echo the body.
      const type = reply.headers.get("content-type") ?? "unknown type"
      throw new GraphRequestError(
        this.redact(
          `Graph ${operation} returned a non-JSON ${reply.status} body (${type})`,
        ),
        operation,
        false,
        reply.clientRequestId,
      )
    }
  }

  private async graphText(path: string): Promise<string> {
    const token = await this.accessToken()
    const reply = await this.call(
      `GET ${path}`,
      `${GRAPH_BASE}${path}`,
      { method: "GET", headers: { Authorization: `Bearer ${token}` } },
      this.requestTimeoutMs,
    )
    return reply.text
  }

  /** requestTimeoutMs, or less when a wait's deadline is nearer (at least 1 ms). */
  private boundMs(deadline: number | undefined): number {
    if (deadline === undefined) return this.requestTimeoutMs
    return Math.max(
      1,
      Math.min(this.requestTimeoutMs, Math.ceil(deadline - this.now())),
    )
  }

  /**
   * Arms a timer that never keeps the process alive on its own. A real
   * fetch holds a socket until the bound fires; a mocked or custom fetch
   * that holds no handle may let the process exit before it does.
   */
  private arm(fn: () => void, ms: number): TimerHandle {
    const timer = this.setTimer(fn, ms)
    timer.unref?.()
    return timer
  }

  /**
   * What a may-have-sent message adds: the hint, then the ids Microsoft
   * support can trace the request by (none of them a secret).
   */
  private sentHint(
    clientRequestId: string,
    requestId?: string,
    date?: string,
  ): string {
    const ids = [`client-request-id ${clientRequestId}`]
    if (requestId) ids.push(`request-id ${requestId}`)
    if (date) ids.push(`date ${date}`)
    return `${SEND_HINT} For Microsoft support: ${ids.join(", ")}.`
  }

  private timeoutError(
    operation: string,
    ms: number,
    sends: boolean,
    clientRequestId: string | undefined,
  ): GraphRequestTimeoutError {
    const hint = sends && clientRequestId ? this.sentHint(clientRequestId) : ""
    return new GraphRequestTimeoutError(
      this.redact(
        `Graph ${operation} got no answer within ${formatBound(ms)}${hint}`,
      ),
      operation,
      ms,
      sends,
      clientRequestId,
    )
  }

  /**
   * Waits at most `ms` for a shared request, never cancelling it. A
   * timeout here is the waiter's own: it names no client-request-id (the
   * request belongs to whoever started it).
   */
  private async within<T>(
    shared: Promise<T>,
    operation: string,
    ms: number,
  ): Promise<T> {
    const timeout = this.timeoutError(operation, ms, false, undefined)
    let timer: TimerHandle | undefined
    const expired = new Promise<never>((_, reject) => {
      timer = this.arm(() => reject(timeout), ms)
    })
    try {
      return await Promise.race([shared, expired])
    } finally {
      this.clearTimer(timer!)
    }
  }

  /**
   * One request, bounded as a whole (core/http.ts): the fetch, the headers
   * and the whole body end within `ms`, or the request is aborted and a
   * GraphRequestTimeoutError thrown. It carries a fresh client-request-id.
   * Non-2xx becomes a GraphHttpError, a transport failure a
   * GraphTransportError; for a request that `sends`, a 2xx is sent (its
   * body is not read) and the failure is classified (outcome.ts). Every
   * message passes through redact().
   */
  private async call(
    operation: string,
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
    ms: number,
    sends = false,
  ): Promise<{
    status: number
    headers: Headers
    text: string
    clientRequestId: string
  }> {
    const clientRequestId = randomUUID()
    const timeout = this.timeoutError(operation, ms, sends, clientRequestId)
    let reply: Awaited<ReturnType<typeof fetchWithin>>
    try {
      reply = await fetchWithin(
        this.fetchImpl,
        url,
        {
          ...init,
          headers: { ...init.headers, "client-request-id": clientRequestId },
          // Never follow (#22): a followed 307/308 re-sends the body, which
          // can send a mail twice or carry the client secret elsewhere. A
          // 3xx is the answer: a GraphHttpError that sent nothing.
          redirect: "manual",
        },
        ms,
        timeout,
        {
          setTimeout: this.setTimer,
          clearTimeout: this.clearTimer,
          // Once a send's 2xx status arrived, it was sent: its (empty) body
          // is not waited for, so a body failure cannot turn it into an error.
          readBody: sends ? (response) => !response.ok : undefined,
          onResponse: () => {
            this.answered.add(operation === TOKEN_OPERATION ? "token" : "graph")
          },
        },
      )
    } catch (error) {
      if (error === timeout) throw timeout
      const code = transportCode(error)
      const mayHaveSent = sends && transportMayHaveSent(error)
      // No `cause`: a transport error's message/stack may echo the request
      // (Authorization header); only the redacted text may leave this
      // method, plus the system error code.
      const transport = new GraphTransportError(
        this.redact(
          `Graph ${operation} failed: ${describeTransportError(error, code)}${mayHaveSent ? this.sentHint(clientRequestId) : ""}`,
        ),
        operation,
        { code, mayHaveSent, clientRequestId },
      )
      noteTransportCause(transport, error)
      if (!transportMayHaveSent(error)) NEVER_CONNECTED.add(transport)
      // eslint-disable-next-line preserve-caught-error
      throw transport
    }
    if (reply.ok) return { ...reply, clientRequestId }
    const body = parseErrorBody(reply.text)
    const requestId = guid(reply.headers.get("request-id")) ?? body.requestId
    const date = isoDate(reply.headers.get("date"))
    const mayHaveSent = sends && statusMayHaveSent(reply.status)
    throw new GraphHttpError(
      this.redact(
        `Graph ${operation} failed: HTTP ${reply.status}${body.detail ? ` ${body.detail}` : ""}${mayHaveSent ? this.sentHint(clientRequestId, requestId, date) : ""}`,
      ),
      operation,
      reply.status,
      parseRetryAfter(reply.headers.get("retry-after"), this.now()),
      {
        mayHaveSent,
        clientRequestId,
        requestId,
        date,
        traceId: body.traceId,
        correlationId: body.correlationId,
        code: body.code,
      },
    )
  }

  /**
   * Removes the access token and the client secret from `message`, as typed
   * and in both encoded forms an echoed request can carry: URI-encoded and
   * form-encoded (the token request's body, where a space is "+" and "~" is
   * "%7E").
   */
  private redact(message: string): string {
    // One line first: the error's constructor joins lines, so a secret
    // split across a line break must be matched joined, before that.
    let out = oneLine(message).replace(
      /Bearer\s+[A-Za-z0-9._~+/=-]+/g,
      "Bearer [redacted]",
    )
    for (const secret of [this.token?.value, this.options.clientSecret]) {
      if (!secret) continue
      for (const form of [
        secret,
        encodeURIComponent(secret),
        new URLSearchParams({ s: secret }).toString().slice(2),
      ]) {
        out = out.split(form).join("[redacted]")
      }
    }
    return out
  }
}

/** What an error body says, reduced to what may be shown. */
interface ErrorBody {
  /** "Code: first line of the message", or "" when the body says nothing usable. */
  detail: string
  /** Graph's error code or Entra's `error`, when code-shaped. */
  code?: string
  /** Graph's innerError request-id, GUID-shaped only. */
  requestId?: string
  /** Entra's trace_id and correlation_id, GUID-shaped only. */
  traceId?: string
  correlationId?: string
}

/** The first line of `text`, at most 200 characters. */
function firstLine(text: string): string {
  return (text.split(/\r?\n/)[0] ?? "").slice(0, 200)
}

function codeOf(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.]{1,64}$/.test(value)
    ? value
    : undefined
}

/**
 * Graph `{error:{code,message,innerError}}` or Entra `{error,
 * error_description, trace_id, correlation_id}`. Only the code, the first
 * line of the message and GUID-shaped ids are kept; a body that is not
 * JSON says nothing (it is never echoed).
 */
function parseErrorBody(text: string): ErrorBody {
  let body: {
    error?:
      | string
      | {
          code?: string
          message?: string
          innerError?: Record<string, unknown>
          innererror?: Record<string, unknown>
        }
    error_description?: string
    trace_id?: unknown
    correlation_id?: unknown
  }
  try {
    body = JSON.parse(text) as typeof body
  } catch {
    // Not JSON: no detail rather than echoing a body.
    return { detail: "" }
  }
  if (typeof body?.error === "object" && body.error !== null) {
    const inner = body.error.innerError ?? body.error.innererror
    const message = body.error.message
      ? `: ${firstLine(body.error.message)}`
      : ""
    const code = codeOf(body.error.code)
    return {
      detail: `${code ?? "UnknownError"}${message}`,
      code,
      requestId: guid(inner?.["request-id"]),
    }
  }
  if (typeof body?.error === "string") {
    // Entra descriptions start with the AADSTS code; keep the first line.
    const description = body.error_description
      ? firstLine(body.error_description)
      : ""
    const traceId = guid(body.trace_id)
    const correlationId = guid(body.correlation_id)
    const ids = [
      traceId && `trace_id ${traceId}`,
      correlationId && `correlation_id ${correlationId}`,
    ].filter(Boolean)
    const code = codeOf(body.error)
    return {
      detail: `${code ?? "UnknownError"}${description ? `: ${description}` : ""}${ids.length > 0 ? ` (${ids.join(", ")})` : ""}`,
      code,
      traceId,
      correlationId,
    }
  }
  return { detail: "" }
}
