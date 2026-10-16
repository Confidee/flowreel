// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "@playwright/test"

import { SendRefusedError } from "../src/core/errors.js"
import {
  assertReplyDomainRecipient,
  replyDomainTarget,
} from "../src/mail/guard.js"

// The hard send guard: on staging flowreel only ever mails the reply
// domain, so it can never reach a real mailbox (support@example.com stands
// for a production support address).

const DOMAIN = "reply-staging.example.com"

test.describe("assertReplyDomainRecipient", () => {
  test("accepts a bare address on the reply domain, normalised", () => {
    for (const [to, expected] of [
      [
        "support@reply-staging.example.com",
        "support@reply-staging.example.com",
      ],
      [
        "SUPPORT@Reply-Staging.Example.COM",
        "support@reply-staging.example.com",
      ],
      [
        "  support@reply-staging.example.com\t",
        "support@reply-staging.example.com",
      ],
      [
        "reply+AbC123@reply-staging.example.com",
        "reply+abc123@reply-staging.example.com",
      ],
    ] as const) {
      expect(assertReplyDomainRecipient(to, DOMAIN), to).toBe(expected)
    }
    // The configured domain is normalised too.
    expect(
      assertReplyDomainRecipient(
        "support@reply-staging.example.com",
        " Reply-Staging.Example.com ",
      ),
    ).toBe("support@reply-staging.example.com")
  })

  test("refuses the real support mailbox in every spelling", () => {
    for (const to of [
      "support@example.com",
      "SUPPORT@EXAMPLE.COM",
      "Support@Example.Com",
      " support@example.com ",
      "\tsupport@example.com\n",
      "Support <support@example.com>",
      "<support@example.com>",
    ]) {
      expect(() => assertReplyDomainRecipient(to, DOMAIN), to).toThrow(
        SendRefusedError,
      )
    }
  })

  test("refuses lookalike, sub- and parent domains", () => {
    for (const to of [
      "support@reply-staging.example.com.evil.example",
      "support@REPLY-STAGING.EXAMPLE.COM.evil.example",
      "support@evil.reply-staging.example.com",
      "support@evilreply-staging.example.com",
      "support@reply-staging.example.co",
      "support@staging.example.com",
      "support@reply-staging.example.com.",
      "support@reply-staging-example.com",
      "test@example.com",
      "test+agent@example.com",
    ]) {
      expect(() => assertReplyDomainRecipient(to, DOMAIN), to).toThrow(
        SendRefusedError,
      )
    }
  })

  test("refuses anything that is not exactly one bare address", () => {
    for (const to of [
      "",
      "   ",
      "support",
      "@reply-staging.example.com",
      "support@",
      "support@example.com@reply-staging.example.com",
      "support@reply-staging.example.com,support@example.com",
      "support@reply-staging.example.com; support@example.com",
      "support@reply-staging.example.com support@example.com",
      "Support <support@reply-staging.example.com>",
      '"support@example.com"@reply-staging.example.com',
    ]) {
      expect(() => assertReplyDomainRecipient(to, DOMAIN), to).toThrow(
        SendRefusedError,
      )
    }
  })

  test("an empty reply domain refuses everything", () => {
    expect(() =>
      assertReplyDomainRecipient("support@reply-staging.example.com", ""),
    ).toThrow(/FLOWREEL_REPLY_DOMAIN/)
  })

  test("the refusal names the address and the expected domain", () => {
    expect(() =>
      assertReplyDomainRecipient("support@example.com", DOMAIN),
    ).toThrow(
      'Refusing to send to "support@example.com": on staging the harness only mails a single bare address on the reply domain reply-staging.example.com',
    )
  })
})

test.describe("replyDomainTarget", () => {
  test("keeps the support local part on the reply domain", () => {
    expect(replyDomainTarget("support@example.com", DOMAIN)).toBe(
      "support@reply-staging.example.com",
    )
    expect(
      replyDomainTarget(" Support@Example.com ", "REPLY-STAGING.example.com"),
    ).toBe("support@reply-staging.example.com")
  })
})
