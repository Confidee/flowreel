// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "@playwright/test"

import type { GraphMailDriver } from "../src/mail-graph/index.js"
import {
  type Answer,
  CLIENT_REQUEST_ID,
  CORRELATION_ID,
  type Call,
  MAY_HAVE_SENT,
  REQUEST_ID,
  SECRET,
  TOKEN,
  TRACE_ID,
  UUID_V4,
  clientRequestIdOf,
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

// Issue #19: the only handle Microsoft support can use to tell whether a
// send was processed is its `client-request-id`. Every Graph request and
// every token request carries a fresh random UUID there (the token request
// also asks Entra to echo it), every driver error keeps it as
// `clientRequestId`, and a send that may have been delivered names it in
// its message, so it lands in summary.md. Graph's own request-id and date,
// and Entra's trace and correlation ids, are kept when GUID-shaped. None of
// them is a secret: never redacted (the token and client secret still are).

const HEADER = CLIENT_REQUEST_ID
/** A GUID of any version. */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The id the error names: in its message, or in its `clientRequestId`. */
function namesId(error: Error, id: string): boolean {
  const field = (error as { clientRequestId?: unknown }).clientRequestId
  return error.message.includes(id) || field === id
}

/** The fields #19 adds to GraphHttpError, read loosely. */
interface ServerIds {
  clientRequestId?: string
  requestId?: string
  date?: string
  traceId?: string
  correlationId?: string
}

interface Path {
  run: (d: GraphMailDriver) => Promise<unknown>
  sending: (call: Call) => boolean
  before: (call: Call) => Answer
}

const PATHS: Record<"send" | "reply", Path> = {
  send: {
    run: (d) => d.send(mail),
    sending: isSendMail,
    before: () => undefined,
  },
  reply: {
    run: (d) => d.reply(original, replyMail),
    sending: isDraftSend,
    before: draftSteps,
  },
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

test.describe("every sending POST carries a client-request-id", () => {
  for (const [pathName, path] of Object.entries(PATHS)) {
    test(`${pathName}: a random (version 4) UUID`, async () => {
      const c = virtualClock()
      const { fetch, calls } = fakeFetch(c, path.before)
      expect((await c.run(path.run(driver(c, fetch)))).state).toBe("resolved")
      const sends = calls.filter(path.sending)
      expect(sends).toHaveLength(1)
      expect(sends[0].headers.get(HEADER)).toMatch(UUID_V4)
    })
  }

  test("a different id for every send and reply", async () => {
    const c = virtualClock()
    const { fetch, calls } = fakeFetch(c, draftSteps)
    const d = driver(c, fetch)
    for (const run of [
      () => d.send(mail),
      () => d.send(mail),
      () => d.reply(original, replyMail),
      () => d.reply(original, replyMail),
    ]) {
      expect((await c.run(run())).state).toBe("resolved")
    }
    const ids = calls
      .filter((call) => isSendMail(call) || isDraftSend(call))
      .map((call) => call.headers.get(HEADER))
    expect(ids).toHaveLength(4)
    for (const id of ids) expect(id).toMatch(UUID_V4)
    expect(new Set(ids).size).toBe(4)
  })
})

test.describe("every other request carries one too, fresh each time", () => {
  test("token, health, list, message read, createReply, PATCH and saveEml", async () => {
    const c = virtualClock()
    let lists = 0
    const { fetch, calls } = fakeFetch(c, (call) => {
      // The first list is throttled, so a re-polled read is seen too.
      if (isList(call) && ++lists === 1) {
        return json(429, { error: { code: "TooManyRequests" } })
      }
      if (isSaveEml(call)) return new Response("raw", { status: 200 })
      return mailbox(call) ?? draftSteps(call)
    })
    const d = driver(c, fetch)
    const dir = await mkdtemp(join(tmpdir(), "flowreel-request-id-"))
    try {
      for (const run of [
        () => d.health(),
        () => d.waitFor(query(60_000)),
        () => d.reply(original, replyMail),
      ] as (() => Promise<unknown>)[]) {
        expect((await c.run(run())).state).toBe("resolved")
      }
      // Real file I/O: awaited directly (its bound's timer is cleared once
      // it settles, which the afterEach checks).
      expect(await d.saveEml(original, dir)).toContain(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
    for (const [name, kind] of [
      ["token", isToken],
      ["health", isHealth],
      ["list", isList],
      ["message read", isMessageGet],
      ["createReply", isCreateReply],
      ["PATCH", isPatch],
      ["send", isDraftSend],
      ["saveEml", isSaveEml],
    ] as [string, (call: Call) => boolean][]) {
      expect(calls.filter(kind).length, name).toBeGreaterThanOrEqual(1)
    }
    expect(calls.filter(isList)).toHaveLength(2)
    const ids = calls.map(clientRequestIdOf)
    for (const id of ids) expect(id).toMatch(UUID_V4)
    expect(new Set(ids).size).toBe(calls.length)
    // Entra echoes the id only when asked.
    const token = calls.filter(isToken)
    expect(token).toHaveLength(1)
    expect(token[0].headers.get("return-client-request-id")).toBe("true")
  })
})

test.describe("a send that may have been delivered names its id", () => {
  const failures: [string, () => Answer][] = [
    ["no answer (timeout)", () => "hang"],
    [
      "a transport error (ECONNRESET)",
      () =>
        new TypeError("fetch failed", {
          cause: Object.assign(
            new Error(`read ECONNRESET ${SECRET} Bearer ${TOKEN}`),
            { code: "ECONNRESET" },
          ),
        }),
    ],
    [
      "HTTP 500",
      () =>
        json(500, {
          error: { code: "InternalServerError", message: `Bearer ${TOKEN}` },
        }),
    ],
    ["HTTP 502", () => json(502, { error: { code: "BadGateway" } })],
    ["HTTP 504", () => json(504, { error: { code: "GatewayTimeout" } })],
  ]
  for (const [pathName, path] of Object.entries(PATHS)) {
    for (const [name, failure] of failures) {
      test(`${pathName}: ${name}`, async () => {
        const c = virtualClock()
        const { fetch, calls } = fakeFetch(c, (call) =>
          path.sending(call) ? failure() : path.before(call),
        )
        const error = rejected(await c.run(path.run(driver(c, fetch))))
        const sends = calls.filter(path.sending)
        expect(sends).toHaveLength(1)
        const id = sends[0].headers.get(HEADER) ?? ""
        expect(id).toMatch(UUID_V4)
        expect(mayHaveSentOf(error)).toBe(true)
        // The id is not a secret: shown as sent, never "[redacted]".
        expect(namesId(error, id)).toBe(true)
        expect(error.message).toContain(`client-request-id ${id}`)
        expect((error as ServerIds).clientRequestId).toBe(id)
        expect(leakedSecrets(error)).toEqual([])
      })
    }
  }
})

test.describe("Graph's own ids", () => {
  const DATE = "Wed, 21 Oct 2026 10:00:00 GMT"
  const ISO = "2026-10-21T10:00:00.000Z"

  async function sendFails(answer: () => Answer) {
    const c = virtualClock()
    const { fetch, calls } = fakeFetch(c, (call) =>
      isSendMail(call) ? answer() : undefined,
    )
    const error = rejected(await c.run(driver(c, fetch).send(mail)))
    return { error, id: clientRequestIdOf(calls.filter(isSendMail)[0]) }
  }

  test("a may-have-sent reply keeps and names request-id and date", async () => {
    const { error, id } = await sendFails(() =>
      json(
        500,
        { error: { code: "InternalServerError", message: "boom" } },
        {
          "request-id": REQUEST_ID,
          "client-request-id": "ignored",
          Date: DATE,
        },
      ),
    )
    const ids = error as Error & ServerIds
    expect(ids.clientRequestId).toBe(id)
    expect(ids.requestId).toBe(REQUEST_ID)
    expect(ids.date).toBe(ISO)
    expect(ids.message).toContain(MAY_HAVE_SENT)
    expect(ids.message).toContain(`client-request-id ${id}`)
    expect(ids.message).toContain(`request-id ${REQUEST_ID}`)
    expect(ids.message).toContain(`date ${ISO}`)
  })

  test("without the header, the body's innerError request-id is kept", async () => {
    const { error } = await sendFails(() =>
      json(503, {
        error: {
          code: "ServiceUnavailable",
          message: "later",
          innerError: { "request-id": REQUEST_ID, date: "2026-10-21T10:00:00" },
        },
      }),
    )
    expect((error as ServerIds).requestId).toBe(REQUEST_ID)
    expect(error.message).toContain(`request-id ${REQUEST_ID}`)
  })

  test("the lower-case innererror spelling is read too", async () => {
    const { error } = await sendFails(() =>
      json(502, {
        error: { code: "BadGateway", innererror: { "request-id": REQUEST_ID } },
      }),
    )
    expect((error as ServerIds).requestId).toBe(REQUEST_ID)
  })

  test("an id that is not GUID-shaped, or a date that does not parse, is dropped", async () => {
    const odd = "<script>not-a-guid"
    const { error } = await sendFails(() =>
      json(
        500,
        {
          error: {
            code: "InternalServerError",
            innerError: { "request-id": `${odd}-inner` },
          },
        },
        { "request-id": odd, Date: "yesterday-ish" },
      ),
    )
    const ids = error as ServerIds
    expect(ids.requestId).toBeUndefined()
    expect(ids.date).toBeUndefined()
    expect(error.message).not.toContain("not-a-guid")
    expect(error.message).not.toContain("<script>")
    expect(error.message).not.toContain("yesterday")
    expect(error.message).not.toContain(" request-id ")
    // The driver's own id is still named.
    expect(error.message).toMatch(/client-request-id [0-9a-f-]{36}\.$/)
  })

  test("a not-sent reply keeps the ids as fields but names none in its message", async () => {
    const { error, id } = await sendFails(() =>
      json(
        403,
        { error: { code: "ErrorAccessDenied", message: "denied" } },
        { "request-id": REQUEST_ID, Date: DATE },
      ),
    )
    const ids = error as ServerIds
    expect(mayHaveSentOf(error)).toBe(false)
    expect(ids.clientRequestId).toBe(id)
    expect(ids.requestId).toBe(REQUEST_ID)
    expect(ids.date).toBe(ISO)
    expect(error.message).toBe(
      "Graph POST /users/qa%40example.com/sendMail failed: HTTP 403 ErrorAccessDenied: denied",
    )
  })
})

test.describe("Entra's ids on a token error", () => {
  async function tokenFails(body: unknown) {
    const c = virtualClock()
    const { fetch, calls } = fakeFetch(c, (call) =>
      isToken(call) ? json(401, body) : undefined,
    )
    const error = rejected(await c.run(driver(c, fetch).send(mail)))
    return { error, id: clientRequestIdOf(calls.filter(isToken)[0]) }
  }

  test("GUID-shaped trace and correlation ids are kept and named on the detail line", async () => {
    const { error, id } = await tokenFails({
      error: "invalid_client",
      error_description: `AADSTS7000215: Invalid client secret provided.\r\nTrace ID: ${TRACE_ID}`,
      trace_id: TRACE_ID,
      correlation_id: CORRELATION_ID,
    })
    const ids = error as ServerIds
    expect(ids.clientRequestId).toBe(id)
    expect(ids.traceId).toBe(TRACE_ID)
    expect(ids.correlationId).toBe(CORRELATION_ID)
    expect(error.message).toBe(
      `Graph token request failed: HTTP 401 invalid_client: AADSTS7000215: Invalid client secret provided. (trace_id ${TRACE_ID}, correlation_id ${CORRELATION_ID})`,
    )
    expect(error.message).not.toContain("client-request-id")
  })

  test("ids that are not GUID-shaped are dropped", async () => {
    const { error } = await tokenFails({
      error: "invalid_client",
      error_description: "AADSTS7000215: Invalid client secret provided.",
      trace_id: "trace <b>",
      correlation_id: CORRELATION_ID,
    })
    const ids = error as ServerIds
    expect(ids.traceId).toBeUndefined()
    expect(ids.correlationId).toMatch(GUID)
    expect(error.message).toBe(
      `Graph token request failed: HTTP 401 invalid_client: AADSTS7000215: Invalid client secret provided. (correlation_id ${CORRELATION_ID})`,
    )
  })
})
