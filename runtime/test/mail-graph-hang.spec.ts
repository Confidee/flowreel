// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inspect } from "node:util"

import { expect, test } from "@playwright/test"

import { TimeoutError } from "../src/core/index.js"
import {
  GraphMailDriver,
  type GraphMailDriverOptions,
  GraphRequestTimeoutError,
  toMailMessage,
} from "../src/mail-graph/index.js"
import { unhandledRejections } from "./virtual-clock.js"

// Issue #16: a Graph request that never answers must not stall a run.
// These tests use real timers and a 3 s ceiling, so they prove the bound
// on the event loop itself. The fakes model the ways a real connection
// hangs: a fetch that honours its abort signal (what fetch does) and one
// that ignores it entirely. mail-graph-timeout.spec.ts covers the exact
// arithmetic on a virtual clock.

const TOKEN_URL = "https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token"
// A client secret with the characters that encoding changes (~ + / = and a
// space), so a check for it also covers its encoded forms.
const SECRET = "Abc8Q~x+y/z= END"
const TOKEN = "eyJ.hang-access-token.sig"
/**
 * The secret as text can carry it: raw, URI-encoded, and form-encoded (the
 * token request's body). The last two differ for "~" and the space.
 */
const SECRET_FORMS = [
  SECRET,
  encodeURIComponent(SECRET),
  new URLSearchParams({ s: SECRET }).toString().slice(2),
]

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

interface Seen {
  url: string
  init: RequestInit
}

/**
 * Never answers; once its signal aborts, rejects like a fetch whose error
 * echoes the request: the form body (the client secret on the token call)
 * and the Authorization header, in the message and in a cause.
 */
function hangingFetch(seen: Seen[] = []): FetchLike {
  return (url, init = {}) => {
    seen.push({ url, init })
    return new Promise((_, reject) => {
      const signal = init.signal
      if (!signal) return
      const abort = () => {
        const echo = `${String(init.body)} ${JSON.stringify(init.headers)}`
        const error = new Error(`This operation was aborted: ${echo}`, {
          cause: new Error(echo),
        })
        error.name = "AbortError"
        reject(error)
      }
      if (signal.aborted) abort()
      else signal.addEventListener("abort", abort, { once: true })
    })
  }
}

/** Never answers and never looks at the signal. */
function deafFetch(seen: Seen[] = []): FetchLike {
  return (url, init = {}) => {
    seen.push({ url, init })
    return new Promise(() => {})
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

/** Answers like a healthy tenant: a token, then an empty mailbox. */
const healthyFetch: FetchLike = (input) =>
  Promise.resolve(
    input === TOKEN_URL
      ? json(200, { access_token: TOKEN, expires_in: 3600 })
      : json(200, { value: [] }),
  )

/** The token answers; every Graph call hangs (honouring its signal). */
function hangingGraph(seen: Seen[] = []): FetchLike {
  const hang = hangingFetch(seen)
  return (url, init) =>
    url === TOKEN_URL ? healthyFetch(url) : hang(url, init)
}

function driver(fetch: FetchLike, extra: Partial<GraphMailDriverOptions> = {}) {
  return new GraphMailDriver({
    tenantId: "tenant-1",
    clientId: "client-1",
    clientSecret: SECRET,
    mailbox: "qa@example.com",
    replyDomain: "reply.example.com",
    defaultTimeoutMs: 10_000,
    fetch,
    ...extra,
  })
}

/** How `promise` settled within `ms`, or "pending", and how long it took. */
async function settleWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<{
  state: "resolved" | "rejected" | "pending"
  error?: Error
  elapsed: number
}> {
  const started = performance.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const pending = new Promise<{ state: "pending" }>((resolve) => {
    timer = setTimeout(() => resolve({ state: "pending" }), ms)
  })
  try {
    const outcome = await Promise.race([
      promise.then(
        () => ({ state: "resolved" as const }),
        (error: Error) => ({ state: "rejected" as const, error }),
      ),
      pending,
    ])
    return { ...outcome, elapsed: performance.now() - started }
  } finally {
    clearTimeout(timer)
  }
}

const query = (timeoutMs: number) => ({
  subjectIncludes: "RUN-123",
  since: new Date(),
  timeoutMs,
})

let rejections: ReturnType<typeof unhandledRejections>
test.beforeEach(() => {
  rejections = unhandledRejections()
})
test.afterEach(async () => {
  expect(await rejections.stop()).toEqual([])
})

test.describe("issue #16: a Graph request that never answers", () => {
  test("waitFor still ends at its own timeoutMs", async () => {
    const seen: Seen[] = []
    const outcome = await settleWithin(
      driver(hangingGraph(seen)).waitFor(query(300)),
      3_000,
    )
    expect(outcome.state).toBe("rejected")
    expect(outcome.error).toBeInstanceOf(TimeoutError)
    expect(outcome.error).not.toBeInstanceOf(GraphRequestTimeoutError)
    expect(outcome.elapsed).toBeGreaterThanOrEqual(280)
    const list = seen.filter((s) => s.url.includes("/messages?"))
    expect(list.length).toBeGreaterThanOrEqual(1)
    // The driver aborted the hung list request: its connection is let go.
    expect(list[0].init.signal?.aborted).toBe(true)
  })

  test("waitFor ends at its own timeoutMs even when fetch ignores the abort signal", async () => {
    const seen: Seen[] = []
    const outcome = await settleWithin(
      driver(deafFetch(seen)).waitFor(query(300)),
      3_000,
    )
    expect(outcome.state).toBe("rejected")
    expect(outcome.error).toBeInstanceOf(TimeoutError)
    expect(outcome.elapsed).toBeGreaterThanOrEqual(280)
    expect(seen.length).toBeGreaterThanOrEqual(1)
  })

  test("every Graph operation, the token request included, gets its own live abort signal", async () => {
    const seen: {
      url: string
      method: string
      signal: unknown
      aborted: boolean
    }[] = []
    const message = {
      id: "AAMk-1=",
      subject: "RUN-123 hello",
      receivedDateTime: new Date(Date.now() + 60_000).toISOString(),
      replyTo: [{ emailAddress: { address: "reply+t@reply.example.com" } }],
    }
    const recording: FetchLike = (input, init = {}) => {
      seen.push({
        url: input,
        method: init.method ?? "GET",
        signal: init.signal,
        aborted: init.signal?.aborted ?? false,
      })
      if (input === TOKEN_URL) return healthyFetch(input)
      if (input.includes("/messages?")) {
        return Promise.resolve(json(200, { value: [message] }))
      }
      if (input.endsWith("/$value")) {
        return Promise.resolve(new Response("From: a\r\n\r\nbody"))
      }
      if (input.includes("?$select=")) {
        return Promise.resolve(json(200, message))
      }
      if (input.endsWith("/createReply")) {
        return Promise.resolve(json(201, { id: "draft-1" }))
      }
      if (init.method === "PATCH") {
        return Promise.resolve(json(200, { id: "draft-1" }))
      }
      return Promise.resolve(new Response(null, { status: 202 }))
    }
    const graph = driver(recording)
    const found = await graph.waitFor({
      subjectIncludes: "RUN-123",
      since: new Date(Date.now() - 1000),
    })
    await graph.send({
      from: "qa@example.com",
      to: "support@reply.example.com",
      subject: "s",
      text: "t",
    })
    await graph.reply(found, { from: "qa@example.com", text: "t" })
    const dir = await mkdtemp(join(tmpdir(), "flowreel-hang-"))
    try {
      await graph.saveEml(toMailMessage(message), dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }

    const operations = seen.map((s) =>
      s.url === TOKEN_URL
        ? "token"
        : `${s.method} ${s.url.split("?")[0].replace(/.*\/users\/[^/]+/, "")}`,
    )
    expect(operations).toEqual([
      "token",
      "GET /messages",
      "GET /messages/AAMk-1%3D",
      "POST /sendMail",
      "POST /messages/AAMk-1%3D/createReply",
      "PATCH /messages/draft-1",
      "POST /messages/draft-1/send",
      "GET /messages/AAMk-1%3D/$value",
    ])
    for (const s of seen) {
      expect(s.signal).toBeInstanceOf(AbortSignal)
      expect(s.aborted).toBe(false)
    }
    // One signal per request: aborting one never touches another.
    expect(new Set(seen.map((s) => s.signal)).size).toBe(seen.length)
  })

  test("a hung token request does not block the driver for good", async () => {
    let hang = true
    const hung = hangingFetch()
    let tokenRequests = 0
    const switching: FetchLike = (input, init) => {
      if (input === TOKEN_URL) tokenRequests += 1
      return hang ? hung(input, init) : healthyFetch(input, init)
    }
    const graph = driver(switching, { requestTimeoutMs: 200 })

    const waited = await settleWithin(graph.waitFor(query(300)), 3_000)
    expect(waited.state).toBe("rejected")
    expect(waited.error).toBeInstanceOf(TimeoutError)
    expect(waited.elapsed).toBeGreaterThanOrEqual(280)

    hang = false
    expect((await settleWithin(graph.health(), 3_000)).state).toBe("resolved")
    // The timed-out token request was dropped; the next call asked anew.
    expect(tokenRequests).toBe(2)
  })

  test("the error a hang ends with never carries the client secret or the token", async () => {
    // A hung token request, and a hung Graph request after a good token.
    for (const [fetch, extra] of [
      [hangingFetch(), { requestTimeoutMs: 200 }],
      [hangingGraph(), {}],
    ] as const) {
      const outcome = await settleWithin(
        driver(fetch, extra).waitFor(query(300)),
        3_000,
      )
      expect(outcome.state).toBe("rejected")
      const shown = inspect(outcome.error, { depth: 5 })
      for (const form of SECRET_FORMS) expect(shown).not.toContain(form)
      expect(shown).not.toContain(TOKEN)
    }
    // A send that hangs ends with the driver's own error, not fetch's echo.
    const sent = await settleWithin(
      driver(hangingGraph(), { requestTimeoutMs: 200 }).send({
        from: "qa@example.com",
        to: "support@reply.example.com",
        subject: "s",
        text: "t",
      }),
      3_000,
    )
    expect(sent.error).toBeInstanceOf(GraphRequestTimeoutError)
    const shown = inspect(sent.error, { depth: 5 })
    for (const form of SECRET_FORMS) expect(shown).not.toContain(form)
    expect(shown).not.toContain(TOKEN)
  })

  test("every timer a call arms is cleared once it settles", async () => {
    // Real timers, tracked: process.getActiveResourcesInfo() does not count
    // an unref'd timer, so only a seam sees one that was never cleared.
    const live = new Set<ReturnType<typeof setTimeout>>()
    const armed: number[] = []
    const seam = {
      setTimeout: (fn: () => void, ms: number) => {
        const timer = setTimeout(fn, ms)
        live.add(timer)
        armed.push(ms)
        return timer
      },
      clearTimeout: (timer: unknown) => {
        live.delete(timer as ReturnType<typeof setTimeout>)
        clearTimeout(timer as ReturnType<typeof setTimeout>)
      },
    }

    const graph = driver(healthyFetch, seam)
    for (let i = 0; i < 3; i++) await graph.health()
    expect(armed.length).toBeGreaterThanOrEqual(4)
    expect(live.size).toBe(0)

    const denied: FetchLike = (input) =>
      Promise.resolve(
        input === TOKEN_URL
          ? json(200, { access_token: TOKEN, expires_in: 3600 })
          : json(403, { error: { code: "ErrorAccessDenied" } }),
      )
    await expect(driver(denied, seam).health()).rejects.toThrow(/HTTP 403/)
    expect(live.size).toBe(0)

    const hung = await settleWithin(
      driver(hangingGraph(), { ...seam, requestTimeoutMs: 100 }).health(),
      3_000,
    )
    expect(hung.state).toBe("rejected")
    expect(live.size).toBe(0)

    // A wait shorter than the bound: the token request is raced, not cut.
    const waited = await settleWithin(
      driver(hangingFetch(), { ...seam, requestTimeoutMs: 400 }).waitFor(
        query(150),
      ),
      3_000,
    )
    expect(waited.error).toBeInstanceOf(TimeoutError)
    // The shared token request keeps its own bound until it ends.
    await expect.poll(() => live.size, { timeout: 2_000 }).toBe(0)
  })
})
