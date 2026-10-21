// SPDX-License-Identifier: Apache-2.0

// Shared fixtures for the Graph follow-up specs (issues #17, #18, #19): a
// fake fetch on the virtual clock that records every request (URL, method,
// headers, body, signal and the virtual time it was made at), the run's own
// mail, and a driver wired to the clock. mail-graph-timeout.spec.ts has the
// same shapes; this copy also records headers and times.

import { inspect } from "node:util"

import { expect } from "@playwright/test"

import type { MailMessage } from "../src/mail/index.js"
import {
  GraphMailDriver,
  type GraphMailDriverOptions,
  toMailMessage,
} from "../src/mail-graph/index.js"
import type { Outcome, VirtualClock } from "./virtual-clock.js"

// A client secret with the characters that encoding changes (~ + / = and a
// space), so a check for it also covers its encoded forms.
export const SECRET = "Abc8Q~x+y/z= END"
export const TOKEN = "eyJ.followup-access-token.sig"
/** The secret as text can carry it: raw, URI-encoded and form-encoded. */
export const SECRET_FORMS = [
  SECRET,
  encodeURIComponent(SECRET),
  new URLSearchParams({ s: SECRET }).toString().slice(2),
]
export const MAILBOX = "qa@example.com"
export const MAILBOX_PATH = "/users/qa%40example.com"
export const BASE = `https://graph.microsoft.com/v1.0${MAILBOX_PATH}`
export const TOKEN_URL =
  "https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token"
/** The hint of a send that may have gone out (#16's wording). */
export const MAY_HAVE_SENT = "may have been sent"
/** RFC 4122 version 4, variant 10xx. */
export const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
/** The header every Graph and token request carries (#19). */
export const CLIENT_REQUEST_ID = "client-request-id"
/** A server-side id as Graph and Entra send them (GUID-shaped). */
export const REQUEST_ID = "9f2c4e1a-3b5d-4c6e-8f7a-1b2c3d4e5f60"
export const TRACE_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
export const CORRELATION_ID = "5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9"

/** How a fake request ends. */
export type Answer =
  | Response
  /** Settles whenever the test says (ignores its signal). */
  | Promise<Response>
  | Error
  /** Never answers; rejects with an AbortError once its signal aborts. */
  | "hang"
  | undefined

export interface Call {
  url: string
  method: string
  body: string | undefined
  headers: Headers
  signal: AbortSignal | undefined
  /** The request's redirect mode (#22: always "manual"). */
  redirect: RequestInit["redirect"]
  /** The virtual time the request was made at. */
  at: number
}

export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  })
}

function hang(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_, reject) => {
    signal?.addEventListener(
      "abort",
      () => {
        const error = new Error("This operation was aborted")
        error.name = "AbortError"
        reject(error)
      },
      { once: true },
    )
  })
}

/**
 * A fake fetch: `respond` decides, and anything it leaves undefined gets a
 * token, an empty list, or a bare 202.
 */
export function fakeFetch(c: VirtualClock, respond: (call: Call) => Answer) {
  const calls: Call[] = []
  const fetch = (url: string, init: RequestInit = {}): Promise<Response> => {
    const call: Call = {
      url,
      method: init.method ?? "GET",
      body: init.body as string | undefined,
      headers: new Headers(init.headers),
      signal: init.signal ?? undefined,
      redirect: init.redirect,
      at: c.now(),
    }
    calls.push(call)
    const answer = respond(call)
    if (answer instanceof Response) return Promise.resolve(answer)
    if (answer instanceof Promise) return answer
    if (answer instanceof Error) return Promise.reject(answer)
    if (answer === "hang") return hang(init.signal)
    if (url === TOKEN_URL) {
      return Promise.resolve(
        json(200, { access_token: TOKEN, expires_in: 3600 }),
      )
    }
    if (url.includes("/messages?")) {
      return Promise.resolve(json(200, { value: [] }))
    }
    return Promise.resolve(new Response(null, { status: 202 }))
  }
  return { fetch, calls }
}

/** A 2xx or error reply whose body fails once read ("terminated"). */
export function brokenBody(status: number): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.error(
          new TypeError("terminated", {
            cause: Object.assign(new Error("other side closed"), {
              name: "SocketError",
              code: "UND_ERR_SOCKET",
            }),
          }),
        )
      },
    }),
    { status, headers: { "Content-Type": "application/json" } },
  )
}

/** A reply whose headers arrive and whose body never ends. */
export function stalledBody(status: number): Response {
  return new Response(new ReadableStream({ start() {} }), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

/** The client-request-id a request was sent with ("" when none). */
export const clientRequestIdOf = (call: Call) =>
  call.headers.get(CLIENT_REQUEST_ID) ?? ""

/** True when `text` is one line (no CR or LF anywhere). */
export const isOneLine = (text: string) => !/[\r\n]/.test(text)

export const isToken = (call: Call) => call.url === TOKEN_URL
export const isList = (call: Call) =>
  call.url.startsWith(`${BASE}/messages?$filter=`)
export const isHealth = (call: Call) =>
  call.url.startsWith(`${BASE}/messages?$top=1`)
export const isSaveEml = (call: Call) => call.url.endsWith("/$value")
export const isMessageGet = (call: Call) =>
  /\/messages\/[^/?]+\?\$select=/.test(call.url)
export const isSendMail = (call: Call) => call.url.endsWith("/sendMail")
export const isCreateReply = (call: Call) => call.url.endsWith("/createReply")
export const isPatch = (call: Call) => call.method === "PATCH"
export const isDraftSend = (call: Call) => call.url.endsWith("/send")

export const graphMessage = {
  id: "AAMk-1=",
  internetMessageId: "<out-1@example.test>",
  subject: "[RUN-123] Quote request for Jane Stranger",
  from: { emailAddress: { address: "app@example.test" } },
  toRecipients: [{ emailAddress: { address: "qa@example.com" } }],
  replyTo: [{ emailAddress: { address: "reply+tok@reply.example.com" } }],
  receivedDateTime: "2026-10-13T10:00:03Z",
  body: { contentType: "text", content: "Private body text" },
}

/** The run's own mail: the list names it, a message GET returns it. */
export function mailbox(call: Call): Answer {
  if (isList(call)) {
    const { id, subject, receivedDateTime } = graphMessage
    return json(200, { value: [{ id, subject, receivedDateTime }] })
  }
  if (isMessageGet(call)) return json(200, graphMessage)
  return undefined
}

/** The reply draft's createReply and PATCH answer; the send is left open. */
export function draftSteps(call: Call): Answer {
  if (isCreateReply(call)) return json(201, { id: "draft-1" })
  if (isPatch(call)) {
    return json(200, {
      id: "draft-1",
      internetMessageId: "<reply-1@example.test>",
    })
  }
  return undefined
}

export const original: MailMessage = toMailMessage(graphMessage)

export const mail = {
  from: MAILBOX,
  to: "support@reply.example.com",
  subject: "[RUN-123] s",
  text: "t",
}

export const replyMail = { from: MAILBOX, text: "t" }

export const query = (timeoutMs: number) => ({
  subjectIncludes: "RUN-123",
  since: new Date("2026-10-13T10:00:00Z"),
  timeoutMs,
})

/** Every clock a driver was built on, for the specs' timer hygiene check. */
export const clocks: VirtualClock[] = []

export function driver(
  c: VirtualClock,
  fetch: GraphMailDriverOptions["fetch"],
  extra: Partial<GraphMailDriverOptions> = {},
): GraphMailDriver {
  clocks.push(c)
  return new GraphMailDriver({
    tenantId: "tenant-1",
    clientId: "client-1",
    clientSecret: SECRET,
    mailbox: MAILBOX,
    replyDomain: "reply.example.com",
    defaultTimeoutMs: 10_000,
    fetch,
    now: c.now,
    sleep: c.sleep,
    setTimeout: c.setTimeout,
    clearTimeout: c.clearTimeout,
    ...extra,
  })
}

export function rejected<T>(outcome: Outcome<T>): Error {
  expect(outcome.state).toBe("rejected")
  return (outcome as { error: Error }).error
}

/** Read defensively: a SendRefusedError (no request) has no such field. */
export function mayHaveSentOf(error: unknown): unknown {
  return (error as { mayHaveSent?: unknown } | null)?.mayHaveSent
}

/** The secret and token forms an error shows anywhere (util.inspect, depth 5). */
export function leakedSecrets(error: unknown): string[] {
  const shown = inspect(error, { depth: 5 })
  return [...SECRET_FORMS, TOKEN].filter((form) => shown.includes(form))
}
