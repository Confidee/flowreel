// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "@playwright/test"

import { ConfigError } from "../src/core/index.js"
import {
  type FetchLike,
  type SeamHttp,
  seamHttpFromFetch,
  seamHttpFromRequest,
} from "../src/rails-inertia/index.js"
import {
  type Outcome,
  type VirtualClock,
  unhandledRejections,
  virtualClock,
} from "./virtual-clock.js"

// Issue #20: seamHttpFromFetch passed no abort signal, so a seam request
// that never answered waited for Node fetch's own 300 s headers timeout,
// and a trickling body was not bounded at all. Like the Graph driver,
// every request now gets one AbortController and one unref'd timer of
// requestTimeoutMs (30 s by default) over the headers and the whole body,
// cleared however it ends. Most of it runs on a virtual clock (the timers
// are injected), so the 30 s default fires in microseconds and is asserted
// exactly; one smoke test runs on real timers. seamHttpFromRequest passes
// the same bound as Playwright's own per-call `timeout`.

type FetchImpl = FetchLike

const BASE_URL = "http://localhost:3101"
const NO_ANSWER_HINT =
  "raise requestTimeoutMs if a job drain legitimately takes longer"

interface Seen {
  url: string
  init: RequestInit
}

function okFetch(seen: Seen[], status = 200): FetchImpl {
  return (url, init = {}) => {
    seen.push({ url, init })
    return Promise.resolve(
      new Response('{"ok":true}', {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    )
  }
}

/** Never answers; rejects with an AbortError once its signal aborts. */
function hangingFetch(seen: Seen[]): FetchImpl {
  return (url, init = {}) => {
    seen.push({ url, init })
    return new Promise((_, reject) => {
      const signal = init.signal
      if (!signal) return
      const abort = () => {
        const error = new Error("This operation was aborted")
        error.name = "AbortError"
        reject(error)
      }
      if (signal.aborted) abort()
      else signal.addEventListener("abort", abort, { once: true })
    })
  }
}

/** Never answers and never looks at its signal. */
function deafFetch(seen: Seen[]): FetchImpl {
  return (url, init = {}) => {
    seen.push({ url, init })
    return new Promise(() => {})
  }
}

/** Headers arrive (200); the body never ends (it errors once aborted). */
function stallingFetch(seen: Seen[]): FetchImpl {
  return (url, init = {}) => {
    seen.push({ url, init })
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"deliveries":['))
        init.signal?.addEventListener(
          "abort",
          () => {
            const error = new Error("This operation was aborted")
            error.name = "AbortError"
            controller.error(error)
          },
          { once: true },
        )
      },
    })
    return Promise.resolve(
      new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )
  }
}

/** How `promise` settled within `ms` of real time, or "pending". */
async function settleWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<{
  state: "resolved" | "rejected" | "pending"
  elapsed: number
  error?: unknown
}> {
  const started = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  let error: unknown
  const state = await Promise.race([
    promise.then(
      () => "resolved" as const,
      (e: unknown) => {
        error = e
        return "rejected" as const
      },
    ),
    new Promise<"pending">((resolve) => {
      timer = setTimeout(() => resolve("pending"), ms)
    }),
  ])
  clearTimeout(timer)
  return { state, elapsed: Date.now() - started, error }
}

/** One request of each kind the seam driver makes: [name, method, path, call]. */
const REQUESTS: [
  string,
  string,
  string,
  (http: SeamHttp) => Promise<unknown>,
][] = [
  [
    "GET",
    "GET",
    "/test/mail_deliveries",
    (http) => http("GET", "/test/mail_deliveries?after=3"),
  ],
  [
    "POST with a body",
    "POST",
    "/test/inbound_emails",
    (http) => http("POST", "/test/inbound_emails", { body: "BODY-MARKER" }),
  ],
  [
    "POST without a body",
    "POST",
    "/test/perform_enqueued_jobs",
    (http) => http("POST", "/test/perform_enqueued_jobs"),
  ],
]

/** A seam client on the virtual clock. */
function clocked(
  c: VirtualClock,
  fetch: FetchImpl,
  requestTimeoutMs?: number,
): SeamHttp {
  return seamHttpFromFetch(BASE_URL, {
    fetch,
    setTimeout: c.setTimeout,
    clearTimeout: c.clearTimeout,
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
  })
}

function rejectedWith(outcome: Outcome<unknown>): Error {
  expect(outcome.state).toBe("rejected")
  return (outcome as { error: Error }).error
}

let rejections: ReturnType<typeof unhandledRejections>
test.beforeEach(() => {
  rejections = unhandledRejections()
})
test.afterEach(async () => {
  expect(await rejections.stop()).toEqual([])
})

test.describe("every seam request carries an abort signal", () => {
  for (const [name, , , request] of REQUESTS) {
    test(`${name} (the two-argument form)`, async () => {
      const seen: Seen[] = []
      await request(seamHttpFromFetch(BASE_URL, okFetch(seen)))
      expect(seen).toHaveLength(1)
      expect(seen[0].init.signal).toBeInstanceOf(AbortSignal)
      // A request that answered in time was not aborted.
      expect(seen[0].init.signal?.aborted).toBe(false)
    })
  }
})

test.describe("with no option, every request is bounded at 30 s", () => {
  for (const [name, , , request] of REQUESTS) {
    for (const status of [200, 500]) {
      test(`${name} answered ${status}: one unref'd 30 s timer, cleared`, async () => {
        const c = virtualClock()
        const seen: Seen[] = []
        const out = await c.run(request(clocked(c, okFetch(seen, status))))
        expect(out.state).toBe("resolved")
        expect(out.at).toBe(c.start)
        expect(c.timers.map((h) => [h.ms, h.unrefd])).toEqual([[30_000, true]])
        expect(c.armed()).toEqual([])
        expect(seen[0].init.signal?.aborted).toBe(false)
      })
    }

    for (const [ending, make] of [
      ["never answers", hangingFetch],
      ["never answers and ignores its signal", deafFetch],
      ["answers headers, then the body stalls", stallingFetch],
    ] as [string, (seen: Seen[]) => FetchImpl][]) {
      test(`${name}: ${ending} ends at exactly 30 s`, async () => {
        const c = virtualClock()
        const seen: Seen[] = []
        const out = await c.run(request(clocked(c, make(seen))))
        rejectedWith(out)
        expect(out.at - c.start).toBe(30_000)
        expect(c.timers.map((h) => [h.ms, h.unrefd])).toEqual([[30_000, true]])
        expect(c.armed()).toEqual([])
        // The request it gave up on was aborted.
        expect(seen[0]?.init.signal?.aborted).toBe(true)
      })
    }
  }
})

test.describe("the timeout error", () => {
  test("names the method, the path and the bound, never the body", async () => {
    for (const [name, method, path, request] of REQUESTS) {
      const c = virtualClock()
      const error = rejectedWith(
        await c.run(request(clocked(c, hangingFetch([])))),
      )
      expect(error.constructor, name).toBe(Error)
      expect(error.message, name).toBe(
        `Seam ${method} ${path} got no answer within 30 s; ${NO_ANSWER_HINT}`,
      )
      expect(error.message, name).not.toContain("BODY-MARKER")
      expect(error.message, name).not.toContain("after=")
      expect(error.message, name).not.toContain(BASE_URL)
    }
  })

  test("a bound under a second is named in milliseconds", async () => {
    const c = virtualClock()
    const error = rejectedWith(
      await c.run(REQUESTS[0][3](clocked(c, hangingFetch([]), 300))),
    )
    expect(error.message).toBe(
      `Seam GET /test/mail_deliveries got no answer within 300 ms; ${NO_ANSWER_HINT}`,
    )
  })

  test("an AbortError the client did not cause is passed on as is", async () => {
    const c = virtualClock()
    const foreign = new Error("This operation was aborted")
    foreign.name = "AbortError"
    const error = rejectedWith(
      await c.run(REQUESTS[0][3](clocked(c, () => Promise.reject(foreign)))),
    )
    expect(error).toBe(foreign)
    expect(c.armed()).toEqual([])
  })
})

test.describe("requestTimeoutMs", () => {
  test("a project's value bounds every request", async () => {
    const c = virtualClock()
    const seen: Seen[] = []
    const http = clocked(c, okFetch(seen), 5_000)
    for (const [, , , request] of REQUESTS) {
      expect((await c.run(request(http))).state).toBe("resolved")
    }
    expect(c.timers.map((h) => h.ms)).toEqual([5_000, 5_000, 5_000])
    expect(c.armed()).toEqual([])
  })

  test("must be a whole number of milliseconds from 1 to 2147483647, for both clients", () => {
    const request = { fetch: () => Promise.reject(new Error("unused")) }
    for (const bad of [0, -1, 1.5, NaN, Infinity, 2 ** 31, "30000"]) {
      for (const [name, build] of [
        [
          "seamHttpFromFetch",
          () =>
            seamHttpFromFetch(BASE_URL, {
              requestTimeoutMs: bad as number,
            }),
        ],
        [
          "seamHttpFromRequest",
          () =>
            seamHttpFromRequest(request as never, {
              requestTimeoutMs: bad as number,
            }),
        ],
      ] as [string, () => unknown][]) {
        const label = `${name} ${String(bad)}`
        expect(build, label).toThrow(ConfigError)
        expect(build, label).toThrow(
          `${name} option requestTimeoutMs must be a whole number of milliseconds from 1 to 2147483647.`,
        )
      }
    }
    for (const good of [1, 2_147_483_647]) {
      expect(() =>
        seamHttpFromFetch(BASE_URL, { requestTimeoutMs: good }),
      ).not.toThrow()
      expect(() =>
        seamHttpFromRequest(request as never, { requestTimeoutMs: good }),
      ).not.toThrow()
    }
  })

  test("a real timer ends a request whose fetch ignores its signal", async () => {
    const seen: Seen[] = []
    const http = seamHttpFromFetch(BASE_URL, {
      fetch: deafFetch(seen),
      requestTimeoutMs: 50,
    })
    const outcome = await settleWithin(
      http("POST", "/test/perform_enqueued_jobs"),
      5_000,
    )
    expect(outcome.state).toBe("rejected")
    expect(outcome.elapsed).toBeGreaterThanOrEqual(40)
    expect((outcome.error as Error).message).toContain("within 50 ms")
    expect(seen[0]?.init.signal?.aborted).toBe(true)
  })
})

test.describe("seamHttpFromRequest", () => {
  type Init = { method?: string; timeout?: number }

  function fakeRequest() {
    const seen: ({ path: string } & Init)[] = []
    const request = {
      fetch: (path: string, init: Init) => {
        seen.push({ path, ...init })
        return Promise.resolve({
          status: () => 200,
          text: () => Promise.resolve("{}"),
        })
      },
    }
    return { request, seen }
  }

  test("passes a 30 s timeout to every call by default", async () => {
    const { request, seen } = fakeRequest()
    const http = seamHttpFromRequest(request as never)
    for (const [, , , call] of REQUESTS) await call(http)
    expect(seen.map((s) => s.timeout)).toEqual([30_000, 30_000, 30_000])
  })

  test("passes the project's requestTimeoutMs", async () => {
    const { request, seen } = fakeRequest()
    const http = seamHttpFromRequest(request as never, {
      requestTimeoutMs: 1_234,
    })
    for (const [, , , call] of REQUESTS) await call(http)
    expect(seen.map((s) => s.timeout)).toEqual([1_234, 1_234, 1_234])
  })
})
