// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "@playwright/test"

import { TimeoutError } from "../src/core/index.js"
import type { MailMessage } from "../src/mail/index.js"
import {
  HttpSeamMailDriver,
  type SeamHttp,
  type SeamResponse,
  seamDeliveryToMailMessage,
  seamHttpFromFetch,
} from "../src/rails-inertia/index.js"

// The seam client's refusals and odd responses: what each failed seam call
// says (and that a body is only echoed when it is an object), sparse
// delivery entries, and the default HTTP client. No network: a fake seam.

const DRAIN = "/test/perform_enqueued_jobs"
const LIST = "/test/mail_deliveries"
const INBOUND = "/test/inbound_emails"

type Answer = SeamResponse | undefined
interface Call {
  method: string
  path: string
  json?: unknown
}

function seam(answer: (call: Call) => Answer) {
  const calls: Call[] = []
  const http: SeamHttp = (method, path, json) => {
    const call = { method, path, json }
    calls.push(call)
    return Promise.resolve(
      answer(call) ??
        (path === DRAIN
          ? { status: 200, body: { errors: [] } }
          : path.startsWith(LIST)
            ? { status: 200, body: { deliveries: [], cursor: 0 } }
            : { status: 201, body: {} }),
    )
  }
  return { http, calls }
}

function driver(http: SeamHttp, over: { notFoundHint?: string } = {}) {
  let t = 0
  return new HttpSeamMailDriver({
    http,
    defaultTimeoutMs: 1_000,
    now: () => t,
    sleep: (ms) => {
      t += ms
      return Promise.resolve()
    },
    uuid: () => "u1",
    ...over,
  })
}

const original = (): MailMessage => ({
  id: "1",
  messageId: "<o@example.test>",
  from: "App <app@example.test>",
  to: [],
  cc: [],
  replyTo: [],
  subject: "Quote",
  text: "",
  headers: {},
  receivedAt: "",
})

test.describe("deliveries as mail", () => {
  test("an empty entry is an empty mail with the fallback id", () => {
    expect(seamDeliveryToMailMessage({}, 7)).toEqual({
      id: "7",
      messageId: "",
      from: "",
      to: [],
      cc: [],
      replyTo: [],
      subject: "",
      text: "",
      inReplyTo: undefined,
      references: undefined,
      headers: {},
      receivedAt: "",
    })
  })

  test("message ids gain angle brackets once; a From header without an address is ignored", () => {
    const m = seamDeliveryToMailMessage(
      {
        index: 0,
        messageId: "a@x.test",
        inReplyTo: "b@x.test",
        references: ["c@x.test", "<d@x.test>"],
        from: ["plain@x.test"],
        headers: { From: "no address here" },
      },
      9,
    )
    expect(m).toMatchObject({
      id: "0",
      messageId: "<a@x.test>",
      inReplyTo: "<b@x.test>",
      references: ["<c@x.test>", "<d@x.test>"],
      from: "plain@x.test",
    })
    expect(
      seamDeliveryToMailMessage({ messageId: "<a@x.test>" }, 0).messageId,
    ).toBe("<a@x.test>")
  })
})

test.describe("failures say which seam call failed", () => {
  test("health: the list, then the drain", async () => {
    const hint = " (404: is the development server running"
    const missing = seam((c) =>
      c.path === LIST ? { status: 404, body: null } : undefined,
    )
    await expect(driver(missing.http).health()).rejects.toThrow(
      `Mail seam health check failed: GET ${LIST} returned HTTP 404${hint}`,
    )
    const custom = seam((c) =>
      c.path === LIST ? { status: 404, body: { error: "gone" } } : undefined,
    )
    await expect(
      driver(custom.http, { notFoundHint: " (start the app)" }).health(),
    ).rejects.toThrow(
      `GET ${LIST} returned HTTP 404 (start the app) {"error":"gone"}`,
    )
    const html = seam((c) =>
      c.path === LIST
        ? { status: 502, body: "<html>bad gateway</html>" }
        : undefined,
    )
    await expect(driver(html.http).health()).rejects.toThrow(
      `GET ${LIST} returned HTTP 502`,
    )
    const noDrain = seam((c) =>
      c.path === DRAIN ? { status: 500, body: { e: 1 } } : undefined,
    )
    await expect(driver(noDrain.http).health()).rejects.toThrow(
      `Mail seam health check failed: POST ${DRAIN} returned HTTP 500 {"e":1}`,
    )
    // The drain is only asked once the list answered.
    expect(noDrain.calls.map((c) => c.path)).toEqual([LIST, DRAIN])
  })

  test("a send carries its headers and attachments; nothing else is added", async () => {
    const { http, calls } = seam(() => undefined)
    await driver(http).send({
      to: "a@x.test",
      from: "b@x.test",
      subject: "s",
      text: "t",
      headers: { "X-A": "1" },
      attachments: [{ filename: "a.txt", content: "x" }],
    } as never)
    const post = calls.find((c) => c.path === INBOUND)
    expect(post?.json).toMatchObject({
      mode: "support_address",
      headers: { "X-A": "1" },
      attachments: [{ filename: "a.txt", content: "x" }],
    })
    const plain = seam(() => undefined)
    await driver(plain.http).send({
      to: "a@x.test",
      from: "b@x.test",
      subject: "s",
      text: "t",
    })
    const body = plain.calls.find((c) => c.path === INBOUND)?.json as object
    expect("headers" in body).toBe(false)
    expect("attachments" in body).toBe(false)
  })

  test("a refused inbound mail (422) lists the fields it gave, or says it gave none", async () => {
    const refused = (body: unknown) =>
      seam((c) => (c.path === INBOUND ? { status: 422, body } : undefined))
    await expect(
      driver(
        refused({ mailbox: "SupportMailbox", outcome: "bounced", reason: null })
          .http,
      ).send({ to: "a@x.test", from: "b@x.test", subject: "s", text: "t" }),
    ).rejects.toThrow(
      "Mail seam send (mode=support_address) was not captured: mailbox=SupportMailbox outcome=bounced",
    )
    await expect(
      driver(refused(null).http).reply(original(), {
        from: "b@x.test",
        text: "t",
      }),
    ).rejects.toThrow("Mail seam reply (mode=raw) was not captured: no details")
  })

  test("any other inbound status is a failure naming the call", async () => {
    const { http } = seam((c) =>
      c.path === INBOUND ? { status: 500, body: null } : undefined,
    )
    await expect(
      driver(http).send({
        to: "a@x.test",
        from: "b@x.test",
        subject: "s",
        text: "t",
      }),
    ).rejects.toThrow(
      `Mail seam send failed: POST ${INBOUND} returned HTTP 500`,
    )
  })

  test("a drain that fails stops a wait; one with a null body is fine", async () => {
    const down = seam((c) =>
      c.path === DRAIN ? { status: 503, body: null } : undefined,
    )
    await expect(
      driver(down.http).waitFor({ subjectIncludes: "x", since: new Date() }),
    ).rejects.toThrow(`Job drain failed: POST ${DRAIN} returned HTTP 503`)
    const nullBody = seam((c) =>
      c.path === DRAIN ? { status: 200, body: null } : undefined,
    )
    await expect(
      driver(nullBody.http).waitFor({
        subjectIncludes: "x",
        since: new Date(),
        timeoutMs: 1,
      }),
    ).rejects.toBeInstanceOf(TimeoutError)
  })

  test("job errors from the drain reach the timeout message, with defaults for missing parts", async () => {
    const { http } = seam((c) =>
      c.path === DRAIN
        ? {
            status: 200,
            body: { errors: [{ job: "MailJob", error: "boom" }, {}] },
          }
        : undefined,
    )
    const error = await driver(http)
      .waitFor({ subjectIncludes: "x", since: new Date(), timeoutMs: 1 })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TimeoutError)
    expect((error as Error).message).toContain(
      "job errors: job: error | MailJob: boom | job: error",
    )
  })

  test("a delivery list that fails or has no body", async () => {
    const failing = seam((c) =>
      c.path.startsWith(LIST) ? { status: 500, body: null } : undefined,
    )
    await expect(
      driver(failing.http).waitFor({ subjectIncludes: "x", since: new Date() }),
    ).rejects.toThrow(
      `Reading deliveries failed: GET ${LIST} returned HTTP 500`,
    )
    const empty = seam((c) =>
      c.path.startsWith(LIST) ? { status: 200, body: null } : undefined,
    )
    await expect(
      driver(empty.http).waitFor({
        subjectIncludes: "x",
        since: new Date(),
        timeoutMs: 1,
      }),
    ).rejects.toBeInstanceOf(TimeoutError)
  })
})

test.describe("the default HTTP client", () => {
  test("uses the global fetch, with a JSON body on every POST", async () => {
    const real = globalThis.fetch
    const seen: { url: string; init: RequestInit }[] = []
    globalThis.fetch = ((url: string, init: RequestInit) => {
      seen.push({ url: String(url), init })
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }))
    }) as typeof fetch
    try {
      const http = seamHttpFromFetch("http://localhost:4101")
      expect(await http("POST", DRAIN)).toEqual({
        status: 200,
        body: { ok: true },
      })
      expect(await http("GET", LIST)).toEqual({
        status: 200,
        body: { ok: true },
      })
      expect(seen[0].url).toBe(`http://localhost:4101${DRAIN}`)
      expect(seen[0].init.body).toBe("{}")
      expect(seen[0].init.headers).toEqual({
        Accept: "application/json",
        "Content-Type": "application/json",
      })
      expect(seen[1].init.body).toBeUndefined()
      expect(seen[1].init.headers).toEqual({ Accept: "application/json" })
    } finally {
      globalThis.fetch = real
    }
  })
})
