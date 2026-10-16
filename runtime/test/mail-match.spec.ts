// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "@playwright/test"

import {
  addressOf,
  describeQuery,
  matchMessage,
  matchesQuery,
} from "../src/mail/match.js"
import type { MailMessage } from "../src/mail/types.js"

const since = new Date("2026-10-13T10:00:00.000Z")

function message(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id: "1",
    messageId: "<m1@example.test>",
    from: "Agent via Example <rfq@example.test>",
    to: ["qa-customer-1@qa.example.com"],
    cc: [],
    replyTo: ["reply+abc@reply.example.test"],
    subject: "[REQ-7] [QA loc-20261013-1000-abcd] Quote request",
    text: "Thanks. Reference loc-20261013-1000-abcd.",
    headers: {},
    receivedAt: "2026-10-13T10:00:05.000Z",
    ...overrides,
  }
}

test.describe("matchesQuery", () => {
  test("matches when every criterion holds", () => {
    expect(
      matchesQuery(message(), {
        to: "qa-customer-1@qa.example.com",
        subjectIncludes: "REQ-7",
        bodyIncludes: "loc-20261013-1000-abcd",
        since,
      }),
    ).toBe(true)
  })

  test("excludeIds skips already-consumed messages", () => {
    expect(matchesQuery(message(), { since, excludeIds: ["1"] })).toBe(false)
    expect(matchesQuery(message(), { since, excludeIds: ["2"] })).toBe(true)
    expect(
      matchMessage(
        message({ to: ["test@example.com"] }),
        { to: "admin@example.test", since, excludeIds: ["1"] },
        ["test@example.com"],
      ),
    ).toBe("none")
  })

  test("is an AND: one failing criterion fails the match", () => {
    expect(matchesQuery(message(), { subjectIncludes: "REQ-8", since })).toBe(
      false,
    )
    expect(matchesQuery(message(), { bodyIncludes: "other-run", since })).toBe(
      false,
    )
    expect(
      matchesQuery(message(), {
        to: "qa-customer-2@qa.example.com",
        subjectIncludes: "REQ-7",
        since,
      }),
    ).toBe(false)
  })

  test("to matches to and cc, case-insensitively", () => {
    expect(
      matchesQuery(message(), { to: "QA-Customer-1@QA.Example.com", since }),
    ).toBe(true)
    const cced = message({ to: ["someone@x.test"], cc: ["Bob <b@x.test>"] })
    expect(matchesQuery(cced, { to: "B@X.TEST", since })).toBe(true)
  })

  test("to does not match reply-to or from", () => {
    expect(
      matchesQuery(message(), { to: "reply+abc@reply.example.test", since }),
    ).toBe(false)
    expect(matchesQuery(message(), { to: "rfq@example.test", since })).toBe(
      false,
    )
  })

  test("since guard: at the instant matches, before does not", () => {
    expect(
      matchesQuery(message({ receivedAt: since.toISOString() }), { since }),
    ).toBe(true)
    expect(
      matchesQuery(message({ receivedAt: "2026-10-13T09:59:59.999Z" }), {
        since,
      }),
    ).toBe(false)
    expect(matchesQuery(message({ receivedAt: "" }), { since })).toBe(false)
  })

  test("subject/body matching is substring, case-sensitive", () => {
    expect(matchesQuery(message(), { subjectIncludes: "quote", since })).toBe(
      false,
    )
    expect(matchesQuery(message(), { subjectIncludes: "Quote", since })).toBe(
      true,
    )
  })
})

test.describe("matchMessage alternates", () => {
  test("direct beats alternate; alternate only when to fails", () => {
    const sandboxedMsg = message({ to: ["test@example.com"] })
    const query = { to: "admin@example.test", since }
    expect(matchMessage(sandboxedMsg, query)).toBe("none")
    expect(matchMessage(sandboxedMsg, query, ["test@example.com"])).toBe(
      "alternate",
    )
    const direct = message({ to: ["admin@example.test", "test@example.com"] })
    expect(matchMessage(direct, query, ["test@example.com"])).toBe("direct")
  })

  test("alternates never bypass the other criteria", () => {
    const sandboxedMsg = message({ to: ["test@example.com"] })
    expect(
      matchMessage(
        sandboxedMsg,
        { to: "admin@example.test", subjectIncludes: "REQ-99", since },
        ["test@example.com"],
      ),
    ).toBe("none")
  })
})

test("addressOf strips a display name", () => {
  expect(addressOf("Agent via Example <rfq@example.test>")).toBe(
    "rfq@example.test",
  )
  expect(addressOf(" bare@x.test ")).toBe("bare@x.test")
})

test("describeQuery names every criterion", () => {
  expect(
    describeQuery({ to: "a@x.test", subjectIncludes: "REQ-1", since }),
  ).toBe('mail to=a@x.test subject~"REQ-1" since=2026-10-13T10:00:00.000Z')
})
