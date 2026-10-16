// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "@playwright/test"

import { InboundBudgetError } from "../src/core/errors.js"
import {
  type InboundLedgerEntry,
  type InboundLedgerStore,
  fileInboundLedger,
  withInboundLedger,
} from "../src/core/inbound-ledger.js"
import type { MailDriver, MailMessage } from "../src/mail/types.js"

// The inbound ledger's edges: a damaged ledger file must never block or
// crash a run (entries that are not entries are dropped), the driver wrapper
// keeps optional driver features, and a project limit applies.

test("a ledger file with a bad shape reads as empty; junk entries are dropped", () => {
  const dir = mkdtempSync(join(tmpdir(), "flowreel-ledger-"))
  try {
    const path = join(dir, "ledger.json")
    const store = fileInboundLedger(path)
    writeFileSync(path, JSON.stringify({ sends: "not a list" }))
    expect(store.read()).toEqual([])
    const good = {
      sender: "a@example.test",
      at: "2026-10-14T10:00:00Z",
      runId: "r",
      what: "w",
    }
    writeFileSync(
      path,
      JSON.stringify({
        sends: [null, 7, { sender: 1, at: "x" }, { sender: "b" }, good],
      }),
    )
    expect(store.read()).toEqual([good])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the wrapper delegates saveEml when the driver has it, and omits it when not", async () => {
  const store: InboundLedgerStore = { read: () => [], write: () => undefined }
  const base: MailDriver = {
    kind: "graph",
    health: () => Promise.resolve(),
    send: () => Promise.resolve({ messageId: "" }),
    reply: () => Promise.resolve({ messageId: "" }),
    waitFor: () => Promise.reject(new Error("unused")),
  }
  expect("saveEml" in withInboundLedger(base, store, "r1")).toBe(false)
  const saved: string[] = []
  const withEml: MailDriver = {
    ...base,
    saveEml: (_message, dir) => {
      saved.push(dir)
      return Promise.resolve(`${dir}/m.eml`)
    },
  }
  const wrapped = withInboundLedger(withEml, store, "r1")
  expect(await wrapped.saveEml!({} as MailMessage, "/out")).toBe("/out/m.eml")
  expect(saved).toEqual(["/out"])
})

test("a project limit below the default refuses sooner, and the driver is not called", () => {
  const entries: InboundLedgerEntry[] = []
  const store: InboundLedgerStore = {
    read: () => entries.map((e) => ({ ...e })),
    write: (next) => {
      entries.splice(0, entries.length, ...next)
    },
  }
  let sent = 0
  const driver: MailDriver = {
    kind: "graph",
    health: () => Promise.resolve(),
    send: () => {
      sent++
      return Promise.resolve({ messageId: "" })
    },
    reply: () => Promise.resolve({ messageId: "" }),
    waitFor: () => Promise.reject(new Error("unused")),
  }
  const wrapped = withInboundLedger(driver, store, "r1", { limit: 2 })
  const mail = {
    from: "a@example.test",
    to: "b@example.test",
    subject: "s",
    text: "t",
  }
  void wrapped.send(mail)
  void wrapped.send(mail)
  expect(() => wrapped.send(mail)).toThrow(InboundBudgetError)
  expect(sent).toBe(2)
})

test("health and waitFor go straight to the driver", async () => {
  const store: InboundLedgerStore = { read: () => [], write: () => undefined }
  const seen: string[] = []
  const driver: MailDriver = {
    kind: "graph",
    health: () => {
      seen.push("health")
      return Promise.resolve()
    },
    send: () => Promise.resolve({ messageId: "" }),
    reply: () => Promise.resolve({ messageId: "" }),
    waitFor: (query) => {
      seen.push(`waitFor ${JSON.stringify(query)}`)
      return Promise.resolve({} as MailMessage)
    },
  }
  const wrapped = withInboundLedger(driver, store, "r1")
  expect(wrapped.kind).toBe("graph")
  await wrapped.health()
  await wrapped.waitFor({ subject: "hi" } as never)
  expect(seen).toEqual(["health", 'waitFor {"subject":"hi"}'])
})
