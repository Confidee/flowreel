// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "@playwright/test"

import { TimeoutError } from "../src/core/index.js"
import type { MailMessage } from "../src/mail/index.js"
import {
  GraphHttpError,
  type GraphMailDriver,
} from "../src/mail-graph/index.js"
import {
  type Answer,
  type Call,
  SECRET,
  SECRET_FORMS,
  TOKEN,
  clocks,
  draftSteps,
  driver,
  fakeFetch,
  isList,
  isSendMail,
  isToken,
  json,
  leakedSecrets,
  mail,
  mailbox,
  original,
  query,
  rejected,
  replyMail,
} from "./graph-fake.js"
import { unhandledRejections, virtualClock } from "./virtual-clock.js"

// Issue #18: inside waitFor, a token request that meets a transient failure
// is re-polled: HTTP 429, 500, 502, 503 or 504, or an OAuth body whose
// `error` is temporarily_unavailable (whatever the status). A token
// request cannot send mail. Retry-After is honoured exactly (never past the
// wait's own end); without it the next token attempt waits 5 s, then 10 s,
// 20 s, … up to 60 s (Entra's daemon resilience guidance). A token request
// that got no answer gets the same back-off. A bad secret, tenant or
// consent (400, 401 otherwise) and a token transport error stay fatal, and
// outside waitFor nothing is retried. Never keyed on error_description.

/** An AAD transient reply whose description echoes the secret. */
function tokenError(
  status: number,
  headers: Record<string, string> = {},
): Response {
  return json(
    status,
    {
      error: "temporarily_unavailable",
      error_description: `AADSTS90024: Request budget exceeded, try again (client_secret=${SECRET})`,
    },
    headers,
  )
}

/** Fails the first `failures` token requests with `answer`, then answers. */
function flakyToken(failures: number, answer: () => Answer) {
  let tokens = 0
  return (call: Call): Answer => {
    if (isToken(call) && ++tokens <= failures) return answer()
    return mailbox(call)
  }
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

/** Runs a 60 s wait whose first `failures` token requests fail with `answer`. */
async function waitThrough(failures: number, answer: () => Answer) {
  const c = virtualClock()
  const { fetch, calls } = fakeFetch(c, flakyToken(failures, answer))
  const out = await c.run(driver(c, fetch).waitFor(query(60_000)))
  expect(out.state).toBe("resolved")
  expect((out as { value: MailMessage }).value.id).toBe("AAMk-1=")
  const tokens = calls.filter(isToken)
  expect(tokens).toHaveLength(failures + 1)
  return { c, tokens, out }
}

test.describe("a transient token failure inside waitFor is re-polled", () => {
  test("429 with Retry-After 7: waits exactly 7 s, then the wait resolves", async () => {
    const { c, tokens } = await waitThrough(1, () =>
      tokenError(429, { "Retry-After": "7" }),
    )
    // The driver's 7 s, then poll's own 1 s back-off.
    expect(c.sleeps).toEqual([7_000, 1_000])
    expect(tokens[1].at - tokens[0].at).toBe(8_000)
  })

  test("a Retry-After shorter than 5 s is honoured exactly", async () => {
    const { c } = await waitThrough(1, () =>
      tokenError(503, { "Retry-After": "2" }),
    )
    expect(c.sleeps).toEqual([2_000, 1_000])
  })

  test("a Retry-After as an HTTP date is honoured exactly", async () => {
    const c0 = virtualClock()
    const at = new Date(c0.start + 9_000).toUTCString()
    const { c } = await waitThrough(1, () =>
      tokenError(503, { "Retry-After": at }),
    )
    expect(c.start).toBe(c0.start)
    expect(c.sleeps).toEqual([9_000, 1_000])
  })

  for (const status of [429, 500, 502, 503, 504]) {
    test(`HTTP ${status} without Retry-After: 5 s, then 10 s, then the wait resolves`, async () => {
      const { c, tokens } = await waitThrough(2, () => tokenError(status))
      // The driver's back-off (5 s, 10 s), each followed by poll's own.
      expect(c.sleeps).toEqual([5_000, 1_000, 10_000, 2_000])
      expect(tokens.map((t) => t.at - c.start)).toEqual([0, 6_000, 18_000])
    })
  }

  test("error temporarily_unavailable is transient at any status (HTTP 400)", async () => {
    const { c } = await waitThrough(1, () => tokenError(400))
    expect(c.sleeps).toEqual([5_000, 1_000])
  })

  test("the back-off doubles up to 60 s", async () => {
    const c = virtualClock()
    const { fetch, calls } = fakeFetch(
      c,
      flakyToken(6, () => tokenError(503)),
    )
    const out = await c.run(driver(c, fetch).waitFor(query(400_000)))
    expect(out.state).toBe("resolved")
    expect(calls.filter(isToken)).toHaveLength(7)
    expect(c.sleeps).toEqual([
      5_000, 1_000, 10_000, 2_000, 20_000, 4_000, 40_000, 5_000, 60_000, 5_000,
      60_000, 5_000,
    ])
  })

  test("a successful token request resets the back-off: only consecutive failures double it", async () => {
    const c = virtualClock()
    let tokens = 0
    let lists = 0
    const { fetch } = fakeFetch(c, (call) => {
      if (isToken(call)) {
        tokens += 1
        // Fails, succeeds (a token valid for 1 s), fails, then succeeds.
        if (tokens === 1 || tokens === 3) return tokenError(503)
        return json(200, { access_token: TOKEN, expires_in: 61 })
      }
      // The first list after the first good token is throttled.
      if (isList(call) && ++lists === 1) {
        return json(503, { error: { code: "ServiceUnavailable" } })
      }
      return mailbox(call)
    })
    const out = await c.run(driver(c, fetch).waitFor(query(120_000)))
    expect(out.state).toBe("resolved")
    expect(tokens).toBe(4)
    // 5 s back-off, poll 1 s; the token works, the list is throttled (poll
    // 2 s); the token has expired and fails again: 5 s again, not 10 s,
    // because the failure before it was not consecutive.
    expect(c.sleeps).toEqual([5_000, 1_000, 2_000, 5_000, 4_000])
  })

  test("a token request that got no answer gets the same back-off", async () => {
    const c = virtualClock()
    const { fetch } = fakeFetch(
      c,
      flakyToken(1, () => "hang"),
    )
    const out = await c.run(
      driver(c, fetch, { requestTimeoutMs: 5_000 }).waitFor(query(60_000)),
    )
    expect(out.state).toBe("resolved")
    // The 5 s bound, the 5 s back-off, then poll's own 1 s.
    expect(c.sleeps).toEqual([5_000, 1_000])
    expect(out.at - c.start).toBe(11_000)
  })

  test("Retry-After never outlives the wait: it ends at its own timeoutMs", async () => {
    const c = virtualClock()
    const { fetch, calls } = fakeFetch(
      c,
      flakyToken(1, () => tokenError(429, { "Retry-After": "120" })),
    )
    const out = await c.run(driver(c, fetch).waitFor(query(30_000)))
    const error = rejected(out)
    expect(error).toBeInstanceOf(TimeoutError)
    expect(out.at - c.start).toBe(30_000)
    expect(c.sleeps).toEqual([30_000])
    expect(calls.filter(isToken)).toHaveLength(1)
  })

  test("a token request that never recovers ends the wait at its timeoutMs, count-only", async () => {
    const c = virtualClock()
    const { fetch, calls } = fakeFetch(c, (call) =>
      isToken(call) ? tokenError(503) : mailbox(call),
    )
    const out = await c.run(driver(c, fetch).waitFor(query(20_000)))
    const error = rejected(out)
    expect(error).toBeInstanceOf(TimeoutError)
    expect(out.at - c.start).toBe(20_000)
    // 0 s, then 5 s + 1 s, then 10 s + 2 s; the third back-off is cut to
    // the 2 s the wait had left.
    expect(calls.filter(isToken).map((t) => t.at - c.start)).toEqual([
      0, 6_000, 18_000,
    ])
    expect(c.sleeps).toEqual([5_000, 1_000, 10_000, 2_000, 2_000])
    expect(error.message).toContain(
      "Last observed: Graph token request HTTP 503, retrying",
    )
    // Nothing about the request or a secret reaches the TimeoutError (and so
    // summary.md).
    for (const leaked of [
      ...SECRET_FORMS,
      TOKEN,
      "client_secret",
      "login.microsoftonline.com",
      "tenant-1",
      "oauth2",
      "AADSTS",
      "temporarily_unavailable",
      "/users/",
      "qa%40example.com",
    ]) {
      expect(error.message).not.toContain(leaked)
    }
    expect(leakedSecrets(error)).toEqual([])
  })

  test("a token request that never answers is reported count-only", async () => {
    const c = virtualClock()
    const { fetch } = fakeFetch(c, (call) =>
      isToken(call) ? "hang" : mailbox(call),
    )
    const out = await c.run(
      driver(c, fetch, { requestTimeoutMs: 5_000 }).waitFor(query(20_000)),
    )
    const error = rejected(out)
    expect(error).toBeInstanceOf(TimeoutError)
    expect(out.at - c.start).toBe(20_000)
    expect(error.message).toContain(
      "Last observed: Graph token request got no answer within 5 s, retrying",
    )
    expect(leakedSecrets(error)).toEqual([])
  })
})

test.describe("token errors that stay fatal", () => {
  for (const [name, status, body] of [
    [
      "a missing tenant",
      400,
      {
        error: "invalid_request",
        error_description: "AADSTS90002: Tenant 'tenant-1' not found.",
      },
    ],
    [
      "a bad secret",
      401,
      {
        error: "invalid_client",
        error_description: "AADSTS7000215: Invalid client secret provided.",
      },
    ],
    [
      "a loop (AADSTS50196)",
      400,
      {
        error: "invalid_request",
        error_description:
          "AADSTS50196: The server terminated an operation because it encountered a client request loop.",
      },
    ],
    [
      "a description that only mentions a transient code",
      400,
      {
        error: "invalid_request",
        error_description:
          "AADSTS90024: temporarily_unavailable, but the error says otherwise.",
      },
    ],
    ["missing consent", 400, { error: "unauthorized_client" }],
  ] as [string, number, unknown][]) {
    test(`HTTP ${status} (${name}) ends the wait at once`, async () => {
      const c = virtualClock()
      const { fetch, calls } = fakeFetch(c, (call) =>
        isToken(call) ? json(status, body) : mailbox(call),
      )
      const out = await c.run(driver(c, fetch).waitFor(query(60_000)))
      const error = rejected(out)
      expect(out.at).toBe(c.start)
      expect(error).toBeInstanceOf(GraphHttpError)
      expect(error).not.toBeInstanceOf(TimeoutError)
      expect((error as GraphHttpError).operation).toBe("token request")
      expect((error as GraphHttpError).status).toBe(status)
      expect(calls.filter(isToken)).toHaveLength(1)
      expect(c.sleeps).toEqual([])
    })
  }

  test("a token transport error ends the wait at once", async () => {
    const c = virtualClock()
    const { fetch, calls } = fakeFetch(c, (call) =>
      isToken(call)
        ? new TypeError("fetch failed", {
            cause: Object.assign(new Error("read ECONNRESET"), {
              code: "ECONNRESET",
              syscall: "read",
            }),
          })
        : mailbox(call),
    )
    const out = await c.run(driver(c, fetch).waitFor(query(60_000)))
    const error = rejected(out)
    expect(out.at).toBe(c.start)
    expect(error).not.toBeInstanceOf(TimeoutError)
    expect(error.name).toBe("GraphTransportError")
    expect(calls.filter(isToken)).toHaveLength(1)
  })

  test("outside waitFor a transient token failure is not retried and sends nothing", async () => {
    const acts: [
      string,
      (d: GraphMailDriver, dir: string) => Promise<unknown>,
    ][] = [
      ["send", (d) => d.send(mail)],
      ["reply", (d) => d.reply(original, replyMail)],
      ["health", (d) => d.health()],
      ["saveEml", (d, dir) => d.saveEml(original, dir)],
    ]
    const dir = await mkdtemp(join(tmpdir(), "flowreel-token-"))
    try {
      for (const [act, run] of acts) {
        for (const status of [429, 503]) {
          const label = `${act} ${status}`
          const c = virtualClock()
          const { fetch, calls } = fakeFetch(c, (call) =>
            isToken(call)
              ? tokenError(status, { "Retry-After": "1" })
              : draftSteps(call),
          )
          const out = await c.run(run(driver(c, fetch), join(dir, act)))
          rejected(out)
          expect(out.at, label).toBe(c.start)
          expect(c.sleeps, label).toEqual([])
          expect(calls.filter(isToken), label).toHaveLength(1)
          expect(
            calls.filter((call) => !isToken(call)),
            label,
          ).toEqual([])
          expect(calls.filter(isSendMail), label).toHaveLength(0)
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
