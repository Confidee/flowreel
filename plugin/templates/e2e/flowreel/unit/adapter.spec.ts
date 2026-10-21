import type { APIRequest } from "@playwright/test"
import { expect, test } from "@playwright/test"

import { REQUEST_TIMEOUT_MS, SESSION, appAdapter } from "../adapter"

// The adapter's requests are bounded and never pass a Playwright call log
// on (it names the session cookie). Over a fake request API: no server.
// Keep these true when you fill in the adapter's TODOs.

const COOKIE = "SESSION-COOKIE-VALUE"

/** A request API whose every request fails like Playwright's, call log included. */
function failingApi() {
  const contexts: { timeout?: unknown }[] = []
  const fail = () =>
    Promise.reject(
      new Error(
        `apiRequestContext.get: Timeout ${REQUEST_TIMEOUT_MS}ms exceeded.\nCall log:\n  - → GET http://127.0.0.1:3000/?token=QUERY\n    - cookie: _session=${COOKIE}\n`,
      ),
    )
  const api = {
    newContext: (options: { timeout?: unknown } = {}) => {
      contexts.push(options)
      return Promise.resolve({
        get: fail,
        post: fail,
        delete: fail,
        fetch: fail,
        storageState: () => Promise.resolve({ cookies: [], origins: [] }),
        dispose: () => Promise.resolve(),
      })
    },
  }
  return { api: api as unknown as APIRequest, contexts }
}

test("health(): bounded, and what it reports is the first line only", async () => {
  const { api, contexts } = failingApi()
  const problem = await appAdapter.health!(api, "http://127.0.0.1:3000")
  expect(contexts.length).toBeGreaterThan(0)
  for (const context of contexts) {
    expect(context.timeout).toBe(REQUEST_TIMEOUT_MS)
  }
  expect(problem).toContain(`Timeout ${REQUEST_TIMEOUT_MS}ms exceeded`)
  expect(problem).not.toContain("Call log")
  expect(problem).not.toContain(COOKIE)
  expect(problem).not.toContain("QUERY")
})

test("signOut(): bounded, never throws, never names the cookie", async () => {
  const { api, contexts } = failingApi()
  expect(SESSION.requestTimeoutMs).toBe(REQUEST_TIMEOUT_MS)
  const result = await appAdapter.signOut(api, "http://127.0.0.1:3000", {
    cookies: [],
    origins: [],
  })
  expect(result).toMatchObject({ revoked: false })
  expect(JSON.stringify(result)).not.toContain(COOKIE)
  for (const context of contexts) {
    expect(context.timeout).toBe(REQUEST_TIMEOUT_MS)
  }
})

test("a whole number of milliseconds, 30 s unless you need more", () => {
  expect(Number.isInteger(REQUEST_TIMEOUT_MS)).toBe(true)
  expect(REQUEST_TIMEOUT_MS).toBeGreaterThan(0)
})
