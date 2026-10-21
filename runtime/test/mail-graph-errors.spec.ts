// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "@playwright/test"

import {
  DEFAULT_GRAPH_DRIVER_COPY,
  GraphHttpError,
  GraphRequestError,
} from "../src/mail-graph/index.js"
import {
  type Answer,
  MAILBOX_PATH,
  SECRET,
  clientRequestIdOf,
  clocks,
  driver,
  fakeFetch,
  isCreateReply,
  isHealth,
  isOneLine,
  isSendMail,
  isToken,
  json,
  leakedSecrets,
  mail,
  original,
  rejected,
  replyMail,
} from "./graph-fake.js"
import { unhandledRejections, virtualClock } from "./virtual-clock.js"

// Review follow-ups to #17–#19: every failure of a Graph or token request is
// a GraphRequestError (a bad 2xx body included); a secret split across a
// line break is redacted before the message is joined into one line; error
// codes from a body are shown only when code-shaped; and health() blames
// the network, not the credentials, when the request could not connect.

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

const html = () =>
  new Response("<html>Sign in</html>", {
    status: 200,
    headers: { "Content-Type": "text/html" },
  })

test.describe("a bad 2xx body is a GraphRequestError too", () => {
  for (const [name, answer] of [
    ["a non-JSON token answer", html],
    ["a token answer without access_token", () => json(200, {})],
    ["a token answer that is JSON null", () => json(200, null)],
  ] as [string, () => Answer][]) {
    test(`${name}`, async () => {
      const c = virtualClock()
      const { fetch, calls } = fakeFetch(c, (call) =>
        isToken(call) ? answer() : undefined,
      )
      const error = rejected(await c.run(driver(c, fetch).send(mail)))
      expect(error).toBeInstanceOf(GraphRequestError)
      const request = error as GraphRequestError
      expect(request.operation).toBe("token request")
      expect(request.mayHaveSent).toBe(false)
      expect(request.clientRequestId).toBe(
        clientRequestIdOf(calls.filter(isToken)[0]),
      )
      expect(calls.filter(isSendMail)).toEqual([])
    })
  }

  test("a non-JSON 2xx Graph answer (createReply)", async () => {
    const c = virtualClock()
    const { fetch, calls } = fakeFetch(c, (call) =>
      isCreateReply(call) ? html() : undefined,
    )
    const error = rejected(
      await c.run(driver(c, fetch).reply(original, replyMail)),
    )
    expect(error).toBeInstanceOf(GraphRequestError)
    const request = error as GraphRequestError
    expect(request.operation).toBe(
      `POST ${MAILBOX_PATH}/messages/AAMk-1%3D/createReply`,
    )
    expect(request.mayHaveSent).toBe(false)
    expect(request.clientRequestId).toBe(
      clientRequestIdOf(calls.filter(isCreateReply)[0]),
    )
    expect(request.message).toBe(
      `Graph POST ${MAILBOX_PATH}/messages/AAMk-1%3D/createReply returned a non-JSON 200 body (text/html)`,
    )
  })
})

test.describe("redaction before the message is joined into one line", () => {
  test("a secret split across a line break is never reassembled", async () => {
    // SECRET holds a space; an echo that breaks the line there must not be
    // joined back into the secret by the one-line rule.
    const [head, tail] = [SECRET.slice(0, 12), SECRET.slice(13)]
    expect(`${head} ${tail}`).toBe(SECRET)
    for (const echo of [`${head}\n${tail}`, `${head}\r\n${tail}`]) {
      const c = virtualClock()
      const { fetch } = fakeFetch(c, (call) =>
        isSendMail(call)
          ? new TypeError(`fetch failed near ${echo}`)
          : undefined,
      )
      const error = rejected(await c.run(driver(c, fetch).send(mail)))
      expect(isOneLine(error.message)).toBe(true)
      expect(leakedSecrets(error)).toEqual([])
      expect(error.message).toContain("fetch failed near [redacted]")
    }
  })
})

test.describe("error codes from a body are shown only when code-shaped", () => {
  for (const [name, body, expected] of [
    [
      "a Graph code with spaces and markup",
      { error: { code: "Bad Code <b>", message: "m" } },
      "HTTP 400 UnknownError: m",
    ],
    [
      "a Graph code longer than 64 characters",
      { error: { code: "X".repeat(65) } },
      "HTTP 400 UnknownError",
    ],
    [
      "an Entra error that is not code-shaped",
      { error: "not a code!", error_description: "AADSTS1: d" },
      "HTTP 400 UnknownError: AADSTS1: d",
    ],
  ] as [string, unknown, string][]) {
    test(name, async () => {
      const c = virtualClock()
      const { fetch } = fakeFetch(c, (call) =>
        isHealth(call) ? json(400, body) : undefined,
      )
      const error = rejected(await c.run(driver(c, fetch).health()))
      const cause = error.cause as GraphHttpError
      expect(cause.message.endsWith(expected)).toBe(true)
      expect(cause.code).toBeUndefined()
    })
  }
})

test.describe("health() and a request that could not connect", () => {
  const refused = (code: string, syscall: string) => () =>
    new TypeError("fetch failed", {
      cause: Object.assign(new Error(`${syscall} ${code}`), { code, syscall }),
    })
  for (const [name, failing, failure] of [
    [
      "the token request: ECONNREFUSED",
      isToken,
      refused("ECONNREFUSED", "connect"),
    ],
    [
      "the token request: ENOTFOUND",
      isToken,
      refused("ENOTFOUND", "getaddrinfo"),
    ],
    ["the read: ECONNREFUSED", isHealth, refused("ECONNREFUSED", "connect")],
  ] as [
    string,
    (call: Parameters<typeof isToken>[0]) => boolean,
    () => Answer,
  ][]) {
    test(`${name} points at the network, not the credentials`, async () => {
      const c = virtualClock()
      const { fetch } = fakeFetch(c, (call) =>
        failing(call) ? failure() : undefined,
      )
      const error = rejected(await c.run(driver(c, fetch).health()))
      expect(error.message).not.toContain(DEFAULT_GRAPH_DRIVER_COPY.healthHint)
      expect(error.message).toContain("not a credentials one")
      expect(error.message).toContain("login.microsoftonline.com")
    })
  }

  test("a reset after connecting keeps the credentials hint", async () => {
    const c = virtualClock()
    const { fetch } = fakeFetch(c, (call) =>
      isHealth(call) ? refused("ECONNRESET", "read")() : undefined,
    )
    const error = rejected(await c.run(driver(c, fetch).health()))
    expect(error.message).toContain(DEFAULT_GRAPH_DRIVER_COPY.healthHint)
  })
})
