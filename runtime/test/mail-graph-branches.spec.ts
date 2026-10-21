// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "@playwright/test"

import { SendRefusedError, TimeoutError } from "../src/core/index.js"
import type { MailMessage } from "../src/mail/index.js"
import {
  GraphHttpError,
  GraphMailDriver,
  headerAddresses,
  toMailMessage,
} from "../src/mail-graph/index.js"

// The Graph mail driver's refusals and odd responses: what is never sent,
// what is never echoed, and how sparse or malformed answers are read. All
// HTTP is a fake fetch; nothing leaves the process.

const TOKEN = "eyJ.fake-access-token.sig"
// A client secret with the characters that encoding changes (~ + / = and a
// space), so a check for it also covers its encoded forms.
const SECRET = "Abc8Q~x+y/z= END"
const MAILBOX = "qa@example.com"
const REPLY_DOMAIN = "reply.example.com"
const TOKEN_URL = "https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token"

type Responder = (url: string, init: RequestInit) => Response | undefined

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  })
}

function fakeFetch(respond: Responder = () => undefined) {
  const urls: string[] = []
  const fetch = (url: string, init: RequestInit = {}): Promise<Response> => {
    urls.push(url)
    const answer = respond(url, init)
    if (answer) return Promise.resolve(answer)
    if (url === TOKEN_URL) {
      return Promise.resolve(
        json(200, { access_token: TOKEN, expires_in: 3600 }),
      )
    }
    return Promise.resolve(new Response(null, { status: 202 }))
  }
  return { fetch, urls }
}

function clock(start = Date.parse("2026-10-13T10:00:00.000Z")) {
  let t = start
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms
      return Promise.resolve()
    },
  }
}

function driver(fetch: (u: string, i?: RequestInit) => Promise<Response>) {
  const c = clock()
  return new GraphMailDriver({
    tenantId: "tenant-1",
    clientId: "client-1",
    clientSecret: SECRET,
    mailbox: MAILBOX,
    replyDomain: REPLY_DOMAIN,
    defaultTimeoutMs: 5_000,
    fetch,
    now: c.now,
    sleep: c.sleep,
  })
}

const original = (over: Partial<MailMessage> = {}): MailMessage => ({
  id: "AAMk-orig",
  messageId: "<o@example.test>",
  from: "App <app@example.test>",
  to: [],
  cc: [],
  replyTo: ["reply+tok@reply.example.com"],
  subject: "Quote",
  text: "",
  headers: {},
  receivedAt: "2026-10-13T10:00:00Z",
  ...over,
})

test.describe("send and reply refusals", () => {
  test("extra headers or attachments are refused before any request", async () => {
    const { fetch, urls } = fakeFetch()
    const d = driver(fetch)
    const mail = {
      to: `qa+1@${REPLY_DOMAIN}`,
      from: MAILBOX,
      subject: "s",
      text: "t",
    }
    await expect(d.send({ ...mail, headers: { "X-A": "1" } })).rejects.toThrow(
      SendRefusedError,
    )
    await expect(
      d.send({
        ...mail,
        attachments: [{ filename: "a.txt", content: "x" }],
      } as never),
    ).rejects.toThrow(/extra headers or attachments/)
    expect(urls).toEqual([])
  })

  test("a recipient outside the reply domain is refused before any request", async () => {
    const { fetch, urls } = fakeFetch()
    const d = driver(fetch)
    await expect(
      d.send({
        to: "support@example.test",
        from: MAILBOX,
        subject: "s",
        text: "t",
      }),
    ).rejects.toThrow(SendRefusedError)
    // A reply to an app mail with no Reply-To would go to its From.
    await expect(
      d.reply(
        original({ replyTo: [], from: "Support <support@example.test>" }),
        {
          from: MAILBOX,
          text: "t",
        },
      ),
    ).rejects.toThrow(SendRefusedError)
    expect(urls).toEqual([])
  })

  test("a reply whose send returns no body has no message id", async () => {
    const { fetch } = fakeFetch((url, init) => {
      if (init.method === "POST" && url.endsWith("/createReply")) {
        return json(201, { id: "draft-1" })
      }
      return undefined
    })
    const result = await driver(fetch).reply(original(), {
      from: MAILBOX,
      text: "ok",
    })
    expect(result).toEqual({ messageId: "" })
  })
})

test.describe("sparse and unusual messages", () => {
  test("a bare Graph message becomes an empty mail", () => {
    expect(toMailMessage({ id: "1" })).toEqual({
      id: "1",
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

  test("the message id falls back to its header; a display name equal to the address is dropped", () => {
    const m = toMailMessage({
      id: "1",
      from: { emailAddress: { name: "a@x.test", address: "a@x.test" } },
      toRecipients: [{}, { emailAddress: { address: "" } }],
      internetMessageHeaders: [{ name: "Message-ID", value: "<h@x.test>" }],
    })
    expect(m.messageId).toBe("<h@x.test>")
    expect(m.from).toBe("a@x.test")
    expect(m.to).toEqual([])
    expect(
      toMailMessage({
        id: "1",
        from: { emailAddress: { name: "Ann", address: "a@x.test" } },
      }).from,
    ).toBe("Ann <a@x.test>")
    expect(toMailMessage({ id: "1", from: {} }).from).toBe("")
  })

  test("the recipient list unions Graph's and the raw header, once per address", () => {
    const m = toMailMessage({
      id: "1",
      toRecipients: [{ emailAddress: { address: "qa@example.com" } }],
      internetMessageHeaders: [
        {
          name: "To",
          value: '"Doe, Jane" <QA@example.com>, qa+agent@example.com',
        },
      ],
    })
    expect(m.to).toEqual(["qa@example.com", "qa+agent@example.com"])
    expect(headerAddresses(undefined)).toEqual([])
    expect(headerAddresses("")).toEqual([])
  })
})

test.describe("responses that are not what Graph promises", () => {
  const request = {
    subjectIncludes: "RQ",
    since: new Date("2026-10-13T10:00:00Z"),
  }

  test("a list with no value, an empty body, or items without a subject or time finds nothing", async () => {
    for (const body of [
      new Response("", { status: 200 }),
      json(200, {}),
      json(200, { value: [{ id: "x" }] }),
      json(200, { value: [{ id: "y", subject: "RQ-1" }] }),
    ]) {
      const { fetch } = fakeFetch((url) =>
        url.includes("/messages?") ? body.clone() : undefined,
      )
      const error = await driver(fetch)
        .waitFor({ ...request, timeoutMs: 10 })
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(TimeoutError)
    }
  })

  test("the query's own timeout wins over the driver's", async () => {
    const { fetch } = fakeFetch((url) =>
      url.includes("/messages?") ? json(200, { value: [] }) : undefined,
    )
    const error = await driver(fetch)
      .waitFor({ ...request, timeoutMs: 1 })
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ name: "TimeoutError" })
    expect(String((error as Error).message)).toContain("1")
  })

  test("a token reply that is not JSON names its status and type, never the body", async () => {
    const html = new Response("<html>login</html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    })
    const { fetch } = fakeFetch((url) => (url === TOKEN_URL ? html : undefined))
    await expect(driver(fetch).health()).rejects.toThrow(
      /non-JSON 200 body \(text\/html\)/,
    )
    const bare = new Response("nope", { status: 200 })
    bare.headers.delete("content-type")
    const g = fakeFetch((url) => (url === TOKEN_URL ? bare : undefined))
    const error = await driver(g.fetch)
      .health()
      .catch((e: unknown) => e as Error)
    expect(String((error as Error).cause)).toContain("(unknown type)")
    expect((error as Error).message).not.toContain("nope")
  })

  test("a token reply without an access token is a failure; no expiry means no caching", async () => {
    const none = fakeFetch((url) =>
      url === TOKEN_URL ? json(200, {}) : undefined,
    )
    await expect(driver(none.fetch).health()).rejects.toThrow(
      /no access_token returned/,
    )
    let tokenRequests = 0
    const short = fakeFetch((url) => {
      if (url !== TOKEN_URL) return undefined
      tokenRequests += 1
      return json(200, { access_token: TOKEN })
    })
    const d = driver(short.fetch)
    await d.health()
    await d.health()
    expect(tokenRequests).toBe(2)
  })

  test("a Graph reply that is not JSON names the call, never the body", async () => {
    const page = new Response("<html>secret " + SECRET + "</html>", {
      status: 200,
    })
    page.headers.delete("content-type")
    const { fetch } = fakeFetch((url) =>
      url.includes("/messages?") ? page : undefined,
    )
    const error = (await driver(fetch)
      .health()
      .catch((e: unknown) => e)) as Error
    expect(error.message).toContain(
      "returned a non-JSON 200 body (unknown type)",
    )
    expect(error.message).not.toContain(SECRET)
    expect(error.message).not.toContain("html")
  })
})

test.describe("errors never carry secrets", () => {
  test("a transport failure that is not an Error is still redacted", async () => {
    const { fetch } = fakeFetch((url) => {
      if (url.includes("/messages?")) {
        throw `socket closed near ${SECRET} Bearer ${TOKEN}`
      }
      return undefined
    })
    const error = (await driver(fetch)
      .health()
      .catch((e: unknown) => e)) as Error
    expect(error.message).toContain("[redacted]")
    expect(error.message).not.toContain(SECRET)
    expect(error.message).not.toContain(TOKEN)
  })

  test("a failing reply whose body cannot be read reports only the status", async () => {
    const broken = {
      ok: false,
      status: 500,
      headers: new Headers(),
      text: () => Promise.reject(new Error("stream reset")),
    } as unknown as Response
    const { fetch } = fakeFetch((url) =>
      url.includes("/messages?") ? broken : undefined,
    )
    const error = (await driver(fetch)
      .health()
      .catch((e: unknown) => e)) as Error
    expect((error.cause as GraphHttpError).message).toBe(
      "Graph GET /users/qa%40example.com/messages failed: HTTP 500",
    )
  })

  test("error bodies: no code, a message, an AAD description, and plain text", async () => {
    const cases: [Response, string][] = [
      [json(400, { error: { message: "bad" } }), "HTTP 400 UnknownError: bad"],
      [json(400, { error: { code: "Boom" } }), "HTTP 400 Boom"],
      [
        json(401, {
          error: "invalid_client",
          error_description: "AADSTS7000215: bad\r\nTrace",
        }),
        "HTTP 401 invalid_client: AADSTS7000215: bad",
      ],
      [json(401, { error: "invalid_client" }), "HTTP 401 invalid_client"],
      [json(502, { other: 1 }), "HTTP 502"],
      [new Response("<html>gateway</html>", { status: 502 }), "HTTP 502"],
    ]
    for (const [response, expected] of cases) {
      const { fetch } = fakeFetch((url) =>
        url.includes("/messages?") ? response : undefined,
      )
      const error = (await driver(fetch)
        .health()
        .catch((e: unknown) => e)) as Error
      const cause = error.cause as GraphHttpError
      expect(cause.message.endsWith(expected)).toBe(true)
      expect(cause.message).not.toContain("gateway")
    }
  })

  test("Retry-After as seconds, as a date, and as garbage", async () => {
    const retry = async (value: string) => {
      const { fetch } = fakeFetch((url) =>
        url.includes("/messages?")
          ? json(429, {}, { "Retry-After": value })
          : undefined,
      )
      const error = (await driver(fetch)
        .health()
        .catch((e: unknown) => e)) as Error
      return (error.cause as GraphHttpError).retryAfterMs
    }
    expect(await retry("2")).toBe(2000)
    expect(await retry("-5")).toBe(0)
    // The fake clock stands at 2026-10-13T10:00:00Z.
    expect(await retry("Tue, 13 Oct 2026 10:00:07 GMT")).toBe(7000)
    expect(await retry("Mon, 12 Oct 2026 10:00:00 GMT")).toBe(0)
    expect(await retry("soon")).toBeUndefined()
  })
})

test.describe("defaults", () => {
  test("without injected fetch, clock or sleep the driver uses the real ones", async () => {
    const realFetch = globalThis.fetch
    const seen: string[] = []
    let throttled = false
    globalThis.fetch = ((url: string) => {
      seen.push(String(url))
      if (String(url) === TOKEN_URL) {
        return Promise.resolve(
          json(200, { access_token: TOKEN, expires_in: 3600 }),
        )
      }
      if (!throttled) {
        throttled = true
        return Promise.resolve(json(429, {}, { "Retry-After": "0.01" }))
      }
      return Promise.resolve(json(200, { value: [] }))
    }) as typeof fetch
    try {
      const d = new GraphMailDriver({
        tenantId: "tenant-1",
        clientId: "client-1",
        clientSecret: SECRET,
        mailbox: MAILBOX,
        replyDomain: REPLY_DOMAIN,
        // Longer than poll's first 1 s back-off: no read is started once the
        // wait has no time left, so the re-poll must fall before the deadline.
        defaultTimeoutMs: 1_500,
      })
      const error = await d
        .waitFor({ subjectIncludes: "RQ", since: new Date() })
        .catch((e: unknown) => e)
      // The throttled read was waited out (real sleep) and re-polled.
      expect(error).toBeInstanceOf(TimeoutError)
      expect(
        seen.filter((u) => u.includes("/messages?")).length,
      ).toBeGreaterThanOrEqual(2)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test("saved mail files are numbered and named after a slug of the subject", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flowreel-eml-"))
    try {
      const { fetch } = fakeFetch((url) =>
        url.endsWith("/$value") ? new Response("raw mail") : undefined,
      )
      const d = driver(fetch)
      const first = await d.saveEml(original({ subject: "!!! ???" }), dir)
      const second = await d.saveEml(
        original({ subject: "Quote: RQ-4 ready" }),
        dir,
      )
      expect(await readdir(dir)).toEqual(
        ["01-message.eml", "02-quote-rq-4-ready.eml"].sort(),
      )
      expect(first).toBe(join(dir, "01-message.eml"))
      expect(second).toBe(join(dir, "02-quote-rq-4-ready.eml"))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
