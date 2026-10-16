// SPDX-License-Identifier: Apache-2.0

import { expect, test as base } from "@playwright/test"

import type { UndoFile, UndoStore } from "../src/core/undo.js"
import { InboundMailBudget, tourFixtures } from "../src/tour/index.js"

// tourFixtures() through Playwright's own fixture machinery: lazy persona
// clients, the feature's undo entries flushed at the test's end (newest
// first, failures recorded), the pace and the budget. No session is handed
// over here, so the keepalive pings nothing.

let file: UndoFile = { runId: "loc-1", entries: [] }
const store: UndoStore = {
  read: () => structuredClone(file),
  write: (next) => {
    file = structuredClone(next)
  },
}
const restored: string[] = []

const test = base.extend(
  tourFixtures<"a" | "b", { persona: string }>({
    personas: ["a", "b"],
    baseURL: () => "http://localhost:4101",
    runId: () => "loc-20261014-1200-abcd",
    pace: () => "qa",
    stateFor: (persona) => {
      if (persona === "b") throw new Error("b is not configured on this target")
      return { cookies: [], origins: [] }
    },
    client: (_context, persona) => ({ persona }),
    undoStore: () => store,
    inboundBudget: () =>
      new InboundMailBudget(
        { read: () => ({ count: 0, sends: [] }), write: () => undefined },
        "local",
      ),
    featureKey: (info) => info.title.split(" ")[0],
    app: { isSignedOut: () => false, keepalivePath: "/" },
    keepalive: { logPrefix: "spec" },
    env: {},
  }),
)

test.describe.configure({ mode: "serial" })

test("A1 clients, pace and budget", async ({
  as,
  pace,
  pause,
  inboundBudget,
}) => {
  expect(as("a")).toEqual({ persona: "a" })
  expect(as("a")).toBe(as("a"))
  expect(() => as("b")).toThrow("b is not configured on this target")
  expect(pace).toBe("qa")
  const started = Date.now()
  await pause()
  expect(Date.now() - started).toBeLessThan(100)
  expect(inboundBudget.consume("x")).toBe(1)
})

test("A2 records changes; the test's teardown restores them newest first", async ({
  undo,
}) => {
  await undo.change({
    what: "first",
    before: 1,
    manual: "put first back",
    restore: (context) => {
      restored.push(`first as ${context.as("a").persona}`)
      return Promise.resolve()
    },
  })
  const second = await undo.change({
    what: "second",
    before: 2,
    manual: "put second back",
    restore: () => Promise.reject(new Error("refused\nmore")),
  })
  expect(second.id).toMatch(/^u2-/)
  expect(file.entries.map((e) => e.status)).toEqual(["pending", "pending"])
})

test("A3 …and the outcomes were recorded", () => {
  expect(restored).toEqual(["first as a"])
  expect(
    file.entries.map((e) => [e.feature, e.what, e.status, e.error]),
  ).toEqual([
    ["A2", "first", "restored", null],
    ["A2", "second", "FAILED", "refused"],
  ])
})
