// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inspect } from "node:util"

import { expect, test } from "@playwright/test"

import { ConfigError, TimeoutError } from "../src/core/index.js"
import type { MailMessage } from "../src/mail/index.js"
import {
  DEFAULT_GRAPH_DRIVER_COPY,
  GraphHttpError,
  GraphMailDriver,
  type GraphMailDriverOptions,
  GraphRequestTimeoutError,
  toMailMessage,
} from "../src/mail-graph/index.js"
import {
  type Outcome,
  type VirtualClock,
  unhandledRejections,
  virtualClock,
} from "./virtual-clock.js"

// Issue #16: every Graph request is bounded by requestTimeoutMs, from the
// connection to the last byte of the body, and the bound is exact. All of
// it runs on a virtual clock: a 30-second bound fires in microseconds, and
// a request that nothing can ever end shows up as a "deadlock" outcome
// instead of a hung test. mail-graph-hang.spec.ts proves the same on real
// timers.

// A client secret with the characters that encoding changes (~ + / = and a
// space), so a check for it also covers its encoded forms.
const SECRET = "Abc8Q~x+y/z= END"
const TOKEN = "eyJ.timeout-access-token.sig"
/**
 * The secret as text can carry it: raw, URI-encoded, and form-encoded (the
 * token request's body). The last two differ for "~" and the space.
 */
const SECRET_FORMS = [
  SECRET,
  encodeURIComponent(SECRET),
  new URLSearchParams({ s: SECRET }).toString().slice(2),
]
const MAILBOX = "qa@example.com"
const MAILBOX_PATH = "/users/qa%40example.com"
const BASE = `https://graph.microsoft.com/v1.0${MAILBOX_PATH}`
const TOKEN_URL = "https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token"
const SEND_HINT =
  ". The mail may have been sent; it is not retried, because a second send could mail twice."
/** What a may-have-sent message names after the hint (#19). */
const supportIds = (clientRequestId: string) =>
  ` For Microsoft support: client-request-id ${clientRequestId}.`

/** How a fake request ends. */
type Answer =
  | Response
  /** Settles whenever the test says (ignores its signal). */
  | Promise<Response>
  | Error
  /** Never answers; rejects with a fresh AbortError once its signal aborts. */
  | "hang"
  /** Never answers and never looks at its signal. */
  | "deaf"
  /** Headers arrive (200), the body never ends. */
  | "stall"
  /** Headers arrive (503), the body never ends. */
  | "stall-503"
  | undefined

interface Call {
  url: string
  method: string
  body: string | undefined
  signal: AbortSignal | undefined
  /** The client-request-id it was sent with (#19). */
  id: string
  /**
   * The delay of the newest timer armed through the seam when fetch was
   * called: the bound the driver armed for this request.
   */
  timerMs: number | undefined
}

function json(status: number, body: unknown, headers = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  })
}

function stalled(status: number): Response {
  return new Response(new ReadableStream({ start() {} }), {
    status,
    headers: { "Content-Type": "application/json" },
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
function fakeFetch(c: VirtualClock, respond: (call: Call) => Answer) {
  const calls: Call[] = []
  const fetch = (url: string, init: RequestInit = {}): Promise<Response> => {
    const call: Call = {
      url,
      method: init.method ?? "GET",
      body: init.body as string | undefined,
      signal: init.signal ?? undefined,
      id: new Headers(init.headers).get("client-request-id") ?? "",
      timerMs: c.timers.at(-1)?.ms,
    }
    calls.push(call)
    const answer = respond(call)
    if (answer instanceof Response) return Promise.resolve(answer)
    if (answer instanceof Promise) return answer
    if (answer instanceof Error) return Promise.reject(answer)
    if (answer === "hang") return hang(init.signal)
    if (answer === "deaf") return new Promise(() => {})
    if (answer === "stall") return Promise.resolve(stalled(200))
    if (answer === "stall-503") return Promise.resolve(stalled(503))
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

const isToken = (call: Call) => call.url === TOKEN_URL
const isList = (call: Call) => call.url.startsWith(`${BASE}/messages?$filter=`)
const isHealth = (call: Call) => call.url.startsWith(`${BASE}/messages?$top=1`)
const isMessageGet = (call: Call) =>
  /\/messages\/[^/?]+\?\$select=/.test(call.url)
const isSendMail = (call: Call) => call.url.endsWith("/sendMail")
const isCreateReply = (call: Call) => call.url.endsWith("/createReply")
const isPatch = (call: Call) => call.method === "PATCH"
const isDraftSend = (call: Call) => call.url.endsWith("/send")

const graphMessage = {
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
function mailbox(call: Call): Answer {
  if (isList(call)) {
    const { id, subject, receivedDateTime } = graphMessage
    return json(200, { value: [{ id, subject, receivedDateTime }] })
  }
  if (isMessageGet(call)) return json(200, graphMessage)
  return undefined
}

const original: MailMessage = toMailMessage(graphMessage)

const mail = {
  from: MAILBOX,
  to: "support@reply.example.com",
  subject: "[RUN-123] s",
  text: "t",
}

const query = (timeoutMs: number) => ({
  subjectIncludes: "RUN-123",
  since: new Date("2026-10-13T10:00:00Z"),
  timeoutMs,
})

const clocks: VirtualClock[] = []

function base(fetch: GraphMailDriverOptions["fetch"]): GraphMailDriverOptions {
  return {
    tenantId: "tenant-1",
    clientId: "client-1",
    clientSecret: SECRET,
    mailbox: MAILBOX,
    replyDomain: "reply.example.com",
    defaultTimeoutMs: 10_000,
    fetch,
  }
}

function driver(
  c: VirtualClock,
  fetch: GraphMailDriverOptions["fetch"],
  extra: Partial<GraphMailDriverOptions> = {},
) {
  clocks.push(c)
  return new GraphMailDriver({
    ...base(fetch),
    now: c.now,
    sleep: c.sleep,
    setTimeout: c.setTimeout,
    clearTimeout: c.clearTimeout,
    ...extra,
  })
}

function rejected<T>(outcome: Outcome<T>): Error {
  expect(outcome.state).toBe("rejected")
  return (outcome as { error: Error }).error
}

let rejections: ReturnType<typeof unhandledRejections>
test.beforeEach(() => {
  rejections = unhandledRejections()
})
test.afterEach(async () => {
  // Timer hygiene: once a call settled, nothing it armed is still armed,
  // and every timer was unref'd (a bound never keeps a process alive).
  for (const c of clocks.splice(0)) {
    expect(c.armed().map((h) => h.ms)).toEqual([])
    expect(c.timers.filter((h) => !h.unrefd).map((h) => h.ms)).toEqual([])
  }
  expect(await rejections.stop()).toEqual([])
})

test.describe("requestTimeoutMs", () => {
  test("must be a whole number of milliseconds from 1 to 2147483647", () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity, 2 ** 31, "30000"]) {
      const build = () =>
        new GraphMailDriver({
          ...base(() => Promise.reject(new Error("unused"))),
          requestTimeoutMs: bad as number,
        })
      expect(build, String(bad)).toThrow(ConfigError)
      expect(build, String(bad)).toThrow(/requestTimeoutMs/)
    }
    for (const good of [1, 2_147_483_647]) {
      expect(
        () =>
          new GraphMailDriver({
            ...base(() => Promise.reject(new Error("unused"))),
            requestTimeoutMs: good,
          }),
      ).not.toThrow()
    }
  })

  test("defaults to 30 s per request, the token request included", async () => {
    const c = virtualClock()
    const { fetch, calls } = fakeFetch(c, () => undefined)
    const out = await c.run(driver(c, fetch).health())
    expect(out.state).toBe("resolved")
    expect(calls.map((call) => call.timerMs)).toEqual([30_000, 30_000])
    expect(c.timers.map((h) => h.ms)).toEqual([30_000, 30_000])
  })

  test("a project's value bounds every request", async () => {
    const c = virtualClock()
    const { fetch, calls } = fakeFetch(c, () => undefined)
    const d = driver(c, fetch, { requestTimeoutMs: 5_000 })
    expect((await c.run(d.health())).state).toBe("resolved")
    expect((await c.run(d.send(mail))).state).toBe("resolved")
    expect(calls.map((call) => call.timerMs)).toEqual([5_000, 5_000, 5_000])
  })
})

test.describe("every request is bounded, the body included", () => {
  const cases: [string, (call: Call) => Answer, string][] = [
    [
      "a token request whose body never ends",
      (c) => (isToken(c) ? "stall" : undefined),
      "token request",
    ],
    [
      "a token request that never answers",
      (c) => (isToken(c) ? "hang" : undefined),
      "token request",
    ],
    [
      "a read that never answers",
      (c) => (isHealth(c) ? "hang" : undefined),
      `GET ${MAILBOX_PATH}/messages`,
    ],
    [
      "a read whose fetch ignores the abort signal",
      (c) => (isHealth(c) ? "deaf" : undefined),
      `GET ${MAILBOX_PATH}/messages`,
    ],
    [
      "a read whose body never ends",
      (c) => (isHealth(c) ? "stall" : undefined),
      `GET ${MAILBOX_PATH}/messages`,
    ],
    [
      "an error reply whose body never ends",
      (c) => (isHealth(c) ? "stall-503" : undefined),
      `GET ${MAILBOX_PATH}/messages`,
    ],
  ]
  for (const [name, respond, operation] of cases) {
    test(`${name} ends at the bound`, async () => {
      const c = virtualClock()
      const { fetch } = fakeFetch(c, respond)
      const error = rejected(await c.run(driver(c, fetch).health()))
      expect(c.now() - c.start).toBe(30_000)
      const cause = error.cause as GraphRequestTimeoutError
      expect(cause).toBeInstanceOf(GraphRequestTimeoutError)
      expect(cause).not.toBeInstanceOf(GraphHttpError)
      expect(cause.operation).toBe(operation)
      expect(cause.timeoutMs).toBe(30_000)
      expect(cause.mayHaveSent).toBe(false)
      expect(cause.message).toBe(`Graph ${operation} got no answer within 30 s`)
    })
  }

  test("the driver aborts the request it gave up on", async () => {
    const c = virtualClock()
    const { fetch, calls } = fakeFetch(c, (call) =>
      isHealth(call) ? "hang" : undefined,
    )
    rejected(await c.run(driver(c, fetch).health()))
    expect(calls.map((call) => call.signal?.aborted)).toEqual([false, true])
  })

  test("a saved mail whose body never ends ends at the bound and writes nothing", async () => {
    const c = virtualClock()
    const { fetch } = fakeFetch(c, (call) =>
      call.url.endsWith("/$value") ? "stall" : undefined,
    )
    const dir = await mkdtemp(join(tmpdir(), "flowreel-timeout-"))
    try {
      const error = rejected(
        await c.run(driver(c, fetch).saveEml(original, join(dir, "eml"))),
      )
      expect(c.now() - c.start).toBe(30_000)
      expect(error).toBeInstanceOf(GraphRequestTimeoutError)
      expect((error as GraphRequestTimeoutError).operation).toBe(
        `GET ${MAILBOX_PATH}/messages/AAMk-1%3D/$value`,
      )
      expect(await readdir(dir)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a bound under a second is named in milliseconds", async () => {
    const c = virtualClock()
    const { fetch } = fakeFetch(c, (call) =>
      isHealth(call) ? "hang" : undefined,
    )
    const error = rejected(
      await c.run(driver(c, fetch, { requestTimeoutMs: 300 }).health()),
    )
    expect((error.cause as Error).message).toBe(
      `Graph GET ${MAILBOX_PATH}/messages got no answer within 300 ms`,
    )
  })

  test("the timeout error is the driver's own: no cause, never an HTTP or wait timeout", async () => {
    const c = virtualClock()
    const { fetch } = fakeFetch(c, (call) =>
      isSendMail(call) ? "hang" : undefined,
    )
    const error = rejected(await c.run(driver(c, fetch).send(mail)))
    expect(error).toBeInstanceOf(GraphRequestTimeoutError)
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe("GraphRequestTimeoutError")
    expect(error).not.toBeInstanceOf(GraphHttpError)
    expect(error).not.toBeInstanceOf(TimeoutError)
    expect("cause" in error).toBe(false)
  })
})

test.describe("what counts as a timeout", () => {
  test("an AbortError the driver did not cause stays a transport error", async () => {
    const c = virtualClock()
    const foreign = new Error("This operation was aborted")
    foreign.name = "AbortError"
    const { fetch, calls } = fakeFetch(c, (call) =>
      isHealth(call) ? foreign : undefined,
    )
    const out = await c.run(driver(c, fetch).health())
    const error = rejected(out)
    expect(out.at).toBe(c.start)
    expect(calls[1].signal?.aborted).toBe(false)
    expect(error.cause).not.toBeInstanceOf(GraphRequestTimeoutError)
    expect((error.cause as Error).message).toBe(
      `Graph GET ${MAILBOX_PATH}/messages failed: This operation was aborted`,
    )
    // Not a timeout: the credentials hint stays.
    expect(error.message).toContain(DEFAULT_GRAPH_DRIVER_COPY.healthHint)
  })

  test("a transport error keeps only its cause's code", async () => {
    const c = virtualClock()
    const refused = new TypeError("fetch failed", {
      cause: Object.assign(
        new Error(`connect ECONNREFUSED 10.0.0.1:443 ${SECRET} ${TOKEN}`),
        { code: "ECONNREFUSED", syscall: "connect", address: "10.0.0.1" },
      ),
    })
    const { fetch } = fakeFetch(c, (call) =>
      isSendMail(call) ? refused : undefined,
    )
    const error = rejected(await c.run(driver(c, fetch).send(mail)))
    expect(error.message).toBe(
      `Graph POST ${MAILBOX_PATH}/sendMail failed: fetch failed (ECONNREFUSED)`,
    )
    expect("cause" in error).toBe(false)
    expect(error).not.toBeInstanceOf(GraphRequestTimeoutError)

    const c2 = virtualClock()
    const codeless = new TypeError("fetch failed", {
      cause: new Error(`other ${SECRET}`),
    })
    const { fetch: fetch2, calls: calls2 } = fakeFetch(c2, (call) =>
      isSendMail(call) ? codeless : undefined,
    )
    const error2 = rejected(await c2.run(driver(c2, fetch2).send(mail)))
    // #17: a codeless transport error on a send may have been sent (hint + id).
    expect(error2.message).toBe(
      `Graph POST ${MAILBOX_PATH}/sendMail failed: fetch failed${SEND_HINT}${supportIds(calls2[1].id)}`,
    )
  })

  test("a transport failure with no error object still names the call", async () => {
    const c = virtualClock()
    const { fetch, calls } = fakeFetch(c, (call) =>
      isSendMail(call)
        ? (Promise.reject(null) as Promise<Response>)
        : undefined,
    )
    const error = rejected(await c.run(driver(c, fetch).send(mail)))
    // #17: a null rejection on a send may have been sent (hint + id).
    expect(error.message).toBe(
      `Graph POST ${MAILBOX_PATH}/sendMail failed: null${SEND_HINT}${supportIds(calls[1].id)}`,
    )
  })

  test("a 2xx whose body cannot be read names the call, not the stream's error", async () => {
    const c = virtualClock()
    const broken = {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: () =>
        Promise.reject(new Error(`stream reset Bearer ${TOKEN} ${SECRET}`)),
    } as unknown as Response
    const { fetch } = fakeFetch(c, (call) =>
      isHealth(call) ? Promise.resolve(broken) : undefined,
    )
    const error = rejected(await c.run(driver(c, fetch).health()))
    const cause = error.cause as Error
    expect(cause.message).toBe(
      `Graph GET ${MAILBOX_PATH}/messages failed: stream reset Bearer [redacted] [redacted]`,
    )
    expect(cause).not.toBeInstanceOf(GraphRequestTimeoutError)
  })
})

test.describe("redaction", () => {
  test("a transport error that echoes the token request's form body never carries the secret", async () => {
    const c = virtualClock()
    const { fetch, calls } = fakeFetch(c, (call) =>
      isToken(call) ? new TypeError(`fetch failed: ${call.body}`) : undefined,
    )
    const error = rejected(await c.run(driver(c, fetch).health()))
    // The body as sent carries the secret form-encoded, not as typed.
    expect(calls[0].body).toContain(`client_secret=${SECRET_FORMS[2]}`)
    const shown = inspect(error, { depth: 5 })
    for (const form of SECRET_FORMS) expect(shown).not.toContain(form)
    expect(shown).toContain("client_secret=[redacted]")
  })

  test("an access token echoed URI-encoded is redacted too", async () => {
    const c = virtualClock()
    const opaque = "tok+en/with=chars ~x"
    const { fetch } = fakeFetch(c, (call) => {
      if (isToken(call)) {
        return json(200, { access_token: opaque, expires_in: 3600 })
      }
      return isHealth(call)
        ? new TypeError(
            `fetch failed near ${encodeURIComponent(opaque)} and ${new URLSearchParams({ t: opaque }).toString().slice(2)}`,
          )
        : undefined
    })
    const error = rejected(await c.run(driver(c, fetch).health()))
    const shown = inspect(error, { depth: 5 })
    expect(shown).not.toContain(encodeURIComponent(opaque))
    expect(shown).not.toContain(
      new URLSearchParams({ t: opaque }).toString().slice(2),
    )
    expect((error.cause as Error).message).toBe(
      `Graph GET /users/qa%40example.com/messages failed: fetch failed near [redacted] and [redacted]`,
    )
  })
})

test.describe("health", () => {
  test("a timeout is not blamed on the credentials", async () => {
    const c = virtualClock()
    const { fetch } = fakeFetch(c, (call) =>
      isToken(call) ? "hang" : undefined,
    )
    const error = rejected(await c.run(driver(c, fetch).health()))
    expect(error.message).toContain(
      "Graph mailbox health check failed for qa@example.com: Graph token request got no answer within 30 s",
    )
    expect(error.message).toContain("no answer")
    expect(error.message).not.toContain(DEFAULT_GRAPH_DRIVER_COPY.healthHint)
    expect(error.message).not.toContain("client secret")
  })

  test("other failures keep the credentials hint", async () => {
    const c = virtualClock()
    const { fetch } = fakeFetch(c, (call) =>
      isHealth(call) ? new TypeError("fetch failed") : undefined,
    )
    const error = rejected(await c.run(driver(c, fetch).health()))
    expect(error.message).toContain(DEFAULT_GRAPH_DRIVER_COPY.healthHint)
  })
})

test.describe("waitFor", () => {
  test("a timed-out list read with time left is re-polled, and the next answer ends the wait", async () => {
    const c = virtualClock()
    let lists = 0
    const { fetch, calls } = fakeFetch(c, (call) => {
      if (isList(call) && ++lists === 1) return "hang"
      return mailbox(call)
    })
    const out = await c.run(driver(c, fetch).waitFor(query(120_000)))
    expect(out.state).toBe("resolved")
    expect((out as { value: MailMessage }).value.id).toBe("AAMk-1=")
    // The 30 s bound, then poll's own 1 s back-off.
    expect(out.at - c.start).toBe(31_000)
    expect(c.sleeps).toEqual([1_000])
    expect(lists).toBe(2)
    expect(calls.filter(isList)[0].signal?.aborted).toBe(true)
  })

  for (const [name, stall] of [
    ["list", isList],
    ["message read", isMessageGet],
  ] as const) {
    test(`a ${name} whose body never ends is bounded and re-polled`, async () => {
      const c = virtualClock()
      let stalls = 0
      const { fetch, calls } = fakeFetch(c, (call) =>
        stall(call) && ++stalls === 1 ? "stall" : mailbox(call),
      )
      const out = await c.run(driver(c, fetch).waitFor(query(120_000)))
      expect(out.state).toBe("resolved")
      expect(out.at - c.start).toBe(31_000)
      expect(calls.filter(stall)).toHaveLength(2)
    })
  }

  test("each request gets only the time the wait has left", async () => {
    const c = virtualClock()
    let lists = 0
    const { fetch, calls } = fakeFetch(c, (call) => {
      if (!isList(call)) return mailbox(call)
      lists += 1
      if (lists === 1) {
        return json(
          429,
          { error: { code: "TooManyRequests" } },
          {
            "Retry-After": "7",
          },
        )
      }
      return "hang"
    })
    const out = await c.run(driver(c, fetch).waitFor(query(10_000)))
    const error = rejected(out)
    expect(error).toBeInstanceOf(TimeoutError)
    expect(out.at - c.start).toBe(10_000)
    // Retry-After (7 s) and poll's 1 s back-off leave 2 s for the next read.
    expect(c.sleeps).toEqual([7_000, 1_000])
    expect(calls.filter(isList).map((call) => call.timerMs)).toEqual([
      10_000, 2_000,
    ])
    expect(calls.filter(isList)[1].signal?.aborted).toBe(true)
    // Count-only: nothing about any message, the request or a secret.
    expect(error.message).toContain(
      "Last observed: Graph request got no answer within 2 s, retrying",
    )
    for (const leaked of [
      "AAMk",
      "Jane",
      "Private",
      "/users/",
      "qa%40example.com",
      "graph.microsoft.com",
      ...SECRET_FORMS,
      TOKEN,
    ]) {
      expect(error.message).not.toContain(leaked)
    }
  })

  test("no request is issued once the wait has no time left", async () => {
    const c = virtualClock()
    const { fetch, calls } = fakeFetch(c, (call) =>
      isList(call) ? new Response(null, { status: 429 }) : undefined,
    )
    const out = await c.run(driver(c, fetch).waitFor(query(3_000)))
    const error = rejected(out)
    expect(error).toBeInstanceOf(TimeoutError)
    expect(out.at - c.start).toBe(3_000)
    // Polls at 0 s and 1 s; at 3 s the last observed state is reported as is.
    expect(calls.filter(isList)).toHaveLength(2)
    expect(error.message).toContain("Graph HTTP 429, retrying")
  })

  test("a timed-out token request inside a wait is re-polled, not fatal", async () => {
    const c = virtualClock()
    let tokens = 0
    const { fetch, calls } = fakeFetch(c, (call) => {
      if (isToken(call) && ++tokens === 1) return "hang"
      return mailbox(call)
    })
    const d = driver(c, fetch, { requestTimeoutMs: 5_000 })
    const out = await c.run(d.waitFor(query(60_000)))
    expect(out.state).toBe("resolved")
    // #18: a token timeout now gets the 5 s token back-off before poll's 1 s.
    expect(out.at - c.start).toBe(11_000)
    expect(tokens).toBe(2)
    expect(calls.filter(isToken)[0].signal?.aborted).toBe(true)
  })
})

test.describe("the shared token request", () => {
  test("a caller with little time left does not cut it short for the others", async () => {
    const c = virtualClock()
    let release!: () => void
    const { fetch, calls } = fakeFetch(c, (call) => {
      if (!isToken(call)) return undefined
      return new Promise<Response>((resolve) => {
        release = () =>
          resolve(json(200, { access_token: TOKEN, expires_in: 3600 }))
      })
    })
    const d = driver(c, fetch)
    const short = d.waitFor(query(2_000))
    const full = d.health()

    const shortOut = await c.run(short)
    expect(rejected(shortOut)).toBeInstanceOf(TimeoutError)
    expect(shortOut.at - c.start).toBe(2_000)
    const token = calls.filter(isToken)
    expect(token).toHaveLength(1)
    // Started by the short caller, yet bounded by the full 30 s, and still live.
    expect(token[0].timerMs).toBe(30_000)
    expect(token[0].signal?.aborted).toBe(false)

    release()
    expect((await c.run(full)).state).toBe("resolved")
    expect(calls.filter(isToken)).toHaveLength(1)
  })

  test("after a token timeout the next call asks for a new token", async () => {
    const c = virtualClock()
    let tokens = 0
    const { fetch } = fakeFetch(c, (call) =>
      isToken(call) && ++tokens === 1 ? "hang" : undefined,
    )
    const d = driver(c, fetch)
    const first = rejected(await c.run(d.health()))
    expect((first.cause as GraphRequestTimeoutError).operation).toBe(
      "token request",
    )
    expect((await c.run(d.health())).state).toBe("resolved")
    expect(tokens).toBe(2)
  })
})

test.describe("sends are never retried", () => {
  for (const ending of ["hang", "deaf"] as const) {
    test(`a sendMail that gets no answer (${ending}) may have been sent`, async () => {
      const c = virtualClock()
      const { fetch, calls } = fakeFetch(c, (call) =>
        isSendMail(call) ? ending : undefined,
      )
      const error = rejected(await c.run(driver(c, fetch).send(mail)))
      expect(c.now() - c.start).toBe(30_000)
      expect(error).toBeInstanceOf(GraphRequestTimeoutError)
      const timeout = error as GraphRequestTimeoutError
      expect(timeout.mayHaveSent).toBe(true)
      expect(timeout.operation).toBe(`POST ${MAILBOX_PATH}/sendMail`)
      // #19: a may-have-sent message also names the client-request-id.
      expect(timeout.message).toBe(
        `Graph POST ${MAILBOX_PATH}/sendMail got no answer within 30 s${SEND_HINT}${supportIds(calls.filter(isSendMail)[0].id)}`,
      )
      expect(calls.filter(isSendMail)).toHaveLength(1)
    })
  }

  // #17: a 2xx status means sent, so a sendMail whose 200 body then stalls
  // resolves at once (it was the "stall" row of the may-have-sent loop).
  test("a sendMail whose 2xx body never ends was sent: it resolves", async () => {
    const c = virtualClock()
    const { fetch, calls } = fakeFetch(c, (call) =>
      isSendMail(call) ? "stall" : undefined,
    )
    const out = await c.run(driver(c, fetch).send(mail))
    expect(out.state).toBe("resolved")
    expect(c.now() - c.start).toBe(0)
    expect(calls.filter(isSendMail)).toHaveLength(1)
  })

  test("a reply whose send gets no answer may have been sent", async () => {
    const c = virtualClock()
    const { fetch, calls } = fakeFetch(c, (call) => {
      if (isCreateReply(call)) return json(201, { id: "draft-1" })
      if (isPatch(call)) return json(200, { id: "draft-1" })
      if (isDraftSend(call)) return "hang"
      return undefined
    })
    const error = rejected(
      await c.run(
        driver(c, fetch).reply(original, { from: MAILBOX, text: "t" }),
      ),
    )
    expect(error).toBeInstanceOf(GraphRequestTimeoutError)
    expect((error as GraphRequestTimeoutError).mayHaveSent).toBe(true)
    // #19: a may-have-sent message also names the client-request-id.
    expect(error.message).toBe(
      `Graph POST ${MAILBOX_PATH}/messages/draft-1/send got no answer within 30 s${SEND_HINT}${supportIds(calls.filter(isDraftSend)[0].id)}`,
    )
    expect(calls.filter(isCreateReply)).toHaveLength(1)
    expect(calls.filter(isPatch)).toHaveLength(1)
    expect(calls.filter(isDraftSend)).toHaveLength(1)
  })

  test("a draft step that gets no answer has sent nothing", async () => {
    for (const step of ["createReply", "PATCH"] as const) {
      const c = virtualClock()
      const { fetch, calls } = fakeFetch(c, (call) => {
        if (isCreateReply(call)) {
          return step === "createReply" ? "hang" : json(201, { id: "draft-1" })
        }
        if (isPatch(call)) return "hang"
        return undefined
      })
      const error = rejected(
        await c.run(
          driver(c, fetch).reply(original, { from: MAILBOX, text: "t" }),
        ),
      )
      expect(error, step).toBeInstanceOf(GraphRequestTimeoutError)
      expect((error as GraphRequestTimeoutError).mayHaveSent, step).toBe(false)
      expect(error.message, step).not.toContain("may have been sent")
      expect(error.message, step).toMatch(/got no answer within 30 s$/)
      expect(calls.filter(isCreateReply), step).toHaveLength(1)
      expect(calls.filter(isPatch), step).toHaveLength(
        step === "createReply" ? 0 : 1,
      )
      expect(calls.filter(isDraftSend), step).toHaveLength(0)
    }
  })

  test("a token timeout before a send or reply sends nothing", async () => {
    for (const act of ["send", "reply"] as const) {
      const c = virtualClock()
      const { fetch, calls } = fakeFetch(c, (call) =>
        isToken(call) ? "hang" : undefined,
      )
      const d = driver(c, fetch)
      const error = rejected(
        await c.run(
          act === "send"
            ? d.send(mail)
            : d.reply(original, { from: MAILBOX, text: "t" }),
        ),
      )
      expect(error, act).toBeInstanceOf(GraphRequestTimeoutError)
      expect((error as GraphRequestTimeoutError).operation, act).toBe(
        "token request",
      )
      expect((error as GraphRequestTimeoutError).mayHaveSent, act).toBe(false)
      expect(
        calls.filter((call) => !isToken(call)),
        act,
      ).toEqual([])
    }
  })
})
