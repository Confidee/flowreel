// SPDX-License-Identifier: Apache-2.0

import type {
  APIRequest,
  APIRequestContext,
  Browser,
  FullConfig,
} from "@playwright/test"
import { expect, test } from "@playwright/test"

import {
  type AppAdapter,
  KEEPALIVE_MAX_MS,
  SessionKeepalive,
  type SessionProtocol,
  createGlobalSetup,
  createPersonaApis,
  distinctSessions,
  keepaliveDeadline,
  personaOf,
  refuseRepeats,
  requireStorageState,
  revokeSession,
  safePath,
  signInAll,
  signOutAll,
  signedOutBy,
  stateEnvKey,
  storageStateFromEnv,
} from "../src/app/index.js"
import { ConfigError } from "../src/core/errors.js"

// The app module: the storageState handoff, session revocation, the
// bounded keepalive, sign-in once per distinct session and sign-out of every
// session, and lazy per-persona API clients. Every network touch is a fake.

const STATE = { cookies: [], origins: [] }

test.describe("personas and the handoff", () => {
  test("FLOWREEL_STATE_<PERSONA> JSON, or the project's prefix", () => {
    expect(stateEnvKey("agent2")).toBe("FLOWREEL_STATE_AGENT2")
    expect(stateEnvKey("admin", "APP_STATE_")).toBe("APP_STATE_ADMIN")
    expect(
      storageStateFromEnv("agent", {
        FLOWREEL_STATE_AGENT: JSON.stringify(STATE),
      }),
    ).toEqual(STATE)
    expect(storageStateFromEnv("agent", {})).toBeNull()
    let message = ""
    try {
      storageStateFromEnv("agent", { FLOWREEL_STATE_AGENT: "{secret" })
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError)
      message = (error as Error).message
    }
    expect(message).toBe("FLOWREEL_STATE_AGENT is not valid JSON.")
  })

  test("one entry per distinct session, in order", () => {
    const env = {
      FLOWREEL_STATE_A: "s1",
      FLOWREEL_STATE_B: "s1",
      FLOWREEL_STATE_C: "s2",
      FLOWREEL_STATE_D: "",
    }
    expect(distinctSessions(["a", "b", "c", "d", "e"], env)).toEqual(["a", "c"])
    expect(
      personaOf<"a" | "b">({ a: { email: "x", password: "y" } }, "b"),
    ).toBeNull()
  })

  test("requireStorageState: the session, or an actionable refusal", () => {
    expect(
      requireStorageState("agent", { env: { FLOWREEL_STATE_AGENT: "{}" } }),
    ).toEqual({})
    expect(() => requireStorageState("admin", { env: {} })).toThrow(
      /The admin persona is not signed in for this run \(FLOWREEL_STATE_ADMIN unset\)/,
    )
    expect(() =>
      requireStorageState("admin", { env: {}, message: (p, v) => `${p}:${v}` }),
    ).toThrow("admin:FLOWREEL_STATE_ADMIN")
  })
})

test.describe("sessions", () => {
  const PROTOCOL: SessionProtocol = {
    isSignInPath: (p) => p.startsWith("/login"),
    signOut: { method: "POST", path: "/logout" },
    csrf: { cookie: "CSRF", header: "X-CSRF" },
  }

  function fakeApi(
    probes: { status: number; location?: string }[],
    fail = false,
  ) {
    const calls: string[] = []
    const api = {
      newContext() {
        if (fail) throw new TypeError("down")
        return Promise.resolve({
          get(path: string) {
            calls.push(`GET ${path}`)
            const reply = probes.shift() ?? { status: 200 }
            return Promise.resolve({
              status: () => reply.status,
              headers: () =>
                reply.location ? { location: reply.location } : {},
            })
          },
          post(path: string, options: { headers: Record<string, string> }) {
            calls.push(`POST ${path} ${JSON.stringify(options.headers)}`)
            return Promise.resolve({ status: () => 302, headers: () => ({}) })
          },
          delete() {
            throw new Error("not this protocol")
          },
          storageState: () =>
            Promise.resolve({
              cookies: [{ name: "CSRF", value: "a%2Fb" }],
              origins: [],
            }),
          dispose: () => Promise.resolve(),
        })
      },
    }
    return { api: api as unknown as APIRequest, calls }
  }

  test("revokes, then proves the original state is dead", async () => {
    const { api, calls } = fakeApi([
      { status: 200 },
      { status: 200 },
      { status: 302, location: "/login?next=/" },
    ])
    expect(
      await revokeSession(api, "http://localhost:4101", STATE, PROTOCOL),
    ).toEqual({
      revoked: true,
      detail: "POST /logout -> 302",
    })
    expect(calls).toEqual([
      "GET /",
      "GET /",
      'POST /logout {"X-CSRF":"a/b"}',
      "GET /",
    ])
  })

  test("already signed out; still valid; never throws", async () => {
    expect(
      await revokeSession(
        fakeApi([{ status: 302, location: "/login" }]).api,
        "http://x",
        STATE,
        PROTOCOL,
      ),
    ).toEqual({ revoked: true, detail: "already signed out" })
    expect(
      await revokeSession(
        fakeApi([{ status: 200 }, { status: 200 }, { status: 200 }]).api,
        "http://x",
        STATE,
        PROTOCOL,
      ),
    ).toEqual({
      revoked: false,
      detail: "POST /logout -> 302, session still valid",
    })
    expect(
      await revokeSession(fakeApi([], true).api, "http://x", STATE, PROTOCOL),
    ).toEqual({
      revoked: false,
      detail: "TypeError",
    })
  })

  test("signed out = a 401 or a redirect to exactly the sign-in path", () => {
    const out = signedOutBy("/login")
    expect(out({ status: 401 })).toBe(true)
    expect(out({ status: 302, location: "http://h/login" })).toBe(true)
    expect(out({ status: 302, location: "/login/x" })).toBe(false)
    expect(out({ status: 302 })).toBe(false)
    expect(out({ status: 200 })).toBe(false)
    expect(safePath("https://h/p?token=secret")).toBe("/p")
    expect(safePath("nope")).toBe("(unknown)")
  })
})

test.describe("keepalive", () => {
  const start = Date.UTC(2026, 9, 14, 10, 12)

  test("the deadline: the run's stamp + 2 h, the override, PWDEBUG", () => {
    expect(keepaliveDeadline("loc-20261014-1012-1d58", {}, 0).deadline).toBe(
      start + KEEPALIVE_MAX_MS,
    )
    expect(keepaliveDeadline("custom", {}, 5).deadline).toBe(
      5 + KEEPALIVE_MAX_MS,
    )
    expect(
      keepaliveDeadline(
        "loc-20261014-1012-1d58",
        { FLOWREEL_KEEPALIVE_MAX_MIN: "240" },
        0,
      ).deadline,
    ).toBe(start + 240 * 60_000)
    expect(() =>
      keepaliveDeadline("x", { FLOWREEL_KEEPALIVE_MAX_MIN: "14" }, 0),
    ).toThrow(
      'FLOWREEL_KEEPALIVE_MAX_MIN must be a whole number of minutes from 15 to 480 (got "14").',
    )
    // A project ceiling (maxMinutes) lowers the accepted range, never raises it.
    expect(
      keepaliveDeadline(
        "loc-20261014-1012-1d58",
        { FLOWREEL_KEEPALIVE_MAX_MIN: "90" },
        0,
        { maxMinutes: 90 },
      ).deadline,
    ).toBe(start + 90 * 60_000)
    expect(() =>
      keepaliveDeadline("x", { FLOWREEL_KEEPALIVE_MAX_MIN: "91" }, 0, {
        maxMinutes: 90,
      }),
    ).toThrow(
      'FLOWREEL_KEEPALIVE_MAX_MIN must be a whole number of minutes from 15 to 90 (got "91").',
    )
    expect(
      keepaliveDeadline("loc-20261014-1012-1d58", {}, 0, { maxMinutes: 60 })
        .deadline,
    ).toBe(start + 60 * 60_000)
    for (const bad of [14, 481, 1.5]) {
      expect(() => keepaliveDeadline("x", {}, 0, { maxMinutes: bad })).toThrow(
        /keepalive maxMinutes must be a whole number of minutes from 15 to 480/,
      )
    }
    expect(
      keepaliveDeadline("x", { PWDEBUG: "1" }, 0, { idleMinutes: 30 }),
    ).toEqual({
      deadline: null,
      why: "off under the Playwright inspector (PWDEBUG): an idle debugging session is signed out after 30 minutes as usual",
    })
  })

  test("pings live sessions; a signed-out one is reported once; stops at the deadline", async () => {
    let now = start
    const pinged: string[] = []
    const lines: string[] = []
    const answers: Record<string, { status: number; location?: string }> = {
      a: { status: 200 },
      b: { status: 302, location: "/login" },
    }
    const keepalive = new SessionKeepalive(
      ["a", "b"],
      (p) => {
        pinged.push(p)
        return Promise.resolve(answers[p])
      },
      {
        isSignedOut: signedOutBy("/login"),
        log: (l) => lines.push(l),
        deadline: start + 10 * 60_000,
        now: () => now,
        logPrefix: "app",
        signedOutReference: "runbook 3",
      },
    )
    await keepalive.tick()
    now += 5 * 60_000
    await keepalive.tick()
    now += 5 * 60_000
    await keepalive.tick()
    await keepalive.tick()
    expect(pinged).toEqual(["a", "b", "a"])
    expect(keepalive.signedOut).toEqual(["b"])
    expect(keepalive.stopped).toBe(true)
    expect(lines).toEqual([
      "[app] keepalive: the b session is already signed out (HTTP 302); it is not signed in again (runbook 3).",
      `[app] keepalive: stopped at its deadline (${new Date(start + 10 * 60_000).toISOString()}); the sessions now follow the app's 15-minute idle sign-out.`,
    ])
  })

  test("a failed request never throws; start/stop drive the timer", async () => {
    const lines: string[] = []
    let fn: (() => void) | null = null
    let cleared = false
    const keepalive = new SessionKeepalive(
      ["a"],
      () => Promise.reject(new Error("socket\nmore")),
      { isSignedOut: () => false, log: (l) => lines.push(l) },
    )
    const stop = keepalive.start(1000, {
      setInterval: (f) => {
        fn = f
        return 1
      },
      clearInterval: () => {
        cleared = true
      },
    })
    fn!()
    await stop()
    expect(cleared).toBe(true)
    expect(lines[0]).toBe(
      "[flowreel] keepalive: a request failed (socket); trying again on the next tick.",
    )
  })
})

test.describe("sign in once, sign out every session", () => {
  const personas = {
    agent: { email: "a@example.test", password: "x" },
    admin: { email: "a@example.test", password: "x" },
    customer: { email: "a@example.test", password: "x" },
    other: null,
  } as const
  type Key = keyof typeof personas

  function adapter(log: string[]): AppAdapter<Key> {
    return {
      signIn: (ctx, key) => {
        log.push(`sign in ${key} ${ctx.browser ? "browser" : "seam"}`)
        return Promise.resolve({
          cookies: [],
          origins: [{ origin: key, localStorage: [] }],
        })
      },
      sessionKind: (key) => (key === "customer" ? "portal" : "staff"),
      signOut: (_api, _url, state) => {
        log.push(`sign out ${state.origins[0].origin}`)
        return Promise.resolve(
          state.origins[0].origin === "customer"
            ? { revoked: false, detail: "HTTP 500" }
            : { revoked: true, detail: "POST /logout -> 302" },
        )
      },
      isSignedOut: () => false,
    }
  }

  test("one session per email and kind; unconfigured personas cleared", async () => {
    const log: string[] = []
    const env: Record<string, string | undefined> = {
      FLOWREEL_STATE_OTHER: "stale",
    }
    let closed = false
    const count = await signInAll(
      {
        target: "staging",
        baseURL: "https://qa.example.org",
        keys: ["agent", "admin", "customer", "other"],
        persona: (k) => personas[k],
      },
      adapter(log),
      {
        api: {} as APIRequest,
        env,
        launchBrowser: () =>
          Promise.resolve({
            close: () => ((closed = true), Promise.resolve()),
          } as unknown as Browser),
      },
    )
    expect(count).toBe(2)
    expect(log).toEqual(["sign in agent browser", "sign in customer browser"])
    expect(closed).toBe(true)
    expect(env.FLOWREEL_STATE_ADMIN).toBe(env.FLOWREEL_STATE_AGENT)
    expect(env.FLOWREEL_STATE_CUSTOMER).not.toBe(env.FLOWREEL_STATE_AGENT)
    expect("FLOWREEL_STATE_OTHER" in env).toBe(false)

    const lines: string[] = []
    const warnings: string[] = []
    const results = await signOutAll(
      {
        target: "staging",
        baseURL: "https://qa.example.org",
        keys: ["agent", "admin", "customer", "other"],
      },
      adapter(log),
      {
        api: {} as APIRequest,
        env,
        log: (l) => lines.push(l),
        warn: (l) => warnings.push(l),
      },
    )
    expect(results.map((r) => r.persona)).toEqual(["agent", "customer"])
    expect(lines).toEqual([
      "[flowreel] signed out the agent persona (POST /logout -> 302).",
    ])
    expect(warnings[0]).toContain(
      "could not sign out the customer persona (HTTP 500). Its session cookie is in this run's traces and HTML report: sign that account out on staging",
    )
  })

  test("locally no browser is launched", async () => {
    const log: string[] = []
    await signInAll(
      {
        target: "local",
        baseURL: "http://localhost:4101",
        keys: ["agent"],
        persona: (k) => personas[k],
      },
      adapter(log),
      {
        api: {} as APIRequest,
        env: {},
        launchBrowser: () => {
          throw new Error("no browser locally")
        },
      },
    )
    expect(log).toEqual(["sign in agent seam"])
  })
})

test.describe("persona APIs", () => {
  test("lazy contexts per persona, a client per persona, unconfigured fails fast", async () => {
    const opened: string[] = []
    const disposed: string[] = []
    const apis = createPersonaApis<
      "a" | "b",
      { get: APIRequestContext["get"] }
    >({
      api: {
        newContext: (options) => {
          const who = JSON.stringify(options?.storageState)
          opened.push(who)
          return Promise.resolve({
            get: (path: string) => Promise.resolve(`${who} ${path}`),
            dispose: () => (disposed.push(who), Promise.resolve()),
          } as unknown as APIRequestContext)
        },
      },
      baseURL: "http://localhost:4101",
      stateFor: (p) => {
        if (p === "b") throw new ConfigError("b is not configured")
        return { cookies: [], origins: [] }
      },
      client: (context) => ({ get: (...args) => context.get(...args) }),
    })
    const client = apis.as("a")
    expect(apis.as("a")).toBe(client)
    expect(opened).toEqual([])
    expect(await client.get("/x")).toBe('{"cookies":[],"origins":[]} /x')
    await client.get("/y")
    expect(opened).toHaveLength(1)
    expect(() => apis.as("b")).toThrow("b is not configured")
    await apis.dispose()
    expect(disposed).toHaveLength(1)
  })
})

test.describe("never retry, never repeat", () => {
  function config(
    ...projects: { name?: string; retries: number; repeatEach: number }[]
  ): FullConfig {
    return {
      projects: projects.map((p) => ({ name: "", ...p })),
    } as unknown as FullConfig
  }

  test("a single pass of every project is allowed", () => {
    expect(() =>
      refuseRepeats(config({ name: "smoke", retries: 0, repeatEach: 1 })),
    ).not.toThrow()
    expect(() => refuseRepeats(undefined)).not.toThrow()
  })

  test("--retries on the command line is refused", () => {
    expect(() =>
      refuseRepeats(
        config(
          { name: "smoke", retries: 0, repeatEach: 1 },
          { name: "tour", retries: 2, repeatEach: 1 },
        ),
      ),
    ).toThrow(ConfigError)
    expect(() =>
      refuseRepeats(config({ name: "tour", retries: 2, repeatEach: 1 })),
    ).toThrow(/project "tour" has retries: 2/)
  })

  test("--repeat-each on the command line is refused", () => {
    expect(() => refuseRepeats(config({ retries: 0, repeatEach: 3 }))).toThrow(
      /a project has repeatEach: 3/,
    )
  })

  test("global setup refuses before it loads the run or signs anyone in", async () => {
    const setup = createGlobalSetup<"user">({
      load: () => {
        throw new Error("load must not run")
      },
      adapter: {} as AppAdapter<"user">,
    })
    await expect(
      setup(config({ name: "smoke", retries: 1, repeatEach: 1 })),
    ).rejects.toThrow(ConfigError)
  })
})
