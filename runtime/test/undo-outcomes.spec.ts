// SPDX-License-Identifier: Apache-2.0

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
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

// The undo ledger's less travelled paths: outcomes recorded without a
// restore closure (off-camera cleanup), a store that cannot be written,
// unreadable or partial files, and how failures are worded. A failed
// restore must always end up on disk; nothing here may throw into a test.

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

const NOW = new Date(Date.UTC(2026, 9, 14, 12, 0, 0))
const clock = () => NOW

function tmp(): { dir: string; done(): void } {
  const dir = mkdtempSync(join(tmpdir(), "flowreel-undo-"))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

const record = { what: "Acme mailbox", before: { n: 1 }, manual: "close it" }

test.describe("recordOutcome", () => {
  test("a success with no earlier failure writes nothing", () => {
    const store = memoryStore()
    const ledger = new UndoLedger(store, () => ({}), clock)
    ledger.recordOutcome("F1", "mbox", record, null)
    expect(store.writes).toBe(0)
    expect(store.file.entries).toEqual([])
  })

  test("a failure is written FAILED under its key, once per key; the latest error wins", () => {
    const store = memoryStore()
    const ledger = new UndoLedger(store, () => ({}), clock)
    ledger.recordOutcome("F1", "mbox", record, "403 forbidden")
    ledger.recordOutcome("F1", "mbox", record, "500 boom")
    expect(store.file.entries).toHaveLength(1)
    expect(store.file.entries[0]).toMatchObject({
      id: "k:mbox",
      seq: 1,
      feature: "F1",
      what: "Acme mailbox",
      before: { n: 1 },
      manual: "close it",
      status: "FAILED",
      error: "500 boom",
      recordedAt: NOW.toISOString(),
    })
    expect(summarizeUndo(store.file)).toMatchObject({
      total: 1,
      failed: 1,
      restored: 0,
    })
  })

  test("a later success marks that entry restored and clears the error", () => {
    const store = memoryStore()
    const ledger = new UndoLedger(store, () => ({}), clock)
    ledger.recordOutcome("F1", "mbox", record, "403 forbidden")
    ledger.recordOutcome("F1", "mbox", record, null)
    expect(store.file.entries[0]).toMatchObject({
      status: "restored",
      error: null,
      restoredAt: NOW.toISOString(),
    })
    expect(summarizeUndo(store.file).manual).toEqual([])
  })

  test("sequence numbers continue after existing entries; a second key gets its own", async () => {
    const store = memoryStore()
    const ledger = new UndoLedger(store, () => ({}), clock)
    await ledger.change("F0", {
      what: "setting",
      before: 1,
      manual: "x",
      restore: () => Promise.resolve(),
    })
    ledger.recordOutcome("F1", "a", record, "e1")
    ledger.recordOutcome("F1", "b", record, "e2")
    expect(store.file.entries.map((e) => [e.id.slice(0, 2), e.seq])).toEqual([
      ["u1", 1],
      ["k:", 2],
      ["k:", 3],
    ])
    // flush only touches entries that hold a restore closure.
    expect(await ledger.flush()).toBe(0)
    expect(store.file.entries.map((e) => e.status)).toEqual([
      "restored",
      "FAILED",
      "FAILED",
    ])
  })
})

test.describe("write-ahead and failures", () => {
  test("if the entry cannot be written, change() fails and nothing is registered to restore", async () => {
    let writable = false
    const inner = memoryStore()
    const store: UndoStore = {
      read: () => inner.read(),
      write: (file) => {
        if (!writable) throw new Error("disk full")
        inner.write(file)
      },
    }
    const ledger = new UndoLedger(store, () => ({}), clock)
    let restored = 0
    // A rejected promise, as the signature says, never a synchronous throw.
    const pending = ledger.change("F1", {
      ...record,
      restore: () => {
        restored++
        return Promise.resolve()
      },
    })
    await expect(pending).rejects.toThrow("disk full")
    writable = true
    expect(await ledger.flush()).toBe(0)
    expect(restored).toBe(0)
    expect(inner.file.entries).toEqual([])
  })

  test("a restore whose entry vanished from the store records nothing and does not throw", async () => {
    const store = memoryStore()
    const ledger = new UndoLedger(store, () => ({}), clock)
    const handle = await ledger.change("F1", {
      ...record,
      restore: () => {
        store.file.entries = []
        return Promise.resolve()
      },
    })
    const writesBefore = store.writes
    await handle.restoreNow()
    expect(store.writes).toBe(writesBefore)
    expect(await ledger.flush()).toBe(0)
  })

  test("failure wording: a thrown string, a blank message, the first non-blank line, truncation", async () => {
    const store = memoryStore()
    const ledger = new UndoLedger(store, () => ({}), clock)
    const reject = (reason: unknown) => () => Promise.reject(reason)
    await ledger.change("F1", { ...record, restore: reject("plain text") })
    await ledger.change("F2", { ...record, restore: reject(new Error("  ")) })
    await ledger.change("F3", {
      ...record,
      restore: reject(new Error("\n\nsecond line\nthird")),
    })
    await ledger.change("F4", {
      ...record,
      restore: reject(new Error("x".repeat(400))),
    })
    expect(await ledger.flush()).toBe(4)
    const errors = Object.fromEntries(
      store.file.entries.map((e) => [e.feature, e.error]),
    )
    expect(errors.F1).toBe("plain text")
    expect(errors.F2).toBe("error")
    expect(errors.F3).toBe("second line")
    expect(errors.F4).toBe("x".repeat(300))
    expect(store.file.entries.every((e) => e.status === "FAILED")).toBe(true)
  })
})

test.describe("the run folder's files", () => {
  test("an unreadable or partial undo.json reads as an empty ledger for the run", () => {
    const { dir, done } = tmp()
    try {
      const store = fileUndoStore(dir, "loc-9")
      expect(store.read()).toEqual({ runId: "loc-9", entries: [] })
      writeFileSync(join(dir, UNDO_JSON), "{not json")
      expect(store.read()).toEqual({ runId: "loc-9", entries: [] })
      writeFileSync(join(dir, UNDO_JSON), JSON.stringify({ entries: "nope" }))
      expect(store.read()).toEqual({ runId: "loc-9", entries: [] })
      writeFileSync(
        join(dir, UNDO_JSON),
        JSON.stringify({ runId: "loc-7", entries: [] }),
      )
      expect(store.read().runId).toBe("loc-7")
    } finally {
      done()
    }
  })

  test("writes undo.json and undo.md atomically, with the project's wording", async () => {
    const { dir, done } = tmp()
    try {
      const store = fileUndoStore(join(dir, "nested", "run"), "loc-1", {
        manualIntro: "Please undo:",
      })
      const ledger = new UndoLedger(store, () => ({}), clock)
      await ledger.change("F1", {
        what: "a|b",
        before: 1,
        manual: "by hand",
        restore: () => Promise.resolve(),
      })
      const run = join(dir, "nested", "run")
      expect(readdirSync(run).sort()).toEqual([UNDO_JSON, UNDO_MD])
      expect(existsSync(join(run, `${UNDO_JSON}.tmp`))).toBe(false)
      const md = readFileSync(join(run, UNDO_MD), "utf8")
      expect(md).toContain("Please undo:")
      expect(md).toContain("| 1 | F1 | a\\|b | pending | — |")
    } finally {
      done()
    }
  })

  test("undo.md shows a before-state that cannot be serialised, and the error", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const md = undoMarkdown({
      runId: "loc-1",
      entries: [
        {
          id: "u1",
          seq: 1,
          feature: "F1",
          what: "loop",
          before: circular,
          manual: "reset it",
          status: "FAILED",
          error: "403",
          recordedAt: NOW.toISOString(),
          restoredAt: null,
        },
      ],
    })
    expect(md).toContain("**loop** (F1, FAILED: 403)")
    expect(md).toContain("Before: `[object Object]`")
    expect(md).toContain("Restore: reset it")
  })
})
