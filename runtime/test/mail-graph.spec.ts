// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "@playwright/test"

import { SendRefusedError, TimeoutError } from "../src/core/index.js"
import { matchesQuery } from "../src/mail/index.js"
import type { MailMessage, OutgoingMail } from "../src/mail/index.js"
import {
  DEFAULT_GRAPH_DRIVER_COPY,
  GraphMailDriver,
  headerAddresses,
  toMailMessage,
} from "../src/mail-graph/index.js"

const TOKEN = "eyJ.fake-access-token.sig"
// A client secret with the characters that encoding changes (~ + / = and a
// space), so a check for it also covers its encoded forms.
const SECRET = "Abc8Q~x+y/z= END"
const MAILBOX = "qa@example.com"
const BASE = "https://graph.microsoft.com/v1.0/users/qa%40example.com"
const TOKEN_URL = "https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token"
const REPLY_DOMAIN = "reply.example.com"

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: string | undefined
}

type Responder = (call: Call) => Response | undefined

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

/** Fake fetch: answers the token endpoint itself unless `respond` does. */
function fakeFetch(respond: Responder = () => undefined, expiresIn = 3600) {
  const calls: Call[] = []
  const fetch = (input: string, init?: RequestInit): Promise<Response> => {
    const call: Call = {
      url: input,
      method: init?.method ?? "GET",
      headers: { ...(init?.headers as Record<string, string>) },
      body: init?.body as string | undefined,
    }
    calls.push(call)
    const answer = respond(call)
    if (answer) return Promise.resolve(answer)
    if (input === TOKEN_URL) {
      return Promise.resolve(
        json(200, { access_token: TOKEN, expires_in: expiresIn }),
      )
    }
    return Promise.resolve(new Response(null, { status: 202 }))
  }
  return { fetch, calls }
}

interface Bound {
  ms: number
  unrefd: boolean
  unref(): Bound
}

// The request bounds (requestTimeoutMs) the driver arms through its timer
// seam. These fakes always answer, so a bound never fires here; afterEach
// checks that every one was unref'd and cleared once its call settled.
const armed = new Set<Bound>()
const bounds: Bound[] = []

test.afterEach(() => {
  expect([...armed].map((b) => b.ms)).toEqual([])
  expect(bounds.filter((b) => !b.unrefd).map((b) => b.ms)).toEqual([])
  armed.clear()
  bounds.length = 0
})

function clock(start = Date.parse("2026-10-13T10:00:00.000Z")) {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
    sleep: (ms: number) => {
      t += ms
      return Promise.resolve()
    },
    setTimeout: (_fn: () => void, ms: number): Bound => {
      const bound: Bound = {
        ms,
        unrefd: false,
        unref() {
          this.unrefd = true
          return this
        },
      }
      armed.add(bound)
      bounds.push(bound)
      return bound
    },
    clearTimeout: (bound: unknown) => {
      armed.delete(bound as Bound)
    },
  }
}

function driver(
  fetch: ReturnType<typeof fakeFetch>["fetch"],
  c = clock(),
  timeoutMs = 10_000,
) {
  return new GraphMailDriver({
    tenantId: "tenant-1",
    clientId: "client-1",
    clientSecret: SECRET,
    mailbox: MAILBOX,
    replyDomain: REPLY_DOMAIN,
    defaultTimeoutMs: timeoutMs,
    fetch,
    now: c.now,
    sleep: c.sleep,
    setTimeout: c.setTimeout,
    clearTimeout: c.clearTimeout,
  })
}

const graphMessage = {
  id: "AAMk-1=",
  internetMessageId: "<out-1@example.test>",
  subject: "[RQ-4] [QA stg-run] Quote request",
  from: {
    emailAddress: { name: "Agent via Example", address: "qa@example.com" },
  },
  toRecipients: [{ emailAddress: { address: "qa-customer-1@qa.example.com" } }],
  ccRecipients: [],
  replyTo: [{ emailAddress: { address: "reply+tok@reply.example.com" } }],
  receivedDateTime: "2026-10-13T10:00:03Z",
  body: { contentType: "text", content: "Reference stg-run." },
  internetMessageHeaders: [
    { name: "In-Reply-To", value: "<in-1@qa.example.com>" },
    { name: "References", value: "<a@x> <in-1@qa.example.com>" },
  ],
}

/** An unrelated mail in the sandbox sink (the QA mailbox receives every redirect). */
const strangerMessage = {
  ...graphMessage,
  id: "AAMk-stranger=",
  subject: "Your quote Q-7781 for Jane Stranger",
  toRecipients: [{ emailAddress: { address: "jane@stranger.example" } }],
  receivedDateTime: "2026-10-13T10:00:05Z",
  body: { contentType: "text", content: "Private customer text" },
}

const LIST_PREFIX = `${BASE}/messages?`
const MESSAGE_FIELDS =
  "id,internetMessageId,subject,from,toRecipients,ccRecipients,replyTo,receivedDateTime,body,internetMessageHeaders"

/**
 * A mailbox for waitFor: the list answers `list()` with id, subject and
 * receivedDateTime only (what the driver selects), and a per-message GET
 * answers the full message from `store`.
 */
function mailbox(
  list: () => (typeof graphMessage)[],
  store: (typeof graphMessage)[] = [graphMessage, strangerMessage],
): Responder {
  return ({ url, method }) => {
    if (method !== "GET") return undefined
    if (url.startsWith(LIST_PREFIX)) {
      return json(200, {
        value: list().map(({ id, subject, receivedDateTime }) => ({
          id,
          subject,
          receivedDateTime,
        })),
      })
    }
    const single = /\/messages\/([^/?]+)\?\$select=/.exec(url)
    if (!single) return undefined
    const found = store.find((m) => encodeURIComponent(m.id) === single[1])
    return found ? json(200, found) : json(404, { error: { code: "NotFound" } })
  }
}

test.describe("token", () => {
  test("client-credentials request shape", async () => {
    const { fetch, calls } = fakeFetch()
    await driver(fetch).health()
    const tokenCall = calls[0]
    expect(tokenCall.url).toBe(TOKEN_URL)
    expect(tokenCall.method).toBe("POST")
    expect(tokenCall.headers["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    )
    expect(Object.fromEntries(new URLSearchParams(tokenCall.body))).toEqual({
      client_id: "client-1",
      client_secret: SECRET,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    })
    expect(calls[1].headers.Authorization).toBe(`Bearer ${TOKEN}`)
  })

  test("cached until 60 s before expiry, then refreshed", async () => {
    const c = clock()
    const { fetch, calls } = fakeFetch(undefined, 3600)
    const d = driver(fetch, c)
    const tokenCalls = () => calls.filter((x) => x.url === TOKEN_URL).length

    await d.health()
    await d.health()
    expect(tokenCalls()).toBe(1)

    c.advance(3600_000 - 60_000 - 1)
    await d.health()
    expect(tokenCalls()).toBe(1)

    c.advance(1)
    await d.health()
    expect(tokenCalls()).toBe(2)
  })

  test("concurrent callers share one token request", async () => {
    const { fetch, calls } = fakeFetch()
    const d = driver(fetch)
    await Promise.all([d.health(), d.health(), d.health()])
    expect(calls.filter((x) => x.url === TOKEN_URL)).toHaveLength(1)
  })
})

test.describe("requests", () => {
  test("health reads one message id, nothing else, from the QA mailbox", async () => {
    const { fetch, calls } = fakeFetch()
    await driver(fetch).health()
    expect(calls[1].method).toBe("GET")
    expect(calls[1].url).toBe(`${BASE}/messages?$top=1&$select=id`)
  })

  test("send: sendMail from the mailbox itself (no from, no send-as), not saved to Sent Items", async () => {
    const { fetch, calls } = fakeFetch()
    const result = await driver(fetch).send({
      from: "QA@Example.com",
      to: "support@reply.example.com",
      subject: "[QA stg-run] Quote request",
      text: "Hello stg-run",
    })
    expect(result).toEqual({ messageId: "" })
    const send = calls[1]
    expect(send.method).toBe("POST")
    expect(send.url).toBe(`${BASE}/sendMail`)
    expect(send.headers["Content-Type"]).toBe("application/json")
    expect(JSON.parse(send.body!)).toEqual({
      message: {
        subject: "[QA stg-run] Quote request",
        body: { contentType: "Text", content: "Hello stg-run" },
        toRecipients: [
          { emailAddress: { address: "support@reply.example.com" } },
        ],
      },
      saveToSentItems: false,
    })
  })

  test("send: an alias other than the mailbox is set as from (send-as)", async () => {
    const { fetch, calls } = fakeFetch()
    await driver(fetch).send({
      from: "qa-customer-1@qa.example.com",
      to: "support@reply.example.com",
      subject: "s",
      text: "t",
    })
    const body = JSON.parse(calls[1].body!) as { message: { from?: unknown } }
    expect(body.message.from).toEqual({
      emailAddress: { address: "qa-customer-1@qa.example.com" },
    })
  })

  test("send: the reply-domain guard refuses before any request", async () => {
    for (const to of [
      "support@example.com",
      " SUPPORT@EXAMPLE.COM ",
      "support@reply.example.com.evil.example",
      "support@x.reply.example.com",
      "Support <support@reply.example.com>",
    ]) {
      const { fetch, calls } = fakeFetch()
      await expect(
        driver(fetch).send({ from: MAILBOX, to, subject: "s", text: "t" }),
        to,
      ).rejects.toBeInstanceOf(SendRefusedError)
      expect(calls, to).toHaveLength(0)
    }
  })

  test("send: extra headers or attachments are refused before any request", async () => {
    const base: OutgoingMail = {
      from: MAILBOX,
      to: "support@reply.example.com",
      subject: "s",
      text: "t",
    }
    const variants: [string, OutgoingMail][] = [
      ["headers", { ...base, headers: { "Auto-Submitted": "auto-generated" } }],
      [
        "attachments",
        { ...base, attachments: [{ filename: "note.txt", base64: "aGk=" }] },
      ],
    ]
    for (const [what, mail] of variants) {
      const { fetch, calls } = fakeFetch()
      await expect(driver(fetch).send(mail), what).rejects.toBeInstanceOf(
        SendRefusedError,
      )
      expect(calls, what).toHaveLength(0)
    }
  })

  test("waitFor: the list is narrowed to the subject and selects no content", async () => {
    const { fetch, calls } = fakeFetch(mailbox(() => [graphMessage]))
    const message = await driver(fetch).waitFor({
      to: "QA-Customer-1@qa.example.com",
      subjectIncludes: "RQ-4",
      since: new Date("2026-10-13T10:00:00.750Z"),
    })
    const list = calls[1]
    expect(list.url).toBe(
      `${BASE}/messages` +
        "?$filter=receivedDateTime%20ge%202026-10-13T10%3A00%3A00Z%20and%20contains(subject%2C'RQ-4')" +
        "&$orderby=receivedDateTime%20desc&$top=50" +
        "&$select=id,subject,receivedDateTime",
    )
    // The full message is read on its own, only after its subject matched.
    expect(calls[2].url).toBe(
      `${BASE}/messages/AAMk-1%3D?$select=${MESSAGE_FIELDS}`,
    )
    expect(calls[2].headers.Prefer).toBe('outlook.body-content-type="text"')
    expect(calls).toHaveLength(3)
    expect(message.id).toBe("AAMk-1=")
    expect(message.from).toBe("Agent via Example <qa@example.com>")
    expect(message.text).toBe("Reference stg-run.")
  })

  test("waitFor quotes a subject with an apostrophe as an OData literal", async () => {
    const { fetch, calls } = fakeFetch(mailbox(() => []))
    await driver(fetch, clock(), 0)
      .waitFor({ subjectIncludes: "O'Brien", since: new Date() })
      .catch(() => undefined)
    expect(decodeURIComponent(calls[1].url)).toContain(
      "contains(subject,'O''Brien')",
    )
  })

  test("waitFor refuses a query without a subject before any request", async () => {
    const { fetch, calls } = fakeFetch()
    await expect(
      driver(fetch).waitFor({ to: "test@example.com", since: new Date() }),
    ).rejects.toThrow(/needs subjectIncludes/)
    expect(calls).toHaveLength(0)
  })

  test("waitFor never reads, nor reports, mail whose subject is not the run's", async () => {
    // As if Graph ignored the server-side subject filter: the stranger's
    // mail is in the list and is the newest message.
    const { fetch, calls } = fakeFetch(
      mailbox(() => [strangerMessage, graphMessage]),
    )
    const error = await driver(fetch, clock(), 3000)
      .waitFor({
        to: "nobody@example.com",
        subjectIncludes: "RQ-4",
        since: new Date("2026-10-13T10:00:00Z"),
      })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TimeoutError)
    const message = (error as Error).message
    for (const leaked of ["Q-7781", "Jane", "stranger", "Private"]) {
      expect(message).not.toContain(leaked)
    }
    expect(message).toContain(
      '1 message(s) with "RQ-4" in the subject since the query start, none matching',
    )
    // Its body, recipients and headers were never requested; the run's own
    // candidate was fetched once, however many polls there were.
    expect(calls.some((c) => c.url.includes("AAMk-stranger"))).toBe(false)
    expect(
      calls.filter((c) => c.url.includes("/messages/AAMk-1")),
    ).toHaveLength(1)
  })

  test("waitFor skips excluded ids without fetching them", async () => {
    const second = {
      ...graphMessage,
      id: "AAMk-2=",
      receivedDateTime: "2026-10-13T10:00:04Z",
    }
    const { fetch, calls } = fakeFetch(
      mailbox(() => [second, graphMessage], [graphMessage, second]),
    )
    const found = await driver(fetch).waitFor({
      subjectIncludes: "RQ-4",
      since: new Date("2026-10-13T10:00:00Z"),
      excludeIds: ["AAMk-2="],
    })
    expect(found.id).toBe("AAMk-1=")
    expect(calls.some((c) => c.url.includes("/messages/AAMk-2"))).toBe(false)
  })

  test("waitFor falls back to a client-side subject filter when Graph refuses contains()", async () => {
    const { fetch, calls } = fakeFetch((call) => {
      if (call.url.startsWith(LIST_PREFIX) && call.url.includes("contains")) {
        return json(400, { error: { code: "ErrorInvalidUrlQueryFilter" } })
      }
      return mailbox(() => [strangerMessage, graphMessage])(call)
    })
    const d = driver(fetch)
    const found = await d.waitFor({
      subjectIncludes: "RQ-4",
      since: new Date("2026-10-13T10:00:00Z"),
    })
    expect(found.id).toBe("AAMk-1=")
    const lists = calls.filter((c) => c.url.startsWith(LIST_PREFIX))
    expect(lists).toHaveLength(2)
    expect(lists[1].url).not.toContain("contains")
    expect(lists[1].url).toContain("$select=id,subject,receivedDateTime")
    expect(calls.some((c) => c.url.includes("AAMk-stranger"))).toBe(false)

    // The refusal is remembered: the next wait asks without contains().
    await d.waitFor({
      subjectIncludes: "RQ-4",
      since: new Date("2026-10-13T10:00:00Z"),
    })
    expect(
      calls.filter((c) => c.url.startsWith(LIST_PREFIX)).slice(2),
    ).toHaveLength(1)
    expect(calls.at(-1)!.url).not.toContain("contains")
  })

  test("a second 400 without contains() is a real failure", async () => {
    const { fetch } = fakeFetch(({ url }) =>
      url.startsWith(LIST_PREFIX)
        ? json(400, { error: { code: "BadRequest" } })
        : undefined,
    )
    await expect(
      driver(fetch).waitFor({ subjectIncludes: "RQ-4", since: new Date() }),
    ).rejects.toThrow(/HTTP 400 BadRequest/)
  })

  test("waitFor polls until a match and times out naming the query", async () => {
    let lists = 0
    const { fetch } = fakeFetch(
      mailbox(() => {
        lists += 1
        return lists < 3 ? [] : [graphMessage]
      }),
    )
    const found = await driver(fetch).waitFor({
      subjectIncludes: "RQ-4",
      since: new Date("2026-10-13T10:00:00Z"),
    })
    expect(found.subject).toContain("RQ-4")
    expect(lists).toBe(3)

    const { fetch: emptyFetch } = fakeFetch(mailbox(() => []))
    const error = await driver(emptyFetch, clock(), 3000)
      .waitFor({ subjectIncludes: "RQ-404", since: new Date() })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TimeoutError)
    expect((error as Error).message).toContain('subject~"RQ-404"')
    expect((error as Error).message).toContain(
      'no message with "RQ-404" in the subject since the query start',
    )
  })

  test("waitFor keeps a same-second message when since has milliseconds", async () => {
    const { fetch, calls } = fakeFetch(mailbox(() => [graphMessage]))
    // Graph reports 10:00:03Z for a message received at 10:00:03.7.
    const message = await driver(fetch).waitFor({
      subjectIncludes: "RQ-4",
      since: new Date("2026-10-13T10:00:03.500Z"),
    })
    expect(message.receivedAt).toBe("2026-10-13T10:00:03Z")
    expect(calls[1].url).toContain(
      "receivedDateTime%20ge%202026-10-13T10%3A00%3A03Z",
    )
  })

  test("waitFor re-polls a throttled list, honouring Retry-After", async () => {
    const c = clock()
    const sleeps: number[] = []
    const sleep = (ms: number) => {
      sleeps.push(ms)
      return c.sleep(ms)
    }
    let lists = 0
    const { fetch } = fakeFetch((call) => {
      if (!call.url.startsWith(LIST_PREFIX)) {
        return mailbox(() => [graphMessage])(call)
      }
      lists += 1
      if (lists === 1) {
        return new Response(
          JSON.stringify({ error: { code: "TooManyRequests" } }),
          { status: 429, headers: { "Retry-After": "7" } },
        )
      }
      if (lists === 2) return new Response(null, { status: 503 })
      return json(200, { value: [graphMessage] })
    })
    const d = new GraphMailDriver({
      tenantId: "tenant-1",
      clientId: "client-1",
      clientSecret: SECRET,
      mailbox: MAILBOX,
      replyDomain: REPLY_DOMAIN,
      defaultTimeoutMs: 60_000,
      fetch,
      now: c.now,
      sleep,
    })
    const found = await d.waitFor({
      subjectIncludes: "RQ-4",
      since: new Date("2026-10-13T10:00:00Z"),
    })
    expect(found.id).toBe("AAMk-1=")
    expect(lists).toBe(3)
    // Retry-After (7 s), then poll's own back-off after each attempt.
    expect(sleeps).toEqual([7000, 1000, 2000])
  })

  test("waitFor names a persistent throttle when it times out", async () => {
    const { fetch } = fakeFetch(({ url }) =>
      url.startsWith(LIST_PREFIX)
        ? new Response(null, { status: 429 })
        : undefined,
    )
    const error = await driver(fetch, clock(), 3000)
      .waitFor({ subjectIncludes: "RQ-4", since: new Date() })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TimeoutError)
    expect((error as Error).message).toContain("Graph HTTP 429, retrying")
  })

  test("waitFor fails fast on a non-transient list error", async () => {
    let lists = 0
    const { fetch } = fakeFetch(({ url }) => {
      if (!url.startsWith(LIST_PREFIX)) return undefined
      lists += 1
      return json(403, { error: { code: "ErrorAccessDenied" } })
    })
    await expect(
      driver(fetch).waitFor({ subjectIncludes: "RQ-4", since: new Date() }),
    ).rejects.toThrow(/HTTP 403 ErrorAccessDenied/)
    expect(lists).toBe(1)
  })

  test("a throttled token request stays fatal inside waitFor", async () => {
    const { fetch, calls } = fakeFetch(({ url }) =>
      url === TOKEN_URL
        ? json(429, { error: "temporarily_unavailable" })
        : undefined,
    )
    await expect(
      driver(fetch).waitFor({ subjectIncludes: "RQ-4", since: new Date() }),
    ).rejects.toThrow(/Graph token request failed: HTTP 429/)
    expect(calls).toHaveLength(1)
  })

  test("saveEml writes the $value MIME under dir", async () => {
    const { fetch, calls } = fakeFetch(({ url }) =>
      url.endsWith("/$value")
        ? new Response("From: a\r\n\r\nbody", { status: 200 })
        : undefined,
    )
    const dir = await mkdtemp(join(tmpdir(), "graph-eml-"))
    const message = toMailMessage(graphMessage)
    const path = await driver(fetch).saveEml(message, join(dir, "nested"))
    expect(calls[1].url).toBe(`${BASE}/messages/AAMk-1%3D/$value`)
    expect(path).toBe(
      join(dir, "nested", "01-rq-4-qa-stg-run-quote-request.eml"),
    )
    expect(await readFile(path!, "utf8")).toBe("From: a\r\n\r\nbody")
  })
})

test.describe("reply", () => {
  const original: MailMessage = toMailMessage(graphMessage)

  test("createReply -> PATCH -> send, in that order", async () => {
    const { fetch, calls } = fakeFetch(({ url, method }) => {
      if (url.endsWith("/createReply")) return json(201, { id: "draft/1" })
      if (method === "PATCH") {
        return json(200, { id: "draft/1", internetMessageId: "<d1@x>" })
      }
      return undefined
    })
    const result = await driver(fetch).reply(original, {
      from: MAILBOX,
      text: "Any update? stg-run",
    })
    expect(result).toEqual({ messageId: "<d1@x>" })
    const graphCalls = calls.slice(1)
    expect(graphCalls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${BASE}/messages/AAMk-1%3D/createReply`,
      `PATCH ${BASE}/messages/draft%2F1`,
      `POST ${BASE}/messages/draft%2F1/send`,
    ])
    // From the mailbox itself: no `from` on the draft. Cc/Bcc are cleared so
    // the guarded address is the only recipient whatever the draft held.
    expect(JSON.parse(graphCalls[1].body!)).toEqual({
      toRecipients: [
        { emailAddress: { address: "reply+tok@reply.example.com" } },
      ],
      ccRecipients: [],
      bccRecipients: [],
      body: { contentType: "Text", content: "Any update? stg-run" },
    })
  })

  test("an alias reply sets from on the draft", async () => {
    const { fetch, calls } = fakeFetch(({ url }) =>
      url.endsWith("/createReply") ? json(201, { id: "d3" }) : undefined,
    )
    await driver(fetch).reply(original, {
      from: "qa-customer-1@qa.example.com",
      text: "x",
    })
    const patch = calls.find((c) => c.method === "PATCH")!
    const body = JSON.parse(patch.body!) as { from?: unknown }
    expect(body.from).toEqual({
      emailAddress: { address: "qa-customer-1@qa.example.com" },
    })
  })

  test("without a Reply-To it answers the bare From address on the reply domain", async () => {
    const { fetch, calls } = fakeFetch(({ url }) =>
      url.endsWith("/createReply") ? json(201, { id: "d2" }) : undefined,
    )
    await driver(fetch).reply(
      {
        ...original,
        replyTo: [],
        from: "Agent via Example <support@reply.example.com>",
      },
      { from: MAILBOX, text: "x" },
    )
    const patch = calls.find((c) => c.method === "PATCH")!
    const body = JSON.parse(patch.body!) as { toRecipients: unknown }
    expect(body.toRecipients).toEqual([
      { emailAddress: { address: "support@reply.example.com" } },
    ])
  })

  test("the guard refuses a reply to a real mailbox before the draft exists", async () => {
    // An app mail without Reply-To would be answered at its From: the real
    // support address.
    const { fetch, calls } = fakeFetch()
    await expect(
      driver(fetch).reply(
        { ...original, replyTo: [] },
        { from: MAILBOX, text: "x" },
      ),
    ).rejects.toThrow(/Refusing to send to "qa@example.com"/)
    expect(calls).toHaveLength(0)
    const { fetch: fetch2, calls: calls2 } = fakeFetch()
    await expect(
      driver(fetch2).reply(
        { ...original, replyTo: ["reply+tok@reply.example.com.evil.example"] },
        { from: MAILBOX, text: "x" },
      ),
    ).rejects.toBeInstanceOf(SendRefusedError)
    expect(calls2).toHaveLength(0)
  })
})

test.describe("errors", () => {
  test("Graph errors carry status + code, never the token or secret", async () => {
    const { fetch } = fakeFetch(({ url }) =>
      url.endsWith("/sendMail")
        ? json(403, {
            error: {
              code: "ErrorAccessDenied",
              message: `Access is denied. Bearer ${TOKEN} ${SECRET}`,
            },
          })
        : undefined,
    )
    const error = (await driver(fetch)
      .send({
        from: "a@x",
        to: "b@reply.example.com",
        subject: "s",
        text: "t",
      })
      .catch((e: unknown) => e)) as Error
    expect(error.message).toContain("HTTP 403 ErrorAccessDenied")
    expect(error.message).not.toContain(TOKEN)
    expect(error.message).not.toContain(SECRET)
  })

  test("token errors carry the AAD code, never the secret", async () => {
    const { fetch } = fakeFetch(({ url }) =>
      url === TOKEN_URL
        ? json(401, {
            error: "invalid_client",
            error_description: `AADSTS7000215: Invalid client secret provided (${SECRET}).\r\nTrace ID: x`,
          })
        : undefined,
    )
    const error = (await driver(fetch)
      .send({
        from: "a@x",
        to: "b@reply.example.com",
        subject: "s",
        text: "t",
      })
      .catch((e: unknown) => e)) as Error
    expect(error.message).toContain(
      "Graph token request failed: HTTP 401 invalid_client: AADSTS7000215",
    )
    expect(error.message).not.toContain(SECRET)
    expect(error.message).not.toContain("Trace ID")
  })

  test("network errors are redacted too", async () => {
    let first = true
    const { fetch } = fakeFetch(({ url }) => {
      if (url === TOKEN_URL || !first) return undefined
      first = false
      throw new Error(`socket hang up (Authorization: Bearer ${TOKEN})`)
    })
    const error = (await driver(fetch)
      .send({
        from: "a@x",
        to: "b@reply.example.com",
        subject: "s",
        text: "t",
      })
      .catch((e: unknown) => e)) as Error
    expect(error.message).toMatch(/^Graph POST \/users\/.*\/sendMail failed/)
    expect(error.message).not.toContain(TOKEN)
  })

  test("a 2xx non-JSON body names the call, not a bare SyntaxError", async () => {
    const { fetch } = fakeFetch(({ url }) =>
      url.endsWith("/createReply")
        ? new Response("<html>Sign in</html>", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          })
        : undefined,
    )
    const error = (await driver(fetch)
      .reply(toMailMessage(graphMessage), { from: "a@x", text: "t" })
      .catch((e: unknown) => e)) as Error
    expect(error).not.toBeInstanceOf(SyntaxError)
    expect(error.message).toBe(
      "Graph POST /users/qa%40example.com/messages/AAMk-1%3D/createReply returned a non-JSON 200 body (text/html)",
    )
  })

  test("a non-JSON token response names the token request", async () => {
    const { fetch } = fakeFetch(({ url }) =>
      url === TOKEN_URL
        ? new Response("<html/>", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          })
        : undefined,
    )
    await expect(
      driver(fetch).send({
        from: "a@x",
        to: "b@reply.example.com",
        subject: "s",
        text: "t",
      }),
    ).rejects.toThrow(
      "Graph token request returned a non-JSON 200 body (text/html)",
    )
  })

  test("health wraps failures with setup guidance", async () => {
    const { fetch } = fakeFetch(({ url }) =>
      url.includes("$top=1")
        ? json(403, { error: { code: "ErrorAccessDenied" } })
        : undefined,
    )
    await expect(driver(fetch).health()).rejects.toThrow(
      /health check failed for qa@example.com: .*HTTP 403 ErrorAccessDenied.*RBAC for Applications, an Application Mail Full Access assignment scoped to the mailbox and no Entra Mail\.\* consent.*existing application access policy, the Entra consent and the policy group\./,
    )
  })
})

test("toMailMessage maps headers, threading and recipients", () => {
  const m = toMailMessage(graphMessage)
  expect(m).toMatchObject({
    messageId: "<out-1@example.test>",
    to: ["qa-customer-1@qa.example.com"],
    cc: [],
    replyTo: ["reply+tok@reply.example.com"],
    text: "Reference stg-run.",
    inReplyTo: "<in-1@qa.example.com>",
    references: ["<a@x>", "<in-1@qa.example.com>"],
    receivedAt: "2026-10-13T10:00:03Z",
  })
  expect(m.headers["in-reply-to"]).toBe("<in-1@qa.example.com>")
})

test("toMailMessage adds the raw To/Cc header form to the recipients", () => {
  // Exchange may resolve a plus-addressed delivery to the mailbox itself in
  // toRecipients; a flow waits on the plus form the app addressed.
  const m = toMailMessage({
    ...graphMessage,
    toRecipients: [{ emailAddress: { address: "test@example.com" } }],
    internetMessageHeaders: [
      { name: "To", value: '"Agent, QA" <test+agent@example.com>' },
      { name: "Cc", value: "TEST@example.com, Other <o@example.com>" },
    ],
  })
  expect(m.to).toEqual(["test@example.com", "test+agent@example.com"])
  expect(m.cc).toEqual(["TEST@example.com", "o@example.com"])
  expect(
    matchesQuery(m, {
      to: "test+agent@example.com",
      since: new Date("2026-10-13T10:00:00Z"),
    }),
  ).toBe(true)
})

test("headerAddresses splits only on top-level commas", () => {
  expect(headerAddresses(undefined)).toEqual([])
  expect(headerAddresses("undisclosed-recipients:;")).toEqual([])
  expect(
    headerAddresses('"Doe, Jane" <j@x.com>, k@x.com,<l@x.com> , "a,b"'),
  ).toEqual(["j@x.com", "k@x.com", "l@x.com"])
})

test.describe("copy", () => {
  test("defaults: the generic subject refusal and the guard's default wording", async () => {
    const { fetch } = fakeFetch()
    await expect(driver(fetch).waitFor({ since: new Date() })).rejects.toThrow(
      DEFAULT_GRAPH_DRIVER_COPY.subjectRequired,
    )
    await expect(
      driver(fetch).send({
        from: MAILBOX,
        to: "support@example.com",
        subject: "s",
        text: "t",
      }),
    ).rejects.toThrow(/FLOWREEL_REPLY_DOMAIN/)
  })

  test("a project's wording replaces each default it names", async () => {
    const { fetch, calls } = fakeFetch(({ url }) =>
      url === TOKEN_URL ? undefined : json(403, { error: { code: "Denied" } }),
    )
    const tailored = new GraphMailDriver({
      tenantId: "tenant-1",
      clientId: "client-1",
      clientSecret: SECRET,
      mailbox: MAILBOX,
      replyDomain: REPLY_DOMAIN,
      defaultTimeoutMs: 1000,
      fetch,
      copy: {
        guard: { domainSetting: "MY_REPLY_DOMAIN", realMailbox: "help@" },
        healthHint: "See MY_GRAPH_* settings.",
        subjectRequired: "Name the subject.",
      },
    })
    await expect(tailored.health()).rejects.toThrow(
      /HTTP 403 Denied\. See MY_GRAPH_\* settings\.$/,
    )
    await expect(tailored.waitFor({ since: new Date() })).rejects.toThrow(
      "Name the subject.",
    )
    const refused = (await tailored
      .send({ from: MAILBOX, to: "x@example.com", subject: "s", text: "t" })
      .catch((e: unknown) => e)) as Error
    expect(refused.message).toContain("(MY_REPLY_DOMAIN)")
    expect(refused.message).toContain("such as help@")
    expect(
      calls.map((c) => c.url).filter((u) => u.includes("sendMail")),
    ).toEqual([])
  })
})
