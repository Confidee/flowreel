// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import type { APIRequest, APIRequestContext } from "@playwright/test"
import { expect, test } from "@playwright/test"

import {
  type SessionProtocol,
  type StorageState,
  createPersonaApis,
  isSessionSignedOut,
  revokeSession,
} from "../src/app/index.js"
import { ConfigError } from "../src/core/index.js"
import {
  type SeamSignInOptions,
  seamSignIn,
} from "../src/rails-inertia/index.js"

// Issue #24: flowreel opened its request contexts with `api.newContext(...)`
// and no `timeout` (seamSignIn, the session probes and revokeSession,
// createPersonaApis, the template adapter), so they got Playwright's
// default: 30 s in the runner process (global setup and teardown), and
// `actionTimeout || 0` in a worker (playwright/lib/index.js,
// `_defaultContextTimeout`): flowreel's 15 s under createConfig, none at
// all with `actionTimeout: 0` or without flowreel's config. The fix opens
// every one of them with `timeout: requestTimeoutMs` (30 s by default,
// validated like every flowreel request bound), which also covers the
// body, and overrides the project's actionTimeout.
//
// #26 rides along: a Playwright request error's "Call log" carries the
// full URL, every request header (the session cookie) and a response's
// set-cookie. flowreel's own sign-in and session checks rethrow its first
// line only, without a cause.

/** The project's default request bound (core/http.ts). */
const DEFAULT_BOUND_MS = 30_000
/** The highest bound these tests accept as "bounded". */
const MAX_BOUND_MS = 300_000
/** A short bound for the real-server tests, and the ceiling they get. */
const SHORT_BOUND_MS = 500
const REAL_CEILING_MS = 5_000

const STATE: StorageState = { cookies: [], origins: [] }

const PROTOCOL: SessionProtocol = {
  probePath: "/home",
  isSignInPath: (path) => path === "/sign-in",
  signOut: { method: "POST", path: "/session/end" },
  csrf: { cookie: "csrf", header: "X-CSRF" },
}

/** `options` with requestTimeoutMs set (any value, for the validation tests). */
function withBound<T extends object>(options: T, ms: unknown): T {
  return { ...options, requestTimeoutMs: ms } as T
}

/** Values every requestTimeoutMs refuses. */
const BAD_BOUNDS: unknown[] = [0, -1, 1.5, Number.NaN, "30000", 2 ** 31]

/** What a Playwright request error looks like: its call log names secrets. */
const COOKIE_VALUE = "SESSION-COOKIE-SECRET-9f8e"
const FRESH_COOKIE = "FRESH-SESSION-COOKIE-77aa"
function playwrightError(method: string, first: string, name = "Error"): Error {
  const error = new Error(
    `apiRequestContext.${method}: ${first}\nCall log:\n  - → ${method.toUpperCase()} http://127.0.0.1:3000/p?token=QUERY-SECRET\n    - x-csrf: CSRF-SECRET\n    - cookie: _app_session=${COOKIE_VALUE}\n  - ← 200 OK\n    - set-cookie: _app_session=${FRESH_COOKIE}; Path=/; HttpOnly\n`,
  )
  error.name = name
  return error
}

/** Everything of a rejection a report or a log could show. */
function shown(error: unknown): string {
  const e = error as Error & { cause?: unknown }
  return [e.name, e.message, e.stack, String(e.cause ?? "")].join("\n")
}

function expectNoCallLog(error: unknown) {
  const text = shown(error)
  for (const leaked of [
    "Call log",
    COOKIE_VALUE,
    FRESH_COOKIE,
    "QUERY-SECRET",
    "CSRF-SECRET",
    "set-cookie",
  ]) {
    expect(text, leaked).not.toContain(leaked)
  }
  expect((error as { cause?: unknown }).cause).toBeUndefined()
}

interface Recorded {
  method: string
  path: string
  /** The per-call options the request got (undefined when none). */
  options: unknown
  /** The options its context was opened with. */
  contextOptions: unknown
}

/** A per-call or context `timeout`, read defensively. */
function timeoutOf(options: unknown): unknown {
  return (options as { timeout?: unknown } | undefined)?.timeout
}

function isBound(value: unknown): value is number {
  return typeof value === "number" && value > 0 && value <= MAX_BOUND_MS
}

/**
 * A fake APIRequest: every context records its options and every request
 * (GET/POST/DELETE/fetch) its per-call options. `probes` answers the GETs
 * in order (default 200); every other request answers 204.
 */
function fakeApi(
  probes: { status: number; location?: string }[] = [],
  fail?: (method: string) => Error | undefined,
) {
  const requests: Recorded[] = []
  const contexts: unknown[] = []
  const answer = (status: number, location?: string) => ({
    status: () => status,
    ok: () => status >= 200 && status < 300,
    headers: () => (location ? { location } : {}),
    text: () => Promise.resolve(""),
  })
  const api = {
    newContext: (contextOptions: unknown = {}) => {
      contexts.push(contextOptions)
      const record =
        (method: string) =>
        (path: string, options?: unknown): Promise<unknown> => {
          requests.push({ method, path, options, contextOptions })
          const failure = fail?.(method)
          if (failure) return Promise.reject(failure)
          if (method !== "GET") return Promise.resolve(answer(204))
          const probe = probes.shift() ?? { status: 200 }
          return Promise.resolve(answer(probe.status, probe.location))
        }
      return Promise.resolve({
        get: record("GET"),
        post: record("POST"),
        delete: record("DELETE"),
        fetch: (path: string, options?: unknown) =>
          record(String((options as { method?: unknown } | undefined)?.method))(
            path,
            options,
          ),
        storageState: () =>
          Promise.resolve({
            cookies: [{ name: "csrf", value: "t%20k" }],
            origins: [],
          }),
        dispose: () => Promise.resolve(),
      })
    },
  }
  return { api: api as unknown as APIRequest, requests, contexts }
}

/** A request's bound: its per-call timeout, else its context's. */
function boundOf(r: Recorded): unknown {
  return timeoutOf(r.options) ?? timeoutOf(r.contextOptions)
}

/** Every recorded request is bounded (per call or by its context) in (0, 300 000]. */
function expectPerCallBound(requests: Recorded[], what: string) {
  expect(requests.length, `${what}: requests made`).toBeGreaterThan(0)
  for (const r of requests) {
    expect(
      isBound(boundOf(r)),
      `${what}: ${r.method} ${r.path} per-call ${String(timeoutOf(r.options))}, context ${String(timeoutOf(r.contextOptions))}`,
    ).toBe(true)
  }
}

/** Every recorded request is bounded by exactly `ms`. */
function expectPerCallMs(requests: Recorded[], ms: number, what: string) {
  expect(requests.length, `${what}: requests made`).toBeGreaterThan(0)
  for (const r of requests) {
    expect(boundOf(r), `${what}: ${r.method} ${r.path}`).toBe(ms)
  }
}

test.describe("#24: every session request is bounded", () => {
  test("seamSignIn's sign-in POST is bounded", async () => {
    const { api, requests } = fakeApi()
    await seamSignIn(api, "http://127.0.0.1:1", { body: { email: "a@x" } })
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /test/sign_in_as",
    ])
    expectPerCallBound(requests, "seamSignIn")
  })

  test("seamSignIn's default bound is 30 s", async () => {
    const { api, requests } = fakeApi()
    await seamSignIn(api, "http://127.0.0.1:1", { body: { email: "a@x" } })
    expectPerCallMs(requests, DEFAULT_BOUND_MS, "seamSignIn")
  })

  test("seamSignIn takes requestTimeoutMs on its options", async () => {
    const { api, requests } = fakeApi()
    await seamSignIn(
      api,
      "http://127.0.0.1:1",
      withBound<SeamSignInOptions>({ body: { email: "a@x" } }, 1_234),
    )
    expectPerCallMs(requests, 1_234, "seamSignIn")
  })

  test("isSessionSignedOut's probe is bounded, 30 s by default", async () => {
    const { api, requests } = fakeApi([{ status: 303, location: "/sign-in" }])
    expect(await isSessionSignedOut(api, "http://h", STATE, PROTOCOL)).toBe(
      true,
    )
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /home"])
    expectPerCallBound(requests, "isSessionSignedOut")
    expectPerCallMs(requests, DEFAULT_BOUND_MS, "isSessionSignedOut")
  })

  test("isSessionSignedOut takes requestTimeoutMs on its protocol", async () => {
    const { api, requests } = fakeApi([{ status: 303, location: "/sign-in" }])
    await isSessionSignedOut(api, "http://h", STATE, withBound(PROTOCOL, 1_234))
    expectPerCallMs(requests, 1_234, "isSessionSignedOut")
  })

  for (const method of ["POST", "DELETE"] as const) {
    test(`revokeSession (${method} sign-out): every probe and the sign-out are bounded, 30 s by default`, async () => {
      const { api, requests } = fakeApi([
        { status: 200 },
        { status: 200 },
        { status: 303, location: "/sign-in" },
      ])
      const protocol: SessionProtocol = {
        ...PROTOCOL,
        signOut: { method, path: "/session/end" },
      }
      expect(await revokeSession(api, "http://h", STATE, protocol)).toEqual({
        revoked: true,
        detail: `${method} /session/end -> 204`,
      })
      expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
        "GET /home",
        "GET /home",
        `${method} /session/end`,
        "GET /home",
      ])
      expectPerCallBound(requests, "revokeSession")
      expectPerCallMs(requests, DEFAULT_BOUND_MS, "revokeSession")
    })
  }

  test("revokeSession takes requestTimeoutMs on its protocol", async () => {
    const { api, requests } = fakeApi([
      { status: 200 },
      { status: 200 },
      { status: 303, location: "/sign-in" },
    ])
    await revokeSession(api, "http://h", STATE, withBound(PROTOCOL, 1_234))
    expectPerCallMs(requests, 1_234, "revokeSession")
  })

  test("createPersonaApis: a request through a persona's client is bounded (per call or by its context)", async () => {
    const { api, requests } = fakeApi()
    const apis = createPersonaApis<"a", APIRequestContext>({
      api,
      baseURL: "http://h",
      stateFor: () => STATE,
      client: (context) => context,
    })
    await apis.as("a").get("/x")
    await (await apis.request("a")).get("/y")
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /x",
      "GET /y",
    ])
    for (const r of requests) {
      const bound = timeoutOf(r.options) ?? timeoutOf(r.contextOptions)
      expect(
        isBound(bound),
        `${r.method} ${r.path}: per-call ${String(timeoutOf(r.options))}, context ${String(timeoutOf(r.contextOptions))}`,
      ).toBe(true)
    }
    await apis.dispose()
  })

  test("createPersonaApis: 30 s by default, set on each persona's context", async () => {
    const { api, requests, contexts } = fakeApi()
    const apis = createPersonaApis<"a", APIRequestContext>({
      api,
      baseURL: "http://h",
      stateFor: () => STATE,
      client: (context) => context,
    })
    await apis.as("a").get("/x")
    expect(contexts.map(timeoutOf)).toEqual([DEFAULT_BOUND_MS])
    expectPerCallMs(requests, DEFAULT_BOUND_MS, "createPersonaApis")
    await apis.dispose()
  })

  test("createPersonaApis takes requestTimeoutMs on its options", async () => {
    const { api, requests } = fakeApi()
    const apis = createPersonaApis<"a", APIRequestContext>(
      withBound(
        {
          api,
          baseURL: "http://h",
          stateFor: () => STATE,
          client: (context: APIRequestContext) => context,
        },
        1_234,
      ),
    )
    await apis.as("a").get("/x")
    for (const r of requests) {
      expect(timeoutOf(r.options) ?? timeoutOf(r.contextOptions)).toBe(1_234)
    }
    await apis.dispose()
  })
})

test.describe("#24: a bad requestTimeoutMs fails loudly, naming the option", () => {
  for (const bad of BAD_BOUNDS) {
    test(`requestTimeoutMs ${String(bad)}`, async () => {
      const { api, requests } = fakeApi()
      const refusals: [string, () => unknown][] = [
        [
          "seamSignIn option requestTimeoutMs",
          () =>
            seamSignIn(
              api,
              "http://h",
              withBound<SeamSignInOptions>({ body: { email: "a@x" } }, bad),
            ),
        ],
        [
          "SessionProtocol requestTimeoutMs",
          () =>
            isSessionSignedOut(
              api,
              "http://h",
              STATE,
              withBound(PROTOCOL, bad),
            ),
        ],
        [
          "createPersonaApis option requestTimeoutMs",
          () =>
            createPersonaApis<"a", APIRequestContext>(
              withBound(
                {
                  api,
                  baseURL: "http://h",
                  stateFor: () => STATE,
                  client: (context: APIRequestContext) => context,
                },
                bad,
              ),
            ),
        ],
      ]
      for (const [option, call] of refusals) {
        let error: unknown
        try {
          await call()
        } catch (e) {
          error = e
        }
        expect(error, option).toBeInstanceOf(ConfigError)
        expect((error as Error).message, option).toContain(option)
        expect((error as Error).message, option).not.toContain(String(bad))
      }
      // revokeSession never throws (teardown must go on to the next
      // persona); a bad bound is a loud revoked: false naming the option.
      const revoke = await revokeSession(
        api,
        "http://h",
        STATE,
        withBound(PROTOCOL, bad),
      )
      expect(revoke.revoked).toBe(false)
      expect(revoke.detail).toContain("SessionProtocol requestTimeoutMs")
      expect(revoke.detail).not.toContain(String(bad))
      // Refused before any context was opened.
      expect(requests).toEqual([])
    })
  }
})

test.describe("#26: flowreel's sign-in and session checks never pass a call log on", () => {
  for (const [name, first] of [
    ["TimeoutError", "Timeout 30000ms exceeded."],
    ["Error", "read ECONNRESET"],
  ] as const) {
    test(`seamSignIn: a ${name} is rethrown as its first line only`, async () => {
      const { api } = fakeApi([], (method) =>
        method === "POST" ? playwrightError("post", first, name) : undefined,
      )
      const error = await seamSignIn(api, "http://h", {
        body: { email: "a@x" },
      }).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain(first)
      expect((error as Error).message).toContain("POST /test/sign_in_as")
      expectNoCallLog(error)
    })

    test(`isSessionSignedOut: a ${name} is rethrown as its first line only`, async () => {
      const { api } = fakeApi([], (method) =>
        method === "GET" ? playwrightError("get", first, name) : undefined,
      )
      const error = await isSessionSignedOut(
        api,
        "http://h",
        STATE,
        PROTOCOL,
      ).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain(first)
      expect((error as Error).message).toContain("GET /home")
      expectNoCallLog(error)
    })
  }

  test("isSessionSignedOut names the probe's path, never its query", async () => {
    const { api } = fakeApi([], () => playwrightError("get", "read ECONNRESET"))
    const error = await isSessionSignedOut(api, "http://h", STATE, {
      ...PROTOCOL,
      probePath: "/home?token=PROBE-QUERY",
    }).catch((e: unknown) => e)
    expect((error as Error).message).toContain("GET /home")
    expect(shown(error)).not.toContain("PROBE-QUERY")
  })

  test("revokeSession still never throws: its detail is the error's name", async () => {
    const { api } = fakeApi([], () =>
      playwrightError("get", "Timeout 30000ms exceeded.", "TimeoutError"),
    )
    const result = await revokeSession(api, "http://h", STATE, PROTOCOL)
    expect(result.revoked).toBe(false)
    expect(result.detail).not.toContain(COOKIE_VALUE)
    expect(result.detail).not.toContain("Call log")
  })

  test("a LoginError (a refused sign-in) is not rewritten", async () => {
    const { api } = fakeApi()
    const error = await seamSignIn(api, "http://h", {
      body: { email: "a@x" },
      accept: () => false,
      failure: (status) => `refused ${status}`,
    }).catch((e: unknown) => e)
    expect((error as Error).name).toBe("LoginError")
    expect((error as Error).message).toBe("refused 204")
  })
})

// ---------------------------------------------------------------------------
// The template adapter (plugin/templates/e2e/flowreel/adapter.ts) cannot be
// imported here (it imports the project's own config), so its source is
// checked: every request a request context makes must carry a `timeout`,
// per call or on the api.newContext(...) that opened it.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))
const TEMPLATE_ADAPTER = join(
  here,
  "..",
  "..",
  "plugin",
  "templates",
  "e2e",
  "flowreel",
  "adapter.ts",
)

/** The text between the parenthesis at `open` and its match. */
function argsAt(source: string, open: number): string {
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === "(") depth += 1
    else if (source[i] === ")" && --depth === 0) {
      return source.slice(open + 1, i)
    }
  }
  return source.slice(open + 1)
}

const EXAMPLE_ADAPTER = join(
  here,
  "..",
  "..",
  "examples",
  "minimal",
  "e2e",
  "flowreel",
  "adapter.ts",
)

for (const [name, file] of [
  ["template", TEMPLATE_ADAPTER],
  ["example", EXAMPLE_ADAPTER],
] as const) {
  test(`#24: the ${name} adapter bounds every request its contexts make`, () => {
    const source = readFileSync(file, "utf8")
    const sites: { at: number; kind: "context" | "request"; text: string }[] =
      []
    for (const m of source.matchAll(/\bapi\.newContext\(/g)) {
      const open = m.index + m[0].length - 1
      sites.push({ at: m.index, kind: "context", text: argsAt(source, open) })
    }
    for (const m of source.matchAll(
      /\bcontext\s*\.(get|post|put|patch|delete|head|fetch)\(/g,
    )) {
      const open = m.index + m[0].length - 1
      sites.push({
        at: m.index,
        kind: "request",
        text: `${m[0]}${argsAt(source, open)})`,
      })
    }
    sites.sort((a, b) => a.at - b.at)
    const requests = sites.filter((s) => s.kind === "request")
    expect(requests.length).toBeGreaterThan(0)
    const unbounded: string[] = []
    let context: (typeof sites)[number] | undefined
    for (const site of sites) {
      if (site.kind === "context") {
        context = site
        continue
      }
      const bounded =
        /\btimeout\b/.test(site.text) ||
        (context !== undefined && /\btimeout\b/.test(context.text))
      if (!bounded) unbounded.push(site.text.replace(/\s+/g, " ").slice(0, 80))
    }
    expect(unbounded).toEqual([])
    // #26: a caught error is only ever described by requestFailure(): any
    // other use (its message, String(error), a cause) can carry the call log.
    const catches = [
      ...source.matchAll(/\bcatch\s*\(\s*(\w+)[^)]*\)\s*\{/g),
      ...source.matchAll(/\.catch\(\s*\(\s*(\w+)[^)]*\)\s*=>\s*\{/g),
    ]
    expect(catches.length).toBeGreaterThan(0)
    const misused: string[] = []
    for (const m of catches) {
      const name = m[1]
      const body = blockAt(source, m.index + m[0].length - 1)
      const rest = body.split(`requestFailure(${name})`).join("")
      if (new RegExp(`\\b${name}\\b`).test(rest)) {
        misused.push(body.replace(/\s+/g, " ").slice(0, 100))
      }
    }
    expect(misused).toEqual([])
  })
}

/** The text of the `{…}` block whose opening brace is at `open`. */
function blockAt(source: string, open: number): string {
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth += 1
    else if (source[i] === "}" && --depth === 0) {
      return source.slice(open + 1, i)
    }
  }
  return source.slice(open + 1)
}

// ---------------------------------------------------------------------------
// A real loopback server and the runner's own `playwright.request`, whose
// contexts get `actionTimeout || 0` (no timeout) by default.
// ---------------------------------------------------------------------------

/** A stored session on the loopback host: the cookie a probe sends. */
const SIGNED_IN = {
  cookies: [
    {
      name: "_app_session",
      value: COOKIE_VALUE,
      domain: "127.0.0.1",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ],
  origins: [],
} as StorageState

/** A server that never answers, or answers headers and never ends the body. */
async function silentServer(mode: "no answer" | "stalled body") {
  let hits = 0
  const server = http.createServer((req, res) => {
    hits += 1
    req.resume()
    if (mode === "stalled body") {
      // A fresh session cookie, then a body that never ends.
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": `_app_session=${FRESH_COOKIE}; Path=/; HttpOnly`,
      })
      res.write('{"ok":')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return {
    baseURL: `http://127.0.0.1:${port}`,
    hits: () => hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/** How `promise` settled within `ms` of real time, or "pending". */
async function settleWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<{
  state: "resolved" | "rejected" | "pending"
  elapsed: number
  value?: unknown
  error?: unknown
}> {
  const started = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  let value: unknown
  let error: unknown
  const state = await Promise.race([
    promise.then(
      (v: unknown) => {
        value = v
        return "resolved" as const
      },
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
  return { state, elapsed: Date.now() - started, value, error }
}

test.describe("#24 on a real server, through the runner's playwright.request", () => {
  test.setTimeout(30_000)

  test("premise: in a worker whose actionTimeout is 0, a context opened without `timeout` never gives up on a silent server", async ({
    playwright,
  }, testInfo) => {
    // This suite sets no actionTimeout: a worker's context default is none.
    expect(testInfo.project.use.actionTimeout ?? 0).toBe(0)
    const server = await silentServer("no answer")
    const context = await playwright.request.newContext({
      baseURL: server.baseURL,
    })
    try {
      const settled = await settleWithin(context.get("/"), 2_000)
      expect(settled.state).toBe("pending")
      expect(server.hits()).toBe(1)
    } finally {
      await server.close()
      await context.dispose()
    }
  })

  for (const mode of ["no answer", "stalled body"] as const) {
    test(`seamSignIn against a server with ${mode} rejects within the bound`, async ({
      playwright,
    }) => {
      const server = await silentServer(mode)
      try {
        const settled = await settleWithin(
          seamSignIn(
            playwright.request,
            server.baseURL,
            withBound<SeamSignInOptions>(
              { body: { email: "a@x" } },
              SHORT_BOUND_MS,
            ),
          ),
          REAL_CEILING_MS,
        )
        expect(server.hits()).toBe(1)
        expect(
          settled.state,
          `still ${settled.state} after ${settled.elapsed} ms`,
        ).toBe("rejected")
        expect(settled.elapsed).toBeLessThan(REAL_CEILING_MS)
        // #26: Playwright's error names the fresh set-cookie; ours must not.
        expectNoCallLog(settled.error)
      } finally {
        await server.close()
      }
    })
  }

  test("isSessionSignedOut against a silent server rejects within the bound", async ({
    playwright,
  }) => {
    const server = await silentServer("no answer")
    try {
      const settled = await settleWithin(
        isSessionSignedOut(
          playwright.request,
          server.baseURL,
          SIGNED_IN,
          withBound(PROTOCOL, SHORT_BOUND_MS),
        ),
        REAL_CEILING_MS,
      )
      expect(
        settled.state,
        `still ${settled.state} after ${settled.elapsed} ms`,
      ).toBe("rejected")
      // #26: Playwright's error names the session cookie it sent; ours must not.
      expectNoCallLog(settled.error)
    } finally {
      await server.close()
    }
  })

  test("revokeSession against a silent server gives up within the bound, revoked false", async ({
    playwright,
  }) => {
    const server = await silentServer("no answer")
    try {
      const settled = await settleWithin(
        revokeSession(
          playwright.request,
          server.baseURL,
          STATE,
          withBound(PROTOCOL, SHORT_BOUND_MS),
        ),
        REAL_CEILING_MS,
      )
      expect(
        settled.state,
        `still ${settled.state} after ${settled.elapsed} ms`,
      ).toBe("resolved")
      expect((settled.value as { revoked?: unknown }).revoked).toBe(false)
    } finally {
      await server.close()
    }
  })

  test("createPersonaApis: a persona's request against a silent server rejects within the bound", async ({
    playwright,
  }) => {
    const server = await silentServer("no answer")
    const apis = createPersonaApis<"a", APIRequestContext>(
      withBound(
        {
          api: playwright.request,
          baseURL: server.baseURL,
          stateFor: () => STATE,
          client: (context: APIRequestContext) => context,
        },
        SHORT_BOUND_MS,
      ),
    )
    try {
      const settled = await settleWithin(
        apis.as("a").get("/x"),
        REAL_CEILING_MS,
      )
      expect(
        settled.state,
        `still ${settled.state} after ${settled.elapsed} ms`,
      ).toBe("rejected")
    } finally {
      await server.close()
      await apis.dispose()
    }
  })
})
