// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "@playwright/test"
import type { APIRequest } from "@playwright/test"

import { LoginError, TimeoutError } from "../src/core/index.js"
import type { MailMessage } from "../src/mail/index.js"
import {
  DEFAULT_SEAM_PATHS,
  HttpSeamMailDriver,
  type SeamHttp,
  type SeamResponse,
  seamHttpFromFetch,
  seamHttpFromRequest,
  seamSignIn,
} from "../src/rails-inertia/index.js"

// The test-seam protocol client (rails-inertia): the HTTP seam mail driver
// against a fake server, and the sign-in seam over a fake request API. The
// sandbox below stands in for an app's development mail interceptor, which
// rewrites a recipient outside its own domain to one catch-all address.

const SANDBOX = "test@example.com"

function sandboxAllowed(address: string): boolean {
  const domain = (address.split("@").pop() ?? "").toLowerCase()
  return domain === "example.com" || domain.endsWith(".example.com")
}

interface Call {
  method: string
  path: string
  json?: unknown
}

type Handler = (call: Call) => SeamResponse | undefined

/** Records every call; `handler` answers, else drain/deliveries defaults. */
function fakeHttp(handler: Handler = () => undefined) {
  const calls: Call[] = []
  const respond = (
    method: "GET" | "POST",
    path: string,
    json?: unknown,
  ): SeamResponse => {
    const call = { method, path, json }
    calls.push(call)
    const canned = handler(call)
    if (canned) return canned
    if (path === "/test/perform_enqueued_jobs") {
      return { status: 200, body: { performed: 0, discarded: 0, errors: [] } }
    }
    if (path.startsWith("/test/mail_deliveries")) {
      return { status: 200, body: { deliveries: [], cursor: 0 } }
    }
    if (path === "/test/inbound_emails") {
      return { status: 201, body: { mailbox: "SupportMailbox" } }
    }
    return { status: 500, body: null }
  }
  const http: SeamHttp = (method, path, json) =>
    Promise.resolve(respond(method, path, json))
  return { http, calls }
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

function driver(http: SeamHttp, timeoutMs = 10_000) {
  const c = clock()
  let n = 0
  return new HttpSeamMailDriver({
    http,
    defaultTimeoutMs: timeoutMs,
    now: c.now,
    sleep: c.sleep,
    uuid: () => `uuid-${++n}`,
    messageId: (uuid) => `<qa-${uuid}@qa.example.com>`,
    alternateRecipients: (to) => (sandboxAllowed(to) ? [] : [SANDBOX]),
  })
}

const since = new Date("2026-10-13T10:00:00.000Z")

function delivery(index: number, overrides: Record<string, unknown> = {}) {
  return {
    index,
    messageId: `m${index}@example.test`,
    from: ["rfq@example.test"],
    to: ["qa-customer-1@qa.example.com"],
    cc: [],
    replyTo: ["reply+tok@reply.example.test"],
    subject: `[RQ-${index}] Re: [QA loc-run] Quote`,
    text: "Reference loc-run.",
    inReplyTo: null,
    references: [],
    headers: { From: "Agent via Example <rfq@example.test>" },
    deliveredAt: "2026-10-13T10:00:01.000Z",
    ...overrides,
  }
}

test.describe("HttpSeamMailDriver.send", () => {
  test("posts support_address mode with a generated Message-ID, then drains", async () => {
    const { http, calls } = fakeHttp()
    const result = await driver(http).send({
      from: "qa-customer-1@qa.example.com",
      to: "rfq@example.test",
      subject: "[QA loc-run] Quote",
      text: "Hello loc-run",
    })
    expect(result.messageId).toBe("<qa-uuid-1@qa.example.com>")
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/test/inbound_emails",
        json: {
          mode: "support_address",
          to: "rfq@example.test",
          from: "qa-customer-1@qa.example.com",
          subject: "[QA loc-run] Quote",
          body: "Hello loc-run",
          message_id: "<qa-uuid-1@qa.example.com>",
        },
      },
      { method: "POST", path: "/test/perform_enqueued_jobs", json: undefined },
    ])
  })

  test("422 throws with the seam's outcome and reason, without draining", async () => {
    const { http, calls } = fakeHttp(({ path }) =>
      path === "/test/inbound_emails"
        ? { status: 422, body: { outcome: "dropped", reason: "loop_guard" } }
        : undefined,
    )
    await expect(
      driver(http).send({ from: "a@x", to: "b@x", subject: "s", text: "t" }),
    ).rejects.toThrow(/not captured: outcome=dropped reason=loop_guard/)
    expect(calls).toHaveLength(1)
  })

  test("404 names the gate that is probably off", async () => {
    const { http } = fakeHttp(() => ({ status: 404, body: null }))
    await expect(
      driver(http).send({ from: "a@x", to: "b@x", subject: "s", text: "t" }),
    ).rejects.toThrow(/test seams enabled/)
  })
})

test.describe("HttpSeamMailDriver.reply", () => {
  const original: MailMessage = {
    id: "3",
    messageId: "<m3@example.test>",
    from: "Agent via Example <rfq@example.test>",
    to: ["qa-customer-1@qa.example.com"],
    cc: [],
    replyTo: ["reply+tok@reply.example.test"],
    subject: "[RQ-3] Quote",
    text: "",
    references: ["<root@qa.example.com>"],
    headers: {},
    receivedAt: since.toISOString(),
  }

  test("posts raw mode to Reply-To with threading headers, then drains", async () => {
    const { http, calls } = fakeHttp()
    const result = await driver(http).reply(original, {
      from: "qa-customer-1@qa.example.com",
      text: "Any update? loc-run",
    })
    expect(result.messageId).toBe("<qa-uuid-1@qa.example.com>")
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/test/inbound_emails",
      json: {
        mode: "raw",
        to: "reply+tok@reply.example.test",
        from: "qa-customer-1@qa.example.com",
        subject: "Re: [RQ-3] Quote",
        body: "Any update? loc-run",
        message_id: "<qa-uuid-1@qa.example.com>",
        in_reply_to: "<m3@example.test>",
        references: ["<root@qa.example.com>", "<m3@example.test>"],
      },
    })
    expect(calls[1].path).toBe("/test/perform_enqueued_jobs")
  })

  test("falls back to the bare From address without a Reply-To", async () => {
    const { http, calls } = fakeHttp()
    await driver(http).reply(
      { ...original, replyTo: [], references: undefined },
      { from: "qa-customer-1@qa.example.com", text: "x" },
    )
    const json = calls[0].json as Record<string, unknown>
    expect(json.to).toBe("rfq@example.test")
    expect(json.references).toEqual(["<m3@example.test>"])
  })

  test("422 on raw mode reports mailbox and status", async () => {
    const { http } = fakeHttp(({ path }) =>
      path === "/test/inbound_emails"
        ? {
            status: 422,
            body: { mailbox: "EmailRepliesMailbox", status: "bounced" },
          }
        : undefined,
    )
    await expect(
      driver(http).reply(original, { from: "a@x", text: "t" }),
    ).rejects.toThrow(/mode=raw.*mailbox=EmailRepliesMailbox status=bounced/)
  })
})

test.describe("HttpSeamMailDriver.waitFor", () => {
  test("drains before every poll and keeps the cursor between reads", async () => {
    let reads = 0
    const { http, calls } = fakeHttp(({ path }) => {
      if (!path.startsWith("/test/mail_deliveries")) return undefined
      reads += 1
      if (reads === 1) {
        return { status: 200, body: { deliveries: [delivery(0)], cursor: 0 } }
      }
      if (reads === 2)
        return { status: 200, body: { deliveries: [], cursor: 0 } }
      return { status: 200, body: { deliveries: [delivery(1)], cursor: 1 } }
    })
    const message = await driver(http).waitFor({
      to: "qa-customer-1@qa.example.com",
      subjectIncludes: "RQ-1",
      since,
    })
    expect(message.subject).toContain("RQ-1")
    expect(message.messageId).toBe("<m1@example.test>")
    expect(message.from).toBe("Agent via Example <rfq@example.test>")
    expect(message.headers.from).toBe("Agent via Example <rfq@example.test>")
    expect(message.sandboxed).toBeUndefined()
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /test/perform_enqueued_jobs",
      "GET /test/mail_deliveries",
      "POST /test/perform_enqueued_jobs",
      "GET /test/mail_deliveries?after=0",
      "POST /test/perform_enqueued_jobs",
      "GET /test/mail_deliveries?after=0",
    ])
  })

  test("matches earlier-buffered deliveries on a later wait", async () => {
    const { http, calls } = fakeHttp(({ path }) => {
      if (path === "/test/mail_deliveries") {
        return {
          status: 200,
          body: { deliveries: [delivery(0), delivery(1)], cursor: 1 },
        }
      }
      if (path === "/test/mail_deliveries?after=1") {
        return { status: 200, body: { deliveries: [], cursor: 1 } }
      }
      return undefined
    })
    const d = driver(http)
    await d.waitFor({ subjectIncludes: "RQ-0", since })
    const second = await d.waitFor({ subjectIncludes: "RQ-1", since })
    expect(second.id).toBe("1")
    expect(calls.filter((c) => c.method === "GET").map((c) => c.path)).toEqual([
      "/test/mail_deliveries",
      "/test/mail_deliveries?after=1",
    ])
  })

  test("a shrinking cursor (cleared deliveries) restarts from the beginning", async () => {
    let reads = 0
    const { http, calls } = fakeHttp(({ path }) => {
      if (!path.startsWith("/test/mail_deliveries")) return undefined
      reads += 1
      if (reads === 1) {
        return {
          status: 200,
          body: { deliveries: [delivery(0), delivery(1)], cursor: 1 },
        }
      }
      if (reads === 2)
        return { status: 200, body: { deliveries: [], cursor: -1 } }
      return {
        status: 200,
        body: {
          deliveries: [delivery(0, { subject: "[RQ-9] fresh" })],
          cursor: 0,
        },
      }
    })
    const d = driver(http)
    await d.waitFor({ subjectIncludes: "RQ-0", since })
    const fresh = await d.waitFor({ subjectIncludes: "RQ-9", since })
    expect(fresh.subject).toBe("[RQ-9] fresh")
    expect(calls.filter((c) => c.method === "GET").map((c) => c.path)).toEqual([
      "/test/mail_deliveries",
      "/test/mail_deliveries?after=1",
      "/test/mail_deliveries",
    ])
  })

  test("a non-example.com recipient also matches the sandbox address", async () => {
    const { http } = fakeHttp(({ path }) =>
      path === "/test/mail_deliveries"
        ? {
            status: 200,
            body: {
              deliveries: [delivery(0, { to: ["test@example.com"] })],
              cursor: 0,
            },
          }
        : undefined,
    )
    const message = await driver(http).waitFor({
      to: "Admin@example.test",
      subjectIncludes: "RQ-0",
      since,
    })
    expect(message.sandboxed).toBe(true)
  })

  test("an allowed recipient (qa.example.com) never matches the sandbox address", async () => {
    const { http } = fakeHttp(({ path }) =>
      path.startsWith("/test/mail_deliveries")
        ? {
            status: 200,
            body: {
              deliveries: [delivery(0, { to: ["test@example.com"] })],
              cursor: 0,
            },
          }
        : undefined,
    )
    await expect(
      driver(http, 3000).waitFor({
        to: "qa-customer-1@qa.example.com",
        since,
      }),
    ).rejects.toBeInstanceOf(TimeoutError)
  })

  test("a same-second delivery is not dropped by the since guard", async () => {
    const { http } = fakeHttp(({ path }) =>
      path === "/test/mail_deliveries"
        ? {
            status: 200,
            body: {
              deliveries: [
                delivery(0, { deliveredAt: "2026-10-13T10:00:00.000Z" }),
              ],
              cursor: 0,
            },
          }
        : undefined,
    )
    const message = await driver(http).waitFor({
      subjectIncludes: "RQ-0",
      since: new Date("2026-10-13T10:00:00.700Z"),
    })
    expect(message.id).toBe("0")
  })

  test("timeout names the query and surfaces drained job errors", async () => {
    const { http } = fakeHttp(({ path }) =>
      path === "/test/perform_enqueued_jobs"
        ? {
            status: 200,
            body: {
              performed: 1,
              discarded: 0,
              errors: [{ job: "NotifyJob", error: "boom" }],
            },
          }
        : undefined,
    )
    const error = await driver(http, 3000)
      .waitFor({
        to: "qa-customer-1@qa.example.com",
        subjectIncludes: "RQ-5",
        since,
      })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TimeoutError)
    expect((error as Error).message).toContain(
      'mail to=qa-customer-1@qa.example.com subject~"RQ-5"',
    )
    expect((error as Error).message).toContain("NotifyJob: boom")
  })

  test("a failing drain is a real failure, not a 'not yet'", async () => {
    const { http } = fakeHttp(({ path }) =>
      path === "/test/perform_enqueued_jobs"
        ? { status: 404, body: null }
        : undefined,
    )
    await expect(driver(http).waitFor({ since })).rejects.toThrow(
      /Job drain failed: POST \/test\/perform_enqueued_jobs returned HTTP 404/,
    )
  })
})

test.describe("HttpSeamMailDriver.health", () => {
  test("checks the deliveries seam and the job drain", async () => {
    const { http, calls } = fakeHttp()
    await driver(http).health()
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /test/mail_deliveries",
      "POST /test/perform_enqueued_jobs",
    ])
  })

  test("throws an actionable message when a seam is missing", async () => {
    const { http } = fakeHttp(() => ({ status: 404, body: null }))
    await expect(driver(http).health()).rejects.toThrow(
      /health check failed: GET \/test\/mail_deliveries returned HTTP 404 .*seam flag set/,
    )
  })
})

interface FetchCall {
  url: string
  method: string
  headers: Record<string, string>
  body: string | undefined
}

function recordingFetch(answer: (url: string) => Response) {
  const calls: FetchCall[] = []
  const fetch = (input: string, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: input,
      method: init?.method ?? "GET",
      headers: { ...(init?.headers as Record<string, string>) },
      body: init?.body as string | undefined,
    })
    return Promise.resolve(answer(input))
  }
  return { fetch, calls }
}

const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })

test.describe("seamHttpFromFetch", () => {
  test("joins the path onto baseURL; a JSON body on every POST", async () => {
    const { fetch, calls } = recordingFetch(() => okJson({ ok: true }))
    const http = seamHttpFromFetch("http://localhost:3101", fetch)

    const get = await http("GET", "/test/mail_deliveries?after=3")
    expect(get).toEqual({ status: 200, body: { ok: true } })
    expect(calls[0]).toEqual({
      url: "http://localhost:3101/test/mail_deliveries?after=3",
      method: "GET",
      headers: { Accept: "application/json" },
      body: undefined,
    })

    await http("POST", "/test/inbound_emails", { mode: "raw", to: "a@x" })
    expect(calls[1]).toEqual({
      url: "http://localhost:3101/test/inbound_emails",
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: '{"mode":"raw","to":"a@x"}',
    })

    // A POST with no fields still sends a JSON body: the Rails kit's gate
    // refuses any other POST (a cross-site form or no-body post).
    await http("POST", "/test/perform_enqueued_jobs")
    expect(calls[2]).toEqual({
      url: "http://localhost:3101/test/perform_enqueued_jobs",
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: "{}",
    })
  })

  test("returns a non-JSON body as text and an empty body as null", async () => {
    let body = "<html>Not Found</html>"
    const { fetch } = recordingFetch(
      () => new Response(body === "" ? null : body, { status: 404 }),
    )
    const http = seamHttpFromFetch("http://localhost:3101", fetch)
    expect(await http("GET", "/test/mail_deliveries")).toEqual({
      status: 404,
      body: "<html>Not Found</html>",
    })
    body = ""
    expect(await http("POST", "/test/perform_enqueued_jobs")).toEqual({
      status: 404,
      body: null,
    })
  })
})

test.describe("HttpSeamMailDriver defaults and options", () => {
  test("a neutral Message-ID, no alternates and the generic 404 hint by default", async () => {
    const { http, calls } = fakeHttp(({ path }) =>
      path.startsWith("/test/mail_deliveries")
        ? {
            status: 200,
            body: {
              deliveries: [delivery(0, { to: ["test@example.com"] })],
              cursor: 0,
            },
          }
        : undefined,
    )
    const c = clock()
    const plain = new HttpSeamMailDriver({
      http,
      defaultTimeoutMs: 3000,
      now: c.now,
      sleep: c.sleep,
      uuid: () => "u-1",
    })
    const sent = await plain.send({
      from: "a@x",
      to: "b@x",
      subject: "s",
      text: "t",
    })
    expect(sent.messageId).toBe("<flowreel-u-1@flowreel.invalid>")
    expect((calls[0].json as Record<string, unknown>).message_id).toBe(
      "<flowreel-u-1@flowreel.invalid>",
    )
    // Without alternateRecipients a sandbox delivery never matches.
    await expect(
      plain.waitFor({ to: "admin@example.test", since }),
    ).rejects.toBeInstanceOf(TimeoutError)

    const { http: missing } = fakeHttp(() => ({ status: 404, body: null }))
    await expect(
      new HttpSeamMailDriver({ http: missing, defaultTimeoutMs: 1 }).health(),
    ).rejects.toThrow(
      "Mail seam health check failed: GET /test/mail_deliveries returned HTTP 404 (404: is the development server running with the test seams enabled: a local Rails environment and the seam flag set?)",
    )
  })

  test("custom seam paths and a custom 404 hint", async () => {
    const calls: string[] = []
    const http: SeamHttp = (method, path) => {
      calls.push(`${method} ${path}`)
      if (path === "/qa/jobs") {
        return Promise.resolve({ status: 200, body: { errors: [] } })
      }
      if (path.startsWith("/qa/mail")) {
        return Promise.resolve({
          status: 200,
          body: { deliveries: [delivery(1)], cursor: 1 },
        })
      }
      return Promise.resolve({ status: 404, body: null })
    }
    const custom = new HttpSeamMailDriver({
      http,
      defaultTimeoutMs: 1000,
      paths: {
        mailDeliveries: "/qa/mail",
        performEnqueuedJobs: "/qa/jobs",
        inboundEmails: "/qa/inbound",
      },
      notFoundHint: " (start the server with QA seams)",
    })
    await custom.health()
    await custom.waitFor({ subjectIncludes: "RQ-1", since })
    await expect(
      custom.send({ from: "a@x", to: "b@x", subject: "s", text: "t" }),
    ).rejects.toThrow(
      "Mail seam send failed: POST /qa/inbound returned HTTP 404 (start the server with QA seams)",
    )
    expect(calls).toEqual([
      "GET /qa/mail",
      "POST /qa/jobs",
      "POST /qa/jobs",
      "GET /qa/mail",
      "POST /qa/inbound",
    ])
    expect(DEFAULT_SEAM_PATHS).toEqual({
      signIn: "/test/sign_in_as",
      mailDeliveries: "/test/mail_deliveries",
      performEnqueuedJobs: "/test/perform_enqueued_jobs",
      inboundEmails: "/test/inbound_emails",
    })
  })
})

test.describe("seamHttpFromRequest", () => {
  test("sends method and JSON through the request context; parses the body", async () => {
    type Init = {
      method?: string
      data?: unknown
      headers?: Record<string, string>
      timeout?: number
    }
    const seen: ({ path: string } & Init)[] = []
    let text = '{"cursor":0}'
    const request = {
      fetch: (path: string, init: Init) => {
        seen.push({ path, ...init })
        return Promise.resolve({
          status: () => 200,
          text: () => Promise.resolve(text),
        })
      },
    }
    const http = seamHttpFromRequest(request as never)
    expect(await http("POST", "/test/inbound_emails", { mode: "raw" })).toEqual(
      { status: 200, body: { cursor: 0 } },
    )
    text = ""
    expect(await http("GET", "/test/mail_deliveries")).toEqual({
      status: 200,
      body: null,
    })
    await http("POST", "/test/perform_enqueued_jobs")
    const json = { "Content-Type": "application/json" }
    // #20: every call also carries Playwright's per-call timeout (30 s default).
    const timeout = 30_000
    expect(seen).toEqual([
      {
        path: "/test/inbound_emails",
        method: "POST",
        data: { mode: "raw" },
        headers: json,
        timeout,
      },
      { path: "/test/mail_deliveries", method: "GET", timeout },
      // A POST with no fields still sends a JSON body (the kit's gate).
      {
        path: "/test/perform_enqueued_jobs",
        method: "POST",
        data: {},
        headers: json,
        timeout,
      },
    ])
  })
})

/** A fake APIRequest whose one context answers the sign-in POST. */
function fakeApi(status: number) {
  const log: string[] = []
  const api = {
    newContext: (options: { baseURL?: string }) => {
      log.push(`newContext ${options.baseURL}`)
      return Promise.resolve({
        post: (path: string, init: { data?: unknown }) => {
          log.push(`POST ${path} ${JSON.stringify(init.data)}`)
          return Promise.resolve({ status: () => status })
        },
        storageState: () => {
          log.push("storageState")
          return Promise.resolve({ cookies: [], origins: [] })
        },
        dispose: () => {
          log.push("dispose")
          return Promise.resolve()
        },
      })
    },
  }
  return { api: api as unknown as APIRequest, log }
}

test.describe("seamSignIn", () => {
  test("posts the body to the sign-in seam and returns the storageState", async () => {
    const { api, log } = fakeApi(204)
    const state = await seamSignIn(api, "http://127.0.0.1:3000", {
      body: { email: "agent@example.test" },
    })
    expect(state).toEqual({ cookies: [], origins: [] })
    expect(log).toEqual([
      "newContext http://127.0.0.1:3000",
      'POST /test/sign_in_as {"email":"agent@example.test"}',
      "storageState",
      "dispose",
    ])
  })

  test("any non-2xx is a LoginError; the context is still disposed", async () => {
    const { api, log } = fakeApi(404)
    const error = await seamSignIn(api, "http://127.0.0.1:3000", {
      body: { email: "agent@example.test", password: "never-echoed" },
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LoginError)
    expect((error as Error).message).toBe(
      "Test sign-in (POST /test/sign_in_as) returned HTTP 404; is the development server (http://127.0.0.1:3000) running with the test seams enabled and the account seeded?",
    )
    expect((error as Error).message).not.toContain("never-echoed")
    expect(log.at(-1)).toBe("dispose")
  })

  test("a custom path, accepted statuses and failure wording", async () => {
    const { api, log } = fakeApi(200)
    const error = await seamSignIn(api, "http://127.0.0.1:3000", {
      path: "/qa/sign_in",
      body: { email: "a@example.test" },
      accept: (s) => s === 204,
      failure: (s) => `seam said ${s}`,
    }).catch((e: unknown) => e)
    expect((error as Error).message).toBe("seam said 200")
    expect(log[1]).toBe('POST /qa/sign_in {"email":"a@example.test"}')
  })
})
