// SPDX-License-Identifier: Apache-2.0

import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

import { expect, test as base } from "@playwright/test"

import type { UndoFile, UndoStore } from "../src/core/undo.js"
import { InboundMailBudget, tourFixtures } from "../src/tour/index.js"

// The tour's session keepalive fixture: it pings each signed-in session
// once at start (answers decide who is signed out) and stays off under the
// Playwright inspector. The "app" is a loopback server answering a fixed
// redirect to the sign-in page; nothing leaves the machine.

const lines: string[] = []
const realLog = console.log
console.log = (line: unknown, ...rest: unknown[]) => {
  lines.push(String(line))
  realLog(line, ...rest)
}

const file: UndoFile = { runId: "loc-1", entries: [] }
const store: UndoStore = {
  read: () => structuredClone(file),
  write: () => undefined,
}
const budget = () =>
  new InboundMailBudget(
    { read: () => ({ count: 0, sends: [] }), write: () => undefined },
    "local",
  )
const STATE = JSON.stringify({ cookies: [], origins: [] })

function fixtures(
  env: Record<string, string>,
  baseURL: () => string,
  log: (line: string) => void,
) {
  return base.extend(
    tourFixtures<"a", { persona: string }>({
      personas: ["a"],
      baseURL,
      runId: () => "custom-run",
      pace: () => "qa",
      stateFor: () => ({ cookies: [], origins: [] }),
      client: (_context, persona) => ({ persona }),
      undoStore: () => store,
      inboundBudget: budget,
      featureKey: (info) => info.title,
      app: {
        isSignedOut: (answer) => answer.status === 302,
        keepalivePath: "/home",
      },
      keepalive: { logPrefix: "ka", signedOutReference: "runbook 7", log },
      env,
    }),
  )
}

const hits: string[] = []
const server = createServer((req, res) => {
  hits.push(req.url ?? "")
  res.writeHead(302, { location: "/login" })
  res.end()
})
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

const active = fixtures(
  { FLOWREEL_STATE_A: STATE },
  () => url,
  (l) => lines.push(l),
)

active.describe("with a live session", () => {
  active.afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  active(
    "pings the keepalive path once and reports the signed-out session",
    async ({ as }) => {
      expect(as("a")).toEqual({ persona: "a" })
      await expect
        .poll(() =>
          lines.some((l) => l.includes("the a session is already signed out")),
        )
        .toBe(true)
      expect(hits).toEqual(["/home"])
      expect(lines).toContain(
        "[ka] keepalive: the a session is already signed out (HTTP 302); it is not signed in again (runbook 7).",
      )
    },
  )
})

const inspector = fixtures(
  { PWDEBUG: "1", FLOWREEL_STATE_A: STATE },
  () => "http://127.0.0.1:1",
  (l) => lines.push(l),
)

inspector(
  "stays off under the Playwright inspector, and says so",
  ({ pace }) => {
    expect(pace).toBe("qa")
    expect(
      lines.some((l) =>
        l.startsWith(
          "[ka] keepalive: off under the Playwright inspector (PWDEBUG)",
        ),
      ),
    ).toBe(true)
    // Nothing was pinged for this fixture set (the loopback server is not even up).
    expect(hits).toEqual([])
  },
)

// Defaults: no keepalive wording, no keepalive path (so "/"), no env option.
const plainHits: string[] = []
const plainServer = createServer((req, res) => {
  plainHits.push(req.url ?? "")
  res.writeHead(200)
  res.end()
})
await new Promise<void>((resolve) =>
  plainServer.listen(0, "127.0.0.1", resolve),
)
const plainUrl = `http://127.0.0.1:${(plainServer.address() as AddressInfo).port}`

function plainFixtures(env?: Record<string, string>) {
  return base.extend(
    tourFixtures<"a", { persona: string }>({
      personas: ["a"],
      baseURL: () => plainUrl,
      runId: () => "custom-run",
      pace: () => "demo",
      stateFor: () => ({ cookies: [], origins: [] }),
      client: (_context, persona) => ({ persona }),
      undoStore: () => store,
      inboundBudget: budget,
      featureKey: (info) => info.title,
      app: { isSignedOut: () => false },
      ...(env ? { env } : {}),
    }),
  )
}

const plain = plainFixtures({ FLOWREEL_STATE_A: STATE })
plain(
  "pings '/' by default and logs nothing for a live session",
  async ({ as }) => {
    expect(as("a")).toEqual({ persona: "a" })
    await expect.poll(() => plainHits).toEqual(["/"])
  },
)

const plainInspector = plainFixtures({ PWDEBUG: "1" })
plainInspector(
  "under the inspector the default prefix is [flowreel]",
  ({ pace }) => {
    expect(pace).toBe("demo")
    expect(
      lines.some((l) =>
        l.startsWith(
          "[flowreel] keepalive: off under the Playwright inspector",
        ),
      ),
    ).toBe(true)
  },
)

// No env option: the worker's own process.env (no persona session in it).
const ambient = plainFixtures()
ambient("reads process.env when no env is given", ({ pace }) => {
  expect(pace).toBe("demo")
})
