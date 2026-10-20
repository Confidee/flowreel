// SPDX-License-Identifier: Apache-2.0

import type { APIRequest, Browser, FullConfig } from "@playwright/test"
import { expect, test } from "@playwright/test"

import { resetRunLifecycle } from "../src/app/lifecycle.js"
import {
  type AppAdapter,
  type SessionProtocol,
  SessionKeepalive,
  createGlobalSetup,
  createGlobalTeardown,
  distinctSessions,
  keepaliveDeadline,
  personaOf,
  refuseRepeats,
  revokeSession,
  signInAll,
  signOutAll,
  signedOutBy,
} from "../src/app/index.js"

// The edges of the app module that app.spec.ts leaves out: the defaults
// (process.env, console, prefix), the browser lifecycle of sign-in, the
// global hooks, and the less common session protocols.

const STATE = { cookies: [], origins: [] }

// The global hooks register their sign-out on a process-wide lifecycle: a
// test file that runs next in this worker must not inherit it.
test.afterEach(() => resetRunLifecycle())

function withEnv(set: Record<string, string>, body: () => Promise<void>) {
  return async () => {
    const before: Record<string, string | undefined> = {}
    for (const [key, value] of Object.entries(set)) {
      before[key] = process.env[key]
      process.env[key] = value
    }
    try {
      await body()
    } finally {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }
}

function captureConsole() {
  const lines: { log: string[]; warn: string[] } = { log: [], warn: [] }
  const log = console.log
  const warn = console.warn
  console.log = (line: string) => lines.log.push(String(line))
  console.warn = (line: string) => lines.warn.push(String(line))
  return {
    lines,
    restore() {
      console.log = log
      console.warn = warn
    },
  }
}

test.describe("personas", () => {
  test("a configured persona is returned as is", () => {
    const agent = { email: "a@example.test", password: "x" }
    expect(personaOf<"agent">({ agent }, "agent")).toBe(agent)
  })

  test("distinctSessions reads process.env and the project's prefix by default", () => {
    process.env.FLOWREEL_STATE_ZED = "s"
    try {
      expect(distinctSessions(["zed", "none"])).toEqual(["zed"])
    } finally {
      delete process.env.FLOWREEL_STATE_ZED
    }
    expect(
      distinctSessions(["a", "b"], { APP_A: "1", APP_B: "1" }, "APP_"),
    ).toEqual(["a"])
  })
})

test.describe("session protocol edges", () => {
  function recordingApi(options: {
    cookies?: { name: string; value: string }[]
    probes: { status: number; location?: string }[]
  }) {
    const calls: string[] = []
    const api = {
      newContext: () =>
        Promise.resolve({
          get(path: string) {
            calls.push(`GET ${path}`)
            const reply = options.probes.shift() ?? { status: 200 }
            return Promise.resolve({
              status: () => reply.status,
              headers: () =>
                reply.location ? { location: reply.location } : {},
            })
          },
          post(path: string, o: { headers: Record<string, string> }) {
            calls.push(`POST ${path} ${JSON.stringify(o.headers)}`)
            return Promise.resolve({ status: () => 204 })
          },
          delete(path: string, o: { headers: Record<string, string> }) {
            calls.push(`DELETE ${path} ${JSON.stringify(o.headers)}`)
            return Promise.resolve({ status: () => 204 })
          },
          storageState: () =>
            Promise.resolve({ cookies: options.cookies ?? [], origins: [] }),
          dispose: () => Promise.resolve(),
        }),
    }
    return { api: api as unknown as APIRequest, calls }
  }

  test("DELETE sign-out on a custom probe path, no CSRF configured", async () => {
    const protocol: SessionProtocol = {
      probePath: "/home",
      isSignInPath: (p) => p === "/sign-in",
      signOut: { method: "DELETE", path: "/session" },
    }
    const { api, calls } = recordingApi({
      probes: [
        { status: 200 },
        { status: 200 },
        { status: 303, location: "/sign-in" },
      ],
    })
    expect(await revokeSession(api, "http://h", STATE, protocol)).toEqual({
      revoked: true,
      detail: "DELETE /session -> 204",
    })
    expect(calls).toEqual([
      "GET /home",
      "GET /home",
      "DELETE /session {}",
      "GET /home",
    ])
  })

  test("a missing CSRF cookie sends no header", async () => {
    const protocol: SessionProtocol = {
      isSignInPath: (p) => p === "/login",
      signOut: { method: "POST", path: "/logout" },
      csrf: { cookie: "CSRF", header: "X-CSRF" },
    }
    const { api, calls } = recordingApi({
      cookies: [{ name: "other", value: "v" }],
      probes: [
        { status: 200 },
        { status: 200 },
        { status: 302, location: "/login" },
      ],
    })
    const result = await revokeSession(api, "http://h", STATE, protocol)
    expect(result.revoked).toBe(true)
    expect(calls).toContain("POST /logout {}")
  })

  test("a malformed Location is not a sign-in redirect", () => {
    expect(
      signedOutBy("/login")({ status: 302, location: "http://[bad" }),
    ).toBe(false)
  })
})

test.describe("keepalive messages", () => {
  test("the PWDEBUG line defaults to a 15 minute idle sign-out", () => {
    expect(keepaliveDeadline("x", { PWDEBUG: "1" }, 0).why).toContain(
      "signed out after 15 minutes as usual",
    )
  })

  test("a custom idle window is named at the deadline; a thrown non-Error is logged", async () => {
    let now = 0
    const lines: string[] = []
    const keepalive = new SessionKeepalive(
      ["a"],
      () => Promise.reject("plain string"),
      {
        isSignedOut: () => false,
        log: (l) => lines.push(l),
        deadline: 100,
        now: () => now,
        idleMinutes: 30,
      },
    )
    await keepalive.tick()
    now = 100
    await keepalive.tick()
    expect(lines[0]).toBe(
      "[flowreel] keepalive: a request failed (plain string); trying again on the next tick.",
    )
    expect(lines[1]).toContain("follow the app's 30-minute idle sign-out")
  })

  test("a signed-out session without a reference reads plainly", async () => {
    const lines: string[] = []
    const keepalive = new SessionKeepalive(
      ["a"],
      () => Promise.resolve({ status: 401 }),
      { isSignedOut: signedOutBy("/login"), log: (l) => lines.push(l) },
    )
    await keepalive.tick()
    expect(lines).toEqual([
      "[flowreel] keepalive: the a session is already signed out (HTTP 401); it is not signed in again.",
    ])
  })
})

test.describe("signInAll defaults and the browser lifecycle", () => {
  const run = (target: "local" | "staging") => ({
    target,
    baseURL: "http://h",
    keys: ["agent", "ghost"] as const,
    persona: (key: "agent" | "ghost") =>
      key === "agent" ? { email: "a@example.test", password: "x" } : null,
  })
  const api = {} as APIRequest

  test(
    "writes to process.env under the default prefix and deletes an unconfigured persona",
    withEnv({ FLOWREEL_STATE_GHOST: "stale" }, async () => {
      const adapter: AppAdapter<"agent" | "ghost"> = {
        signIn: () => Promise.resolve(STATE),
        signOut: () => Promise.resolve({ revoked: true, detail: "" }),
        isSignedOut: () => false,
      }
      let launched = 0
      const count = await signInAll(run("local"), adapter, {
        api,
        launchBrowser: () => {
          launched++
          return Promise.reject(new Error("no browser expected"))
        },
      })
      try {
        expect(count).toBe(1)
        expect(launched).toBe(0)
        expect(process.env.FLOWREEL_STATE_AGENT).toBe(JSON.stringify(STATE))
        expect(process.env.FLOWREEL_STATE_GHOST).toBeUndefined()
      } finally {
        delete process.env.FLOWREEL_STATE_AGENT
      }
    }),
  )

  test("staging launches a browser by default and closes it even when sign-in throws", async () => {
    let closed = 0
    const seen: unknown[] = []
    const browser = { close: () => ++closed } as unknown as Browser
    const adapter: AppAdapter<"agent" | "ghost"> = {
      signIn: (ctx) => {
        seen.push(ctx.browser)
        return Promise.reject(new Error("locked out"))
      },
      signOut: () => Promise.resolve({ revoked: true, detail: "" }),
      isSignedOut: () => false,
    }
    await expect(
      signInAll(run("staging"), adapter, {
        api,
        launchBrowser: () => Promise.resolve(browser),
        env: {},
      }),
    ).rejects.toThrow("locked out")
    expect(seen).toEqual([browser])
    expect(closed).toBe(1)
  })

  test("needsBrowser can override the target default", async () => {
    let launched = 0
    const adapter: AppAdapter<"agent" | "ghost"> = {
      signIn: () => Promise.resolve(STATE),
      needsBrowser: () => false,
      signOut: () => Promise.resolve({ revoked: true, detail: "" }),
      isSignedOut: () => false,
    }
    await signInAll(run("staging"), adapter, {
      api,
      launchBrowser: () => {
        launched++
        return Promise.reject(new Error("unexpected"))
      },
      env: {},
    })
    expect(launched).toBe(0)
  })
})

test.describe("signOutAll defaults", () => {
  test("uses process.env, the console and the default prefix; warns with the shareable file", async () => {
    process.env.FLOWREEL_STATE_AGENT = JSON.stringify({
      cookies: [],
      origins: [{ origin: "a", localStorage: [] }],
    })
    process.env.FLOWREEL_STATE_ADMIN = JSON.stringify({
      cookies: [],
      origins: [{ origin: "b", localStorage: [] }],
    })
    const capture = captureConsole()
    try {
      const results = await signOutAll(
        { target: "staging", baseURL: "http://h", keys: ["agent", "admin"] },
        {
          signOut: (_api, _url, state) =>
            Promise.resolve(
              state.origins[0].origin === "a"
                ? { revoked: true, detail: "POST /logout -> 302" }
                : { revoked: false, detail: "TypeError" },
            ),
        },
        { api: {} as APIRequest },
      )
      expect(results.map((r) => [r.persona, r.revoked])).toEqual([
        ["agent", true],
        ["admin", false],
      ])
    } finally {
      capture.restore()
      delete process.env.FLOWREEL_STATE_AGENT
      delete process.env.FLOWREEL_STATE_ADMIN
    }
    expect(capture.lines.log).toEqual([
      "[flowreel] signed out the agent persona (POST /logout -> 302).",
    ])
    expect(capture.lines.warn).toHaveLength(1)
    expect(capture.lines.warn[0]).toContain(
      "[flowreel] WARNING: could not sign out the admin persona (TypeError).",
    )
    expect(capture.lines.warn[0]).toContain("sharing anything but summary.md.")
  })
})

test.describe("refuseRepeats", () => {
  test("accepts no config and clean projects; names an unnamed project", () => {
    expect(() => refuseRepeats(undefined)).not.toThrow()
    expect(() =>
      refuseRepeats({
        projects: [{ name: "a", retries: 0, repeatEach: 1 }],
      } as unknown as FullConfig),
    ).not.toThrow()
    expect(() =>
      refuseRepeats({
        projects: [{ name: "", retries: 2, repeatEach: 1 }],
      } as unknown as FullConfig),
    ).toThrow(/^flowreel never retries a test \(a project has retries: 2\)/)
    expect(() =>
      refuseRepeats({
        projects: [{ name: "web", retries: 0, repeatEach: 3 }],
      } as unknown as FullConfig),
    ).toThrow(/project "web" has repeatEach: 3/)
  })
})

test.describe("global hooks", () => {
  function hooks(
    events: string[],
    target: "local" | "staging",
    module?: string,
  ) {
    const adapter: AppAdapter<"agent"> = {
      signIn: (_ctx, key) => {
        events.push(`sign in ${key}`)
        return Promise.resolve({
          cookies: [],
          origins: [{ origin: key, localStorage: [] }],
        })
      },
      needsBrowser: () => false,
      prepareLocal: () => {
        events.push("prepare local")
      },
      signOut: (_api, _url, state) => {
        events.push(`sign out ${state.origins[0].origin}`)
        return Promise.resolve({ revoked: true, detail: "ok" })
      },
      isSignedOut: () => false,
    }
    return {
      load: () => ({
        target,
        baseURL: "http://h",
        keys: ["agent"] as const,
        persona: () => ({ email: "a@example.test", password: "x" }),
        module,
      }),
      adapter,
      prefix: "HOOKTEST_",
      logPrefix: "hk",
    }
  }

  test(
    "setup refuses repeats, prepares the local stage, signs in and logs the run",
    withEnv({ FLOWREEL_RUN_ID: "loc-1" }, async () => {
      const events: string[] = []
      const capture = captureConsole()
      try {
        await createGlobalSetup(hooks(events, "local", "tour"))()
        await createGlobalSetup(hooks(events, "staging"))({
          projects: [],
        } as unknown as FullConfig)
        await expect(
          createGlobalSetup(hooks(events, "local"))({
            projects: [{ name: "p", retries: 1, repeatEach: 1 }],
          } as unknown as FullConfig),
        ).rejects.toThrow(/never retries/)
      } finally {
        capture.restore()
        delete process.env.HOOKTEST_AGENT
      }
      expect(events).toEqual([
        "prepare local",
        "sign in agent",
        "sign in agent",
      ])
      expect(capture.lines.log).toEqual([
        "[hk] local (tour): signed in 1 persona(s) for run loc-1.",
        "[hk] staging: signed in 1 persona(s) for run loc-1.",
      ])
    }),
  )

  test("setup says so when there is no run id; teardown signs the session out", async () => {
    const saved = process.env.FLOWREEL_RUN_ID
    delete process.env.FLOWREEL_RUN_ID
    const events: string[] = []
    const capture = captureConsole()
    try {
      await createGlobalSetup(hooks(events, "local"))()
      await createGlobalTeardown(hooks(events, "local"))()
    } finally {
      capture.restore()
      delete process.env.HOOKTEST_AGENT
      if (saved !== undefined) process.env.FLOWREEL_RUN_ID = saved
    }
    expect(capture.lines.log).toEqual([
      "[hk] local: signed in 1 persona(s) for run (no run id).",
      "[hk] signed out the agent persona (ok).",
    ])
    expect(events).toEqual(["prepare local", "sign in agent", "sign out agent"])
  })
})

test.describe("custom wording", () => {
  test("signOutAll names the project's shareable file; setup and teardown use the default log prefix", async () => {
    const warns: string[] = []
    await signOutAll(
      { target: "staging", baseURL: "http://h", keys: ["agent"] },
      {
        signOut: () => Promise.resolve({ revoked: false, detail: "HTTP 500" }),
      },
      {
        api: {} as APIRequest,
        env: { FLOWREEL_STATE_AGENT: JSON.stringify(STATE) },
        shareable: "report.md",
        log: () => undefined,
        warn: (l) => warns.push(l),
      },
    )
    expect(warns[0]).toContain("before sharing anything but report.md.")
  })

  test(
    "the global hooks log under [flowreel] when the project names no prefix",
    withEnv({ FLOWREEL_RUN_ID: "loc-2" }, async () => {
      const adapter: AppAdapter<"agent"> = {
        signIn: () => Promise.resolve(STATE),
        needsBrowser: () => false,
        signOut: () => Promise.resolve({ revoked: true, detail: "ok" }),
        isSignedOut: () => false,
      }
      const options = {
        load: () => ({
          target: "staging" as const,
          baseURL: "http://h",
          keys: ["agent"] as const,
          persona: () => ({ email: "a@example.test", password: "x" }),
        }),
        adapter,
        prefix: "PLAINHOOK_",
      }
      const capture = captureConsole()
      try {
        await createGlobalSetup(options)()
        await createGlobalTeardown(options)()
      } finally {
        capture.restore()
        delete process.env.PLAINHOOK_AGENT
      }
      expect(capture.lines.log).toEqual([
        "[flowreel] staging: signed in 1 persona(s) for run loc-2.",
        "[flowreel] signed out the agent persona (ok).",
      ])
    }),
  )
})

test.describe("global setup details", () => {
  test(
    "an adapter without prepareLocal is fine locally; a browser-needing adapter gets the launched browser, closed afterwards",
    withEnv({ FLOWREEL_RUN_ID: "loc-3" }, async () => {
      let closed = 0
      const browser = { close: () => ++closed } as unknown as Browser
      const seen: unknown[] = []
      const adapter: AppAdapter<"agent"> = {
        signIn: (ctx) => {
          seen.push(ctx.browser)
          return Promise.resolve(STATE)
        },
        needsBrowser: () => true,
        signOut: () => Promise.resolve({ revoked: true, detail: "ok" }),
        isSignedOut: () => false,
      }
      const capture = captureConsole()
      try {
        await createGlobalSetup({
          load: () => ({
            target: "local" as const,
            baseURL: "http://h",
            keys: ["agent"] as const,
            persona: () => ({ email: "a@example.test", password: "x" }),
          }),
          adapter,
          prefix: "BROWSERHOOK_",
          launchBrowser: () => Promise.resolve(browser),
        })()
      } finally {
        capture.restore()
        delete process.env.BROWSERHOOK_AGENT
      }
      expect(seen).toEqual([browser])
      expect(closed).toBe(1)
    }),
  )
})
