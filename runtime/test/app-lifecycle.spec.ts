// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "@playwright/test"

import {
  resetRunLifecycle,
  runLifecycle,
  settleWithin,
  waitForRestores,
} from "../src/app/lifecycle.js"
import {
  type AppAdapter,
  createGlobalSetup,
  createGlobalTeardown,
} from "../src/app/index.js"

// A run stopped during its global setup: the teardown waits for sign-ins
// still in flight before signing out (a stop during sign-in used to leave
// that session live), records that it signed out, and the setup registers
// the sign-out the reporter's safety net runs. Plus the lifecycle helpers.

test.afterEach(() => resetRunLifecycle())

function capture() {
  const lines: string[] = []
  const log = console.log
  const warn = console.warn
  console.log = (line: string) => lines.push(String(line))
  console.warn = (line: string) => lines.push(String(line))
  return {
    lines,
    restore() {
      console.log = log
      console.warn = warn
    },
  }
}

/** A one-persona adapter whose sign-in waits for `gate`. */
function hooks(events: string[], gate: Promise<void>, prefix: string) {
  const adapter: AppAdapter<"agent"> = {
    signIn: async () => {
      events.push("sign in started")
      await gate
      events.push("signed in")
      return { cookies: [], origins: [{ origin: "agent", localStorage: [] }] }
    },
    needsBrowser: () => false,
    signOut: () => {
      events.push("sign out")
      return Promise.resolve({ revoked: true, detail: "ok" })
    },
    isSignedOut: () => false,
  }
  return {
    load: () => ({
      target: "staging" as const,
      baseURL: "http://h",
      keys: ["agent"] as const,
      persona: () => ({ email: "a@example.test", password: "x" }),
    }),
    adapter,
    prefix,
    logPrefix: "lc",
  }
}

test("the teardown waits for a sign-in still in flight, then signs that session out", async () => {
  const events: string[] = []
  let release: () => void = () => undefined
  const gate = new Promise<void>((r) => (release = r))
  const options = hooks(events, gate, "LIFECYCLE_A_")
  const out = capture()
  try {
    // Playwright runs the teardown while the interrupted setup still runs.
    const setup = createGlobalSetup(options)()
    await new Promise((r) => setTimeout(r, 10))
    expect(runLifecycle().setup).not.toBeNull()
    expect(runLifecycle().signOut).not.toBeNull()
    const teardown = createGlobalTeardown(options)()
    // Marked at once: a safety net from here on waits for this teardown.
    const marked = runLifecycle().signOutRun
    expect(marked).not.toBeNull()
    await new Promise((r) => setTimeout(r, 20))
    expect(events).toEqual(["sign in started"])
    release()
    await Promise.all([setup, teardown])
  } finally {
    out.restore()
    delete process.env.LIFECYCLE_A_AGENT
  }
  expect(events).toEqual(["sign in started", "signed in", "sign out"])
  expect(runLifecycle()).toMatchObject({ setup: null, signedOut: true })
  expect(await settleWithin(runLifecycle().signOutRun!, 10)).toBe(true)
})

test("a setup stuck past the wait: the teardown says so and signs out what exists", async () => {
  const events: string[] = []
  const options = hooks(events, new Promise(() => undefined), "LIFECYCLE_B_")
  const out = capture()
  try {
    void createGlobalSetup(options)()
    await new Promise((r) => setTimeout(r, 5))
    await createGlobalTeardown(options, 30)()
  } finally {
    out.restore()
  }
  // Nothing was handed over yet, so nothing to revoke.
  expect(events).toEqual(["sign in started"])
  expect(out.lines).toContain(
    "[lc] WARNING: the global setup was still signing in after 0 s; signing out the sessions made so far.",
  )
  expect(runLifecycle().signedOut).toBe(true)
})

test("a setup that fails still leaves its sign-out registered, and the teardown runs", async () => {
  const events: string[] = []
  const options = hooks(events, Promise.resolve(), "LIFECYCLE_C_")
  options.adapter.signIn = () => Promise.reject(new Error("locked"))
  const out = capture()
  try {
    await expect(createGlobalSetup(options)()).rejects.toThrow("locked")
    expect(runLifecycle()).toMatchObject({ setup: null, signedOut: false })
    await runLifecycle().signOut?.()
    await createGlobalTeardown(options)()
  } finally {
    out.restore()
  }
  expect(runLifecycle().signedOut).toBe(true)
})

test("the lifecycle is one per process, on a global symbol; reset forgets it", () => {
  const one = runLifecycle()
  expect(runLifecycle()).toBe(one)
  expect(
    (globalThis as Record<symbol, unknown>)[
      Symbol.for("flowreel.runLifecycle")
    ],
  ).toBe(one)
  resetRunLifecycle()
  expect(runLifecycle()).not.toBe(one)
})

test("settleWithin: true when it resolves or rejects in time, false otherwise", async () => {
  expect(await settleWithin(Promise.resolve(1), 50)).toBe(true)
  expect(await settleWithin(Promise.reject(new Error("x")), 50)).toBe(true)
  expect(await settleWithin(new Promise(() => undefined), 10)).toBe(false)
})

test.describe("waitForRestores", () => {
  const ledger = (status: string) =>
    JSON.stringify({ runId: "r1", entries: [{ id: "u1", seq: 1, status }] })

  test("no ledger, or an unreadable one: nothing to wait for", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flowreel-restores-"))
    try {
      expect(await waitForRestores(dir, "r1", 1000)).toBe(0)
      writeFileSync(join(dir, "undo.json"), "{broken")
      expect(await waitForRestores(dir, "r1", 1000)).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("waits until a pending restore is done; gives up after the wait or on a stop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flowreel-restores-"))
    try {
      writeFileSync(join(dir, "undo.json"), ledger("pending"))
      setTimeout(
        () => writeFileSync(join(dir, "undo.json"), ledger("restored")),
        60,
      )
      expect(await waitForRestores(dir, "r1", 5000, undefined, 10)).toBe(0)
      writeFileSync(join(dir, "undo.json"), ledger("pending"))
      expect(await waitForRestores(dir, "r1", 40, undefined, 10)).toBe(1)
      const stop = new AbortController()
      stop.abort()
      const started = Date.now()
      expect(await waitForRestores(dir, "r1", 5000, stop.signal)).toBe(1)
      expect(Date.now() - started).toBeLessThan(1000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
