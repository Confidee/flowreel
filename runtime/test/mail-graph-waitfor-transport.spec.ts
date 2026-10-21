// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "@playwright/test"

import { TimeoutError } from "../src/core/index.js"
import type { MailMessage } from "../src/mail/index.js"
import {
  GraphHttpError,
  GraphRequestTimeoutError,
  GraphTransportError,
  type GraphMailDriver,
} from "../src/mail-graph/index.js"
import * as outcome from "../src/mail-graph/outcome.js"
import type { VirtualClock } from "./virtual-clock.js"
import {
  type Answer,
  type Call,
  SECRET,
  TOKEN,
  brokenBody,
  clocks,
  draftSteps,
  driver,
  fakeFetch,
  isCreateReply,
  isDraftSend,
  isHealth,
  isList,
  isMessageGet,
  isPatch,
  isSaveEml,
  isSendMail,
  isToken,
  json,
  leakedSecrets,
  mail,
  mailbox,
  mayHaveSentOf,
  original,
  query,
  rejected,
  replyMail,
} from "./graph-fake.js"
import { unhandledRejections, virtualClock } from "./virtual-clock.js"

// Issue #23: inside waitFor, a connection error on a read (the list, a
// per-message GET) or on the token request ended the wait at once, although
// none of them can send mail. The fix re-polls a listed set of temporary
// network codes (ECONNRESET, UND_ERR_SOCKET, EPIPE, ECONNABORTED, ETIMEDOUT,
// EAI_AGAIN and undici's connect, headers and body timeouts) with #18's
// back-off (5 s, then 10 s, 20 s … up to 60 s; never past the wait's end),
// on two separate counters: the token's and the mail reads'. Only once that
// endpoint has answered this driver at least once: a connection error at
// first contact (a firewall, broken DNS) still fails fast. Anything unknown
// or without a code stays fatal, and so do configuration faults (ENOTFOUND,
// ECONNREFUSED, TLS). What a re-poll observed names the step, the code and
// the count only. Outside waitFor nothing is retried, and nothing that may
// have sent mail is ever transient.

/** The codes #23 re-polls: pinned, so a code added or dropped is a decision. */
const ALLOWLIST = [
  "ECONNRESET",
  "UND_ERR_SOCKET",
  "EPIPE",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
] as const

/** A system error whose message echoes a peer, the secret and the token. */
function systemError(
  message: string,
  code: string,
  extra: Record<string, unknown> = {},
): Error {
  return Object.assign(
    new Error(`${message} 10.20.30.40:443 ${SECRET} Bearer ${TOKEN}`),
    { code, ...extra },
  )
}

/** undici's `fetch failed` around `cause`. */
function fetchFailed(cause: unknown): TypeError {
  return new TypeError("fetch failed", { cause })
}

/** `code` as fetch reports it: a `fetch failed` around a system error. */
const failedWith = (code: string) => () =>
  fetchFailed(systemError(`failure ${code}`, code))

/** Node's happy-eyeballs AggregateError: its own code is the first one's. */
function aggregate(...codes: string[]): TypeError {
  const errors = codes.map((code) =>
    systemError(`connect ${code}`, code, { syscall: "connect" }),
  )
  return fetchFailed(
    Object.assign(new AggregateError(errors, ""), { code: codes[0] }),
  )
}

/** A 200 whose body is cut short ("terminated", UND_ERR_SOCKET). */
function bodyCut(): Answer {
  return brokenBody(200)
}

/** health() wraps the request's error in its own: the transport error is its cause. */
function transportOf(error: Error): unknown {
  return error instanceof GraphTransportError ? error : error.cause
}

/** The transient transport failures #23 re-polls, as fetch reports them. */
const TRANSIENT: [string, string, (call: Call) => Answer][] = [
  [
    "read ECONNRESET",
    "ECONNRESET",
    () =>
      fetchFailed(
        systemError("read ECONNRESET", "ECONNRESET", { syscall: "read" }),
      ),
  ],
  [
    'UND_ERR_SOCKET "other side closed"',
    "UND_ERR_SOCKET",
    () =>
      fetchFailed(
        Object.assign(systemError("other side closed", "UND_ERR_SOCKET"), {
          name: "SocketError",
        }),
      ),
  ],
  [
    "getaddrinfo EAI_AGAIN (transient DNS)",
    "EAI_AGAIN",
    (call) => {
      const hostname = new URL(call.url).hostname
      return fetchFailed(
        systemError(`getaddrinfo EAI_AGAIN ${hostname}`, "EAI_AGAIN", {
          syscall: "getaddrinfo",
          hostname,
        }),
      )
    },
  ],
  // The status line arrived (200), then the body was cut short.
  ['a body "terminated"', "UND_ERR_SOCKET", bodyCut],
]
const RESET = TRANSIENT[0][2]

/** Configuration faults, and errors the allowlist does not name: fatal. */
const FATAL: [string, (call: Call) => Answer][] = [
  [
    "getaddrinfo ENOTFOUND",
    (call) => {
      const hostname = new URL(call.url).hostname
      return fetchFailed(
        systemError(`getaddrinfo ENOTFOUND ${hostname}`, "ENOTFOUND", {
          syscall: "getaddrinfo",
          hostname,
        }),
      )
    },
  ],
  [
    "connect ECONNREFUSED",
    () =>
      fetchFailed(
        systemError("connect ECONNREFUSED", "ECONNREFUSED", {
          syscall: "connect",
        }),
      ),
  ],
  ...(
    [
      "CERT_HAS_EXPIRED",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "ERR_TLS_CERT_ALTNAME_INVALID",
      "ERR_SSL_WRONG_VERSION_NUMBER",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "EAI_FAIL",
      "UND_ERR_ABORTED",
      "UND_ERR_INVALID_ARG",
      "ERR_INVALID_URL",
    ] as const
  ).map((code): [string, (call: Call) => Answer] => [code, failedWith(code)]),
  // A project's own fetch that throws without any code: a bug, not a blip.
  ["a fetch failed without a code", () => fetchFailed(new Error("x"))],
  ["a plain Error", () => new Error(`boom ${SECRET}`)],
  [
    "an AggregateError mixing ETIMEDOUT and ENETUNREACH",
    () => aggregate("ETIMEDOUT", "ENETUNREACH"),
  ],
]

/** Where a waitFor request fails. */
const PLACES: [string, (call: Call) => boolean][] = [
  ["the list read", isList],
  ["a per-message GET", isMessageGet],
  ["the token request", isToken],
]

/** Fails the first `failures` requests `kind` matches with `answer`, then answers. */
function flaky(
  kind: (call: Call) => boolean,
  failures: number,
  answer: (call: Call) => Answer,
) {
  let seen = 0
  return (call: Call): Answer => {
    if (kind(call) && ++seen <= failures) return answer(call)
    return mailbox(call)
  }
}

/** Always fails what `kind` matches with `answer`. */
function always(kind: (call: Call) => boolean, answer: (call: Call) => Answer) {
  return (call: Call): Answer => (kind(call) ? answer(call) : mailbox(call))
}

/**
 * A driver that has reached both endpoints once (a health check), with a
 * token already stale so the wait's first poll asks for a new one. `calls`
 * holds the wait's requests only.
 */
async function warmed(c: VirtualClock, respond: (call: Call) => Answer) {
  let warming = true
  const { fetch, calls } = fakeFetch(c, (call) => {
    if (!warming) return respond(call)
    // Valid for 60 s, which is the driver's skew: stale at once.
    return isToken(call)
      ? json(200, { access_token: TOKEN, expires_in: 60 })
      : undefined
  })
  const d = driver(c, fetch)
  const warm = await c.run(d.health())
  expect(warm.state).toBe("resolved")
  expect(calls.map((call) => (isToken(call) ? "token" : "health"))).toEqual([
    "token",
    "health",
  ])
  warming = false
  calls.splice(0)
  return { d, calls }
}

/** The text a wait that timed out last observed (defensive: TimeoutError's field). */
function lastObservedOf(error: Error): string {
  return String(
    (error as { lastObserved?: unknown }).lastObserved ?? error.message,
  )
}

/** What a timed-out wait's report must never show of the error or the run. */
const NEVER_OBSERVED = [
  "10.20.30.40",
  "fetch failed",
  "Bearer",
  "graph.microsoft.com",
  "login.microsoftonline.com",
  "tenant-1",
  "oauth2",
  "/users/",
  "qa%40example.com",
  "/messages",
  "AAMk",
  "RUN-123",
]

/** The classifier under test, read defensively (it is new in #23). */
function isTransientTransport(error: unknown): boolean {
  const classify = (outcome as unknown as Record<string, unknown>)
    .isTransientTransport
  expect(typeof classify, "outcome.isTransientTransport").toBe("function")
  return (classify as (error: unknown) => boolean)(error)
}

const LIST_OP = "GET /users/qa%40example.com/messages"
const MESSAGE_OP = "GET /users/qa%40example.com/messages/AAMk-1%3D"

function transport(
  operation: string,
  code: string | undefined,
  mayHaveSent = false,
): GraphTransportError {
  return new GraphTransportError("x", operation, {
    code,
    mayHaveSent,
    clientRequestId: "c",
  })
}

let rejections: ReturnType<typeof unhandledRejections>
test.beforeEach(() => {
  rejections = unhandledRejections()
})
test.afterEach(async () => {
  for (const c of clocks.splice(0)) {
    expect(c.armed().map((h) => h.ms)).toEqual([])
  }
  expect(await rejections.stop()).toEqual([])
})

test.describe("#23: the transport classifier", () => {
  test("every allowlisted code is transient on a mail read and on the token request", () => {
    for (const operation of [LIST_OP, MESSAGE_OP, "token request"]) {
      for (const code of ALLOWLIST) {
        expect(
          isTransientTransport(transport(operation, code)),
          `${operation} ${code}`,
        ).toBe(true)
      }
    }
  })

  test("a code the allowlist does not name, or none, is not", () => {
    for (const code of [
      undefined,
      "",
      "ECONNREFUSED",
      "ENOTFOUND",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "EAI_FAIL",
      "CERT_HAS_EXPIRED",
      "ERR_SSL_WRONG_VERSION_NUMBER",
      "ERR_TLS_CERT_ALTNAME_INVALID",
      "UND_ERR_ABORTED",
      "UND_ERR_CLOSED",
      "UND_ERR_INFO",
      "econnreset",
      "ECONNRESET ",
    ]) {
      expect(isTransientTransport(transport(LIST_OP, code)), String(code)).toBe(
        false,
      )
    }
  })

  test("only a GET read or the token request: never a write, whatever its code", () => {
    for (const operation of [
      "POST /users/qa%40example.com/sendMail",
      "POST /users/qa%40example.com/messages/AAMk-1%3D/createReply",
      "PATCH /users/qa%40example.com/messages/draft-1",
      "POST /users/qa%40example.com/messages/draft-1/send",
      "DELETE /users/qa%40example.com/messages/AAMk-1%3D",
      "GETX /users/qa%40example.com/messages",
      "get /users/qa%40example.com/messages",
    ]) {
      expect(
        isTransientTransport(transport(operation, "ECONNRESET")),
        operation,
      ).toBe(false)
    }
  })

  test("only a transport error: never an HTTP error, a timeout or anything else", () => {
    for (const error of [
      new GraphHttpError("x", LIST_OP, 503, undefined, {
        mayHaveSent: false,
        clientRequestId: "c",
      }),
      new GraphRequestTimeoutError("x", LIST_OP, 5_000, false, "c"),
      Object.assign(new Error("x"), {
        operation: LIST_OP,
        code: "ECONNRESET",
        mayHaveSent: false,
      }),
      fetchFailed(systemError("read ECONNRESET", "ECONNRESET")),
      null,
      undefined,
      "ECONNRESET",
    ]) {
      expect(isTransientTransport(error), String(error)).toBe(false)
    }
  })

  test("tripwire first: may-have-sent is never transient, even on a GET", () => {
    for (const operation of [LIST_OP, "token request"]) {
      for (const code of ALLOWLIST) {
        expect(
          isTransientTransport(transport(operation, code, true)),
          `${operation} ${code}`,
        ).toBe(false)
      }
    }
  })

  test("isTransientRead is scoped to GET reads too: a sendMail 429 that sent nothing is not a read", () => {
    const http = (operation: string, status: number) =>
      new GraphHttpError("x", operation, status, undefined, {
        mayHaveSent: false,
        clientRequestId: "c",
      })
    for (const status of [429, 503, 504]) {
      expect(
        outcome.isTransientRead(http(LIST_OP, status)),
        `list ${status}`,
      ).toBe(true)
      for (const operation of [
        "POST /users/qa%40example.com/sendMail",
        "POST /users/qa%40example.com/messages/draft-1/send",
        "PATCH /users/qa%40example.com/messages/draft-1",
        "POST /users/qa%40example.com/messages/AAMk-1%3D/createReply",
      ]) {
        expect(
          outcome.isTransientRead(http(operation, status)),
          `${operation} ${status}`,
        ).toBe(false)
      }
    }
    expect(
      outcome.isTransientRead(
        new GraphRequestTimeoutError(
          "x",
          "POST /users/qa%40example.com/messages/AAMk-1%3D/createReply",
          5_000,
          false,
          "c",
        ),
      ),
    ).toBe(false)
  })
})

test.describe("#23: a transient transport error inside waitFor is re-polled", () => {
  for (const [place, kind] of PLACES) {
    for (const [name, , answer] of TRANSIENT) {
      test(`${name} on ${place}, once, then success: the wait resolves after 5 s + poll's 1 s`, async () => {
        const c = virtualClock()
        const { d, calls } = await warmed(c, flaky(kind, 1, answer))
        const out = await c.run(d.waitFor(query(60_000)))
        if (out.state === "rejected") {
          throw new Error(
            `expected the wait to resolve, it rejected with ${(out.error as Error).name}: ${(out.error as Error).message}`,
          )
        }
        expect(out.state).toBe("resolved")
        expect((out as { value: MailMessage }).value.id).toBe("AAMk-1=")
        // #18's back-off from 5 s, then poll's own 1 s.
        expect(c.sleeps).toEqual([5_000, 1_000])
        const of = calls.filter(kind)
        expect(of).toHaveLength(2)
        expect(of[1].at - of[0].at).toBe(6_000)
        expect(calls.filter(isSendMail)).toHaveLength(0)
      })
    }
  }

  test("every allowlisted code on the list read is re-polled", async () => {
    for (const code of ALLOWLIST) {
      const c = virtualClock()
      const { d, calls } = await warmed(c, flaky(isList, 1, failedWith(code)))
      const out = await c.run(d.waitFor(query(60_000)))
      expect(out.state, code).toBe("resolved")
      expect(c.sleeps, code).toEqual([5_000, 1_000])
      expect(calls.filter(isList), code).toHaveLength(2)
    }
  })

  test("an AggregateError is re-polled only when every inner code is listed", async () => {
    const c = virtualClock()
    const { d } = await warmed(
      c,
      flaky(isList, 1, () => aggregate("ETIMEDOUT", "ETIMEDOUT")),
    )
    const out = await c.run(d.waitFor(query(60_000)))
    expect(out.state).toBe("resolved")
    expect(c.sleeps).toEqual([5_000, 1_000])
  })

  for (const [place, kind] of [PLACES[0], PLACES[2]]) {
    test(`two consecutive ECONNRESETs on ${place}: 5 s, then 10 s, then the wait resolves`, async () => {
      const c = virtualClock()
      const { d, calls } = await warmed(c, flaky(kind, 2, RESET))
      const out = await c.run(d.waitFor(query(60_000)))
      expect(out.state).toBe("resolved")
      expect(c.sleeps).toEqual([5_000, 1_000, 10_000, 2_000])
      expect(calls.filter(kind).map((call) => call.at - c.start)).toEqual([
        0, 6_000, 18_000,
      ])
    })
  }

  test("a completed poll resets the read counter: fail, poll, fail backs off 5 s each time", async () => {
    const c = virtualClock()
    let lists = 0
    const { d } = await warmed(c, (call) => {
      if (isList(call)) {
        lists += 1
        if (lists === 1 || lists === 3) return RESET(call)
        // The second list completes, with nothing in it yet.
        if (lists === 2) return json(200, { value: [] })
      }
      return mailbox(call)
    })
    const out = await c.run(d.waitFor(query(120_000)))
    expect(out.state).toBe("resolved")
    expect(lists).toBe(4)
    // 5 s + poll 1 s; an empty list (poll 2 s); 5 s again, not 10 s + poll 4 s.
    expect(c.sleeps).toEqual([5_000, 1_000, 2_000, 5_000, 4_000])
  })

  test("the token's and the reads' counters are separate", async () => {
    const c = virtualClock()
    let tokens = 0
    let lists = 0
    const { d } = await warmed(c, (call) => {
      // A token failure, then a list failure, then success: each is the
      // first of its own kind, so each backs off 5 s.
      if (isToken(call) && ++tokens === 1) return RESET(call)
      if (isList(call) && ++lists === 1) return RESET(call)
      return mailbox(call)
    })
    const out = await c.run(d.waitFor(query(120_000)))
    expect(out.state).toBe("resolved")
    expect(c.sleeps).toEqual([5_000, 1_000, 5_000, 2_000])
  })

  test("a token in hand does not reset the reads' counter", async () => {
    const c = virtualClock()
    let lists = 0
    // Every poll gets a token; the first two lists fail: 5 s, then 10 s.
    const { d } = await warmed(c, (call) => {
      if (isToken(call)) {
        return json(200, { access_token: TOKEN, expires_in: 60 })
      }
      if (isList(call) && ++lists <= 2) return RESET(call)
      return mailbox(call)
    })
    const out = await c.run(d.waitFor(query(120_000)))
    expect(out.state).toBe("resolved")
    expect(c.sleeps).toEqual([5_000, 1_000, 10_000, 2_000])
  })

  for (const [place, kind, leg] of [
    [PLACES[0][0], PLACES[0][1], "Graph read"],
    [PLACES[2][0], PLACES[2][1], "Graph token request"],
  ] as const) {
    test(`ECONNRESET on ${place} that never recovers ends at the wait's timeoutMs: a core TimeoutError, count-only`, async () => {
      const c = virtualClock()
      const { d, calls } = await warmed(c, always(kind, RESET))
      const out = await c.run(d.waitFor(query(20_000)))
      const error = rejected(out)
      expect(error, `${error.name}: ${error.message}`).toBeInstanceOf(
        TimeoutError,
      )
      expect(out.at - c.start).toBe(20_000)
      // 0 s, then 5 s + 1 s, then 10 s + 2 s; the third back-off is cut to
      // the 2 s the wait had left.
      expect(calls.filter(kind).map((call) => call.at - c.start)).toEqual([
        0, 6_000, 18_000,
      ])
      expect(c.sleeps).toEqual([5_000, 1_000, 10_000, 2_000, 2_000])
      const observed = lastObservedOf(error)
      // The leg, the code and the count; nothing of the error, request or run.
      expect(observed).toContain(`${leg} failed (ECONNRESET), 3 in a row`)
      for (const leaked of NEVER_OBSERVED) {
        expect(observed).not.toContain(leaked)
      }
      expect(leakedSecrets(error)).toEqual([])
    })
  }

  test("a read that never recovers says no mailbox read completed in this wait", async () => {
    const c = virtualClock()
    const { d } = await warmed(c, always(isList, RESET))
    const error = rejected(await c.run(d.waitFor(query(20_000))))
    expect(lastObservedOf(error)).toContain(
      "no mailbox read completed in this wait",
    )
  })

  test("after a completed read, a failing one does not say none completed", async () => {
    const c = virtualClock()
    let lists = 0
    const { d } = await warmed(c, (call) => {
      if (isList(call) && ++lists === 1) return json(200, { value: [] })
      return isList(call) ? RESET(call) : mailbox(call)
    })
    const error = rejected(await c.run(d.waitFor(query(20_000))))
    const observed = lastObservedOf(error)
    expect(observed).toContain("Graph read failed (ECONNRESET), ")
    expect(observed).not.toContain("no mailbox read completed")
  })

  test("every allowlisted code that never recovers ends at the wait's end, its code observed", async () => {
    for (const code of ALLOWLIST) {
      const c = virtualClock()
      const { d } = await warmed(c, always(isList, failedWith(code)))
      const out = await c.run(d.waitFor(query(20_000)))
      const error = rejected(out)
      expect(error, code).toBeInstanceOf(TimeoutError)
      expect(out.at - c.start, code).toBe(20_000)
      expect(lastObservedOf(error), code).toContain(`(${code})`)
      expect(leakedSecrets(error), code).toEqual([])
    }
  })

  test("the back-off never outlives the wait: a 3 s wait sleeps 3 s, not 5 s", async () => {
    const c = virtualClock()
    const { d, calls } = await warmed(c, always(isList, RESET))
    const out = await c.run(d.waitFor(query(3_000)))
    const error = rejected(out)
    expect(error, `${error.name}: ${error.message}`).toBeInstanceOf(
      TimeoutError,
    )
    expect(out.at - c.start).toBe(3_000)
    expect(c.sleeps).toEqual([3_000])
    expect(calls.filter(isList)).toHaveLength(1)
    expect(leakedSecrets(error)).toEqual([])
  })

  test("transient, then fatal: the fatal error ends the wait at once", async () => {
    const c = virtualClock()
    let lists = 0
    const { d, calls } = await warmed(c, (call) => {
      if (isList(call)) {
        lists += 1
        return lists === 1 ? RESET(call) : FATAL[1][1](call)
      }
      return mailbox(call)
    })
    const out = await c.run(d.waitFor(query(60_000)))
    const error = rejected(out)
    expect(error).toBeInstanceOf(GraphTransportError)
    expect((error as GraphTransportError).code).toBe("ECONNREFUSED")
    expect(out.at - c.start).toBe(6_000)
    expect(calls.filter(isList)).toHaveLength(2)
    expect(leakedSecrets(error)).toEqual([])
  })
})

test.describe("#23 guards: first contact fails fast", () => {
  for (const [place, kind] of [PLACES[0], PLACES[2]]) {
    test(`ECONNRESET on ${place} before that endpoint ever answered ends the wait at once`, async () => {
      const c = virtualClock()
      const { fetch, calls } = fakeFetch(c, always(kind, RESET))
      const out = await c.run(driver(c, fetch).waitFor(query(60_000)))
      const error = rejected(out)
      expect(out.at).toBe(c.start)
      expect(error).toBeInstanceOf(GraphTransportError)
      expect(error).not.toBeInstanceOf(TimeoutError)
      expect(calls.filter(kind)).toHaveLength(1)
      expect(c.sleeps).toEqual([])
      expect(leakedSecrets(error)).toEqual([])
    })
  }

  test("a token from the token endpoint does not vouch for Graph: the first list's ECONNRESET is fatal", async () => {
    const c = virtualClock()
    const { fetch, calls } = fakeFetch(c, always(isList, RESET))
    const out = await c.run(driver(c, fetch).waitFor(query(60_000)))
    expect(rejected(out)).toBeInstanceOf(GraphTransportError)
    expect(calls.filter(isToken)).toHaveLength(1)
    expect(calls.filter(isList)).toHaveLength(1)
  })

  test("a status line is contact: a first list whose body is cut short is re-polled", async () => {
    const c = virtualClock()
    const { fetch } = fakeFetch(c, flaky(isList, 1, bodyCut))
    const out = await c.run(driver(c, fetch).waitFor(query(60_000)))
    expect(out.state).toBe("resolved")
    expect(c.sleeps).toEqual([5_000, 1_000])
  })

  test("an HTTP error is contact too: after a throttled first list, a reset is re-polled", async () => {
    const c = virtualClock()
    let lists = 0
    const { fetch } = fakeFetch(c, (call) => {
      if (isList(call)) {
        lists += 1
        if (lists === 1) return json(503, { error: { code: "Busy" } })
        if (lists === 2) return RESET(call)
      }
      return mailbox(call)
    })
    const out = await c.run(driver(c, fetch).waitFor(query(60_000)))
    expect(out.state).toBe("resolved")
    // 503: poll 1 s; the reset: 5 s + poll 2 s.
    expect(c.sleeps).toEqual([1_000, 5_000, 2_000])
  })
})

test.describe("#23 guards: configuration faults and unknown errors stay fatal inside waitFor", () => {
  for (const [place, kind] of PLACES) {
    for (const [name, answer] of FATAL) {
      test(`${name} on ${place} ends the wait at once`, async () => {
        const c = virtualClock()
        const { d, calls } = await warmed(c, always(kind, answer))
        const out = await c.run(d.waitFor(query(60_000)))
        const error = rejected(out)
        expect(out.at).toBe(c.start)
        expect(error).toBeInstanceOf(GraphTransportError)
        expect(error).not.toBeInstanceOf(TimeoutError)
        expect(calls.filter(kind)).toHaveLength(1)
        expect(c.sleeps).toEqual([])
        expect(leakedSecrets(error)).toEqual([])
      })
    }
  }
})

test.describe("#23 guards: outside waitFor a transport error is never retried", () => {
  const ACTS: [
    string,
    (call: Call) => boolean,
    (d: GraphMailDriver, dir: string) => Promise<unknown>,
    /** The failing request sends mail: an ECONNRESET may have sent it. */
    boolean,
  ][] = [
    ["send", isSendMail, (d) => d.send(mail), true],
    [
      "reply's createReply",
      isCreateReply,
      (d) => d.reply(original, replyMail),
      false,
    ],
    ["reply's PATCH", isPatch, (d) => d.reply(original, replyMail), false],
    ["reply's send", isDraftSend, (d) => d.reply(original, replyMail), true],
    ["health", isHealth, (d) => d.health(), false],
    ["saveEml", isSaveEml, (d, dir) => d.saveEml(original, dir), false],
  ]

  test("a transient transport error on the act's own request or its token request fails at once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flowreel-transport-"))
    try {
      for (const [act, kind, run, sends] of ACTS) {
        for (const [where, failing] of [
          ["own request", kind],
          ["token request", isToken],
        ] as [string, (call: Call) => boolean][]) {
          for (const [name, , answer] of TRANSIENT) {
            // A sending request's 2xx is sent: its body is never read.
            if (sends && where === "own request" && answer === bodyCut) continue
            const label = `${act}, ${name} on its ${where}`
            const c = virtualClock()
            const { fetch, calls } = fakeFetch(c, (call) =>
              failing(call) ? answer(call) : draftSteps(call),
            )
            const out = await c.run(run(driver(c, fetch), join(dir, act)))
            const error = rejected(out)
            expect(out.at, label).toBe(c.start)
            expect(c.sleeps, label).toEqual([])
            expect(calls.filter(failing), label).toHaveLength(1)
            expect(transportOf(error), label).toBeInstanceOf(
              GraphTransportError,
            )
            expect(error, label).not.toBeInstanceOf(TimeoutError)
            expect(leakedSecrets(error), label).toEqual([])
            if (where === "token request") {
              expect(
                calls.filter((call) => !isToken(call)),
                label,
              ).toEqual([])
              expect(mayHaveSentOf(transportOf(error)), label).toBe(false)
            }
          }
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("tripwire: a send's ECONNRESET keeps mayHaveSent true and is sent once", async () => {
    for (const row of ACTS.filter((r) => r[3])) {
      const [act, kind, run] = row
      const c = virtualClock()
      const { fetch, calls } = fakeFetch(c, (call) =>
        kind(call) ? TRANSIENT[0][2](call) : draftSteps(call),
      )
      const out = await c.run(run(driver(c, fetch), ""))
      const error = rejected(out)
      expect(error, act).toBeInstanceOf(GraphTransportError)
      expect(mayHaveSentOf(error), act).toBe(true)
      expect(calls.filter(kind), act).toHaveLength(1)
      expect(c.sleeps, act).toEqual([])
    }
  })

  test("tripwire: every isTransient* classifier refuses an error that may have sent mail", () => {
    // Read the module defensively: the fix may add a transport classifier.
    const classifiers = Object.entries(
      outcome as unknown as Record<string, unknown>,
    ).filter(
      (entry): entry is [string, (error: unknown) => boolean] =>
        entry[0].startsWith("isTransient") && typeof entry[1] === "function",
    )
    expect(classifiers.length).toBeGreaterThanOrEqual(2)
    const sendOps = [
      "POST /users/qa%40example.com/sendMail",
      "POST /users/qa%40example.com/messages/draft-1/send",
    ]
    for (const operation of sendOps) {
      for (const code of ["ECONNRESET", "UND_ERR_SOCKET", "EAI_AGAIN"]) {
        const transport = new GraphTransportError("x", operation, {
          code,
          mayHaveSent: true,
          clientRequestId: "c",
        })
        const timeout = new GraphRequestTimeoutError(
          "x",
          operation,
          5_000,
          true,
          "c",
        )
        for (const [name, classify] of classifiers) {
          expect(classify(transport), `${name} ${operation} ${code}`).toBe(
            false,
          )
          expect(classify(timeout), `${name} ${operation} timeout`).toBe(false)
        }
      }
    }
  })
})
