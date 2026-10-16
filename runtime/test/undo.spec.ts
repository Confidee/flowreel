// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "@playwright/test"

import {
  UNDO_JSON,
  UNDO_MD,
  type UndoFile,
  UndoLedger,
  type UndoStore,
  fileUndoStore,
  summarizeUndo,
  undoMarkdown,
} from "../src/core/undo.js"

// Undo ledger: write-ahead, LIFO
// restores, a failed restore recorded (never thrown), early restoreNow, the
// per-feature flush and the worker-level safety net.

function memoryStore(): UndoStore & { file: UndoFile; writes: number } {
  const store = {
    file: { runId: "loc-1", entries: [] } as UndoFile,
    writes: 0,
    read: () => structuredClone(store.file),
    write: (file: UndoFile) => {
      store.writes += 1
      store.file = structuredClone(file)
    },
  }
  return store
}

const change = (what: string, restore: () => Promise<void>) => ({
  what,
  before: { what },
  manual: `put ${what} back by hand`,
  restore,
})

test("change() writes the entry BEFORE returning (write-ahead), status pending", async () => {
  const store = memoryStore()
  const ledger = new UndoLedger(store, () => ({}))
  let restored = false
  await ledger.change(
    "E2",
    change("default group", async () => {
      await Promise.resolve()
      restored = true
    }),
  )
  expect(store.writes).toBe(1)
  expect(store.file.entries).toMatchObject([
    {
      seq: 1,
      feature: "E2",
      what: "default group",
      status: "pending",
      manual: "put default group back by hand",
    },
  ])
  expect(restored).toBe(false)
})

test("flush restores LIFO and records each outcome", async () => {
  const store = memoryStore()
  const order: string[] = []
  const ledger = new UndoLedger(store, () => ({}))
  for (const what of ["first", "second", "third"]) {
    await ledger.change(
      "E4",
      change(what, async () => {
        await Promise.resolve()
        order.push(what)
      }),
    )
  }
  expect(await ledger.flush()).toBe(0)
  expect(order).toEqual(["third", "second", "first"])
  expect(store.file.entries.map((e) => e.status)).toEqual([
    "restored",
    "restored",
    "restored",
  ])
  expect(summarizeUndo(store.file)).toMatchObject({
    total: 3,
    restored: 3,
    manual: [],
  })
})

test("a failed restore is recorded FAILED with its error, the rest still run, and flush never throws", async () => {
  const store = memoryStore()
  const order: string[] = []
  const ledger = new UndoLedger(store, () => ({}))
  await ledger.change(
    "F5",
    change("pause", async () => {
      await Promise.resolve()
      order.push("pause")
    }),
  )
  await ledger.change(
    "F5",
    change("allowlist", async () => {
      await Promise.resolve()
      throw new Error("HTTP 500 from /admin/health\nstack…")
    }),
  )
  expect(await ledger.flush()).toBe(1)
  expect(order).toEqual(["pause"])
  const failed = store.file.entries.find((e) => e.what === "allowlist")!
  expect(failed).toMatchObject({
    status: "FAILED",
    error: "HTTP 500 from /admin/health",
  })
  const summary = summarizeUndo(store.file)
  expect(summary).toMatchObject({ failed: 1, restored: 1 })
  expect(summary.manual.map((e) => e.what)).toEqual(["allowlist"])
})

test("flush(feature) restores only that feature; restoreNow is early and idempotent", async () => {
  const store = memoryStore()
  const calls: string[] = []
  const ledger = new UndoLedger(store, () => ({}))
  const early = await ledger.change(
    "E2",
    change("default", async () => {
      await Promise.resolve()
      calls.push("default")
    }),
  )
  await ledger.change(
    "E7",
    change("form", async () => {
      await Promise.resolve()
      calls.push("form")
    }),
  )
  await early.restoreNow()
  await early.restoreNow()
  expect(calls).toEqual(["default"])
  expect(await ledger.flush("E2")).toBe(0)
  expect(calls).toEqual(["default"])
  await ledger.flush()
  expect(calls).toEqual(["default", "form"])
})

test("restores receive the worker context, not the test's", async () => {
  const store = memoryStore()
  const ledger = new UndoLedger(store, () => ({ who: "worker" }))
  let seen: unknown = null
  await ledger.change("C9", {
    what: "light agent",
    before: true,
    manual: "x",
    restore: async (context) => {
      await Promise.resolve()
      seen = context
    },
  })
  await ledger.flush()
  expect(seen).toEqual({ who: "worker" })
})

test("an entry whose worker crashed stays pending: manual action, listed first in undo.md", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-undo-"))
  try {
    const crashed = new UndoLedger(fileUndoStore(dir, "stg-1"), () => ({}))
    await crashed.change(
      "E2",
      change("default group", () => Promise.resolve()),
    )
    // A new worker (or the reporter) sees the entry; it never got the closure.
    const next = new UndoLedger(fileUndoStore(dir, "stg-1"), () => ({}))
    expect(await next.flush()).toBe(0)
    const file = JSON.parse(
      readFileSync(join(dir, UNDO_JSON), "utf8"),
    ) as UndoFile
    expect(summarizeUndo(file)).toMatchObject({
      pending: 1,
      manual: [{ what: "default group" }],
    })
    const md = readFileSync(join(dir, UNDO_MD), "utf8")
    expect(md.indexOf("MANUAL ACTION NEEDED")).toBeGreaterThan(0)
    expect(md).toContain("put default group back by hand")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("undo.md says so when nothing changed or everything was restored", () => {
  expect(undoMarkdown({ runId: "r", entries: [] })).toContain(
    "No shared configuration was changed.",
  )
  expect(
    undoMarkdown({
      runId: "r",
      entries: [
        {
          id: "u1",
          seq: 1,
          feature: "E2",
          what: "x",
          before: null,
          manual: "m",
          status: "restored",
          error: null,
          recordedAt: "t",
          restoredAt: "t",
        },
      ],
    }),
  ).toContain("Every change was restored.")
})
