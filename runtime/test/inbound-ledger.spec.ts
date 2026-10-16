// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "@playwright/test"

import { InboundBudgetError } from "../src/core/errors.js"
import {
  DEFAULT_SENDER_HOURLY_LIMIT,
  type InboundLedgerEntry,
  type InboundLedgerStore,
  consumeInbound,
  fileInboundLedger,
  withInboundLedger,
} from "../src/core/inbound-ledger.js"
import type { MailDriver } from "../src/mail/types.js"

// The cross-run inbound-mail ledger: an app's inbound rate limit is per
// sender per rolling hour, across every run (every module shares it).

function memoryStore(entries: InboundLedgerEntry[] = []) {
  const box = { entries }
  const store: InboundLedgerStore = {
    read: () => box.entries.map((e) => ({ ...e })),
    write: (next) => {
      box.entries = next
    },
  }
  return { store, box }
}

const at = (min: number) =>
  new Date(Date.UTC(2026, 9, 14, 10, 0) + min * 60_000)

test("the default limit is 8 per sender per hour", () => {
  expect(DEFAULT_SENDER_HOURLY_LIMIT).toBe(8)
})

test("counts across runs; refuses the next send BEFORE it is sent", () => {
  const { store, box } = memoryStore()
  for (let i = 0; i < DEFAULT_SENDER_HOURLY_LIMIT; i++) {
    consumeInbound(
      store,
      {
        sender: "test@example.com",
        runId: i < 3 ? "stg-a" : "stg-b",
        what: `m${i}`,
      },
      at(i),
    )
  }
  const before = box.entries.length
  expect(() =>
    consumeInbound(
      store,
      { sender: "TEST@example.com", runId: "stg-c", what: "C14 spam" },
      at(20),
    ),
  ).toThrow(InboundBudgetError)
  expect(box.entries).toHaveLength(before) // nothing recorded, nothing sent
  // Another sender has its own bucket.
  expect(
    consumeInbound(
      store,
      { sender: "qa1@external.example.com", runId: "stg-c", what: "x" },
      at(20),
    ),
  ).toBe(1)
})

test("the window rolls: an hour after the oldest send there is room again", () => {
  const { store, box } = memoryStore()
  for (let i = 0; i < DEFAULT_SENDER_HOURLY_LIMIT; i++) {
    consumeInbound(
      store,
      { sender: "test@example.com", runId: "stg-a", what: "m" },
      at(i),
    )
  }
  expect(() =>
    consumeInbound(
      store,
      { sender: "test@example.com", runId: "stg-b", what: "m" },
      at(59),
    ),
  ).toThrow(/Wait until 2026-10-14T11:00:00.000Z/)
  expect(
    consumeInbound(
      store,
      { sender: "test@example.com", runId: "stg-b", what: "m" },
      at(60),
    ),
  ).toBe(DEFAULT_SENDER_HOURLY_LIMIT)
  // Entries older than the window are dropped on write.
  expect(box.entries.some((e) => e.at === at(0).toISOString())).toBe(false)
})

test("the file store survives a missing or broken file", () => {
  const dir = mkdtempSync(join(tmpdir(), "inbound-ledger-"))
  try {
    const store = fileInboundLedger(join(dir, "nested", "inbound-ledger.json"))
    expect(store.read()).toEqual([])
    consumeInbound(
      store,
      { sender: "test@example.com", runId: "stg-a", what: "T1" },
      at(0),
    )
    expect(store.read()).toMatchObject([
      { sender: "test@example.com", runId: "stg-a" },
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the round trip's driver counts its new mails only; replies pass through", async () => {
  const { store, box } = memoryStore()
  const calls: string[] = []
  const driver: MailDriver = {
    kind: "graph",
    health: () => Promise.resolve(),
    send: () => {
      calls.push("send")
      return Promise.resolve({ messageId: "" })
    },
    reply: () => {
      calls.push("reply")
      return Promise.resolve({ messageId: "" })
    },
    waitFor: () => Promise.reject(new Error("unused")),
  }
  const wrapped = withInboundLedger(driver, store, "stg-x")
  await wrapped.send({
    from: "test@example.com",
    to: "support@r.example.com",
    subject: "[QA stg-x] T1",
    text: "t",
  })
  await wrapped.reply({} as never, { from: "test@example.com", text: "t" })
  expect(calls).toEqual(["send", "reply"])
  expect(box.entries).toHaveLength(1)
  // At the limit the send is refused and the driver is never called.
  box.entries = Array.from({ length: DEFAULT_SENDER_HOURLY_LIMIT }, () => ({
    sender: "test@example.com",
    at: new Date().toISOString(),
    runId: "stg-y",
    what: "m",
  }))
  expect(() =>
    wrapped.send({
      from: "test@example.com",
      to: "support@r.example.com",
      subject: "s",
      text: "t",
    }),
  ).toThrow(InboundBudgetError)
  expect(calls).toEqual(["send", "reply"])
})

test("the limit and the refusal's hints are the project's", () => {
  const { store } = memoryStore()
  consumeInbound(
    store,
    { sender: "a@example.test", runId: "r1", what: "m" },
    at(0),
    1,
  )
  let message = ""
  try {
    consumeInbound(
      store,
      { sender: "a@example.test", runId: "r2", what: "second" },
      at(1),
      1,
      { reason: "the app parks the 3rd mail", remedy: "use another sender" },
    )
  } catch (error) {
    message = (error as Error).message
  }
  expect(message).toBe(
    'Refusing inbound mail "second": a@example.test already sent 1 new mails to staging in the last 60 minutes (runs r1); the app parks the 3rd mail. Nothing was sent. Wait until 2026-10-14T11:00:00.000Z, or use another sender.',
  )
  expect(() =>
    consumeInbound(
      store,
      { sender: "a@example.test", runId: "r2", what: "x" },
      at(1),
      1,
    ),
  ).toThrow(
    /\(runs r1\)\. Nothing was sent\. Wait until 2026-10-14T11:00:00\.000Z\.$/,
  )
})
