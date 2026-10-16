// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "@playwright/test"

import {
  VideoLog,
  mailCard,
  parseVideoLog,
  videoEnabled,
  videoOffReason,
} from "../src/video/recorder.js"
import { excerpt, redactAddress, redactText } from "../src/video/redact.js"

const TOKEN = "k3J9xQ2mP7vR8sT1uW4yZ6aB5cD0eF"

test.describe("redactAddress", () => {
  test("hides reply+ and notify+ tokens, keeps prefix and domain", () => {
    expect(redactAddress(`reply+${TOKEN}@reply-staging.example.com`)).toBe(
      "reply+…@reply-staging.example.com",
    )
    expect(redactAddress(`NOTIFY+${TOKEN}@reply.example.test`)).toBe(
      "NOTIFY+…@reply.example.test",
    )
  })

  test("works inside a display-name header value", () => {
    expect(
      redactAddress(`"Support via Example" <reply+${TOKEN}@r.example.test>`),
    ).toBe('"Support via Example" <reply+…@r.example.test>')
  })

  test("short plus tags such as test+agent stay readable", () => {
    expect(redactAddress("test+agent@example.com")).toBe(
      "test+agent@example.com",
    )
  })

  test("any other long plus tag is treated as a token", () => {
    expect(redactAddress(`bounce+${TOKEN}@mail.example.test`)).toBe(
      "bounce+…@mail.example.test",
    )
  })
})

test.describe("redactText", () => {
  test("removes tokens, links and opaque strings; keeps the RUN_ID", () => {
    const body = [
      "Thanks for run loc-20261013-1124-915a.",
      `Reply to reply+${TOKEN}@r.example.test or open`,
      `https://staging.app.example.com/t/${TOKEN}?sig=abc`,
      `Token eyJhbGciOiJIUzI1NiJ9eyJzdWIiOiIxMjM0NTY3ODkwIn0`,
      "----------------------------------------",
    ].join(" ")
    const out = redactText(body)
    expect(out).toContain("loc-20261013-1124-915a")
    expect(out).toContain("reply+…@r.example.test")
    expect(out).toContain("[link]")
    expect(out).toContain("Token [redacted]")
    expect(out).toContain("----------------------------------------")
    expect(out).not.toContain(TOKEN)
    expect(out).not.toContain("eyJhbGci")
  })
})

test.describe("excerpt", () => {
  test("drops quoted history and collapses whitespace", () => {
    const body =
      "Thanks, that helps.\n\nOn Mon, 13 Oct 2026 Support wrote:\n> old text"
    expect(excerpt(body)).toBe("Thanks, that helps.")
    expect(excerpt("a\n> quoted\nb")).toBe("a b")
  })

  test("drops the mail layout's marker, rules and interception banner", () => {
    const body = [
      "Please reply above this line — your message will be added to the conversation.",
      "----------------------------------------",
      "=====================",
      "Email Intercepted",
      "Intended Recipient: admin@example.test",
      "Environment: Development",
      "=====================",
      "",
      "Example",
      "Thanks for your request.",
    ].join("\n")
    expect(excerpt(body)).toBe("Example Thanks for your request.")
  })

  test("drops the banner Graph renders from the HTML part (no rule)", () => {
    const body = [
      "Email Intercepted",
      "",
      "Intended Recipient: test@example.com",
      "Environment: Staging",
      "",
      "Thanks for your request.",
    ].join("\n")
    expect(excerpt(body)).toBe("Thanks for your request.")
  })

  test("with a focus, shows the paragraph holding it from the focus on", () => {
    const body = [
      "Example",
      "Dev | [REQ-7] Subject",
      "",
      "Hi, we can quote that. Regards",
      "",
      "Example | www.example.com | Copyright",
    ].join("\n")
    expect(excerpt(body, 220, "we can quote that")).toBe(
      "…we can quote that. Regards",
    )
    expect(excerpt(body, 220, "Hi, we can")).toBe(
      "Hi, we can quote that. Regards",
    )
    expect(excerpt(body, 220, "not in the body")).toBe(
      "Example Dev | [REQ-7] Subject Hi, we can quote that. Regards Example | www.example.com | Copyright",
    )
  })

  test("cuts long text at a word boundary with an ellipsis", () => {
    const out = excerpt("word ".repeat(100), 40)
    expect(out.length).toBeLessThanOrEqual(41)
    expect(out).toMatch(/word…$/)
  })
})

test.describe("mailCard / VideoLog", () => {
  test("a received mail is redacted when recorded", () => {
    const card = mailCard("T4 customer receives", "received", {
      from: `"Admin via Example" <support@r.example.test>`,
      to: ["test@example.com"],
      replyTo: [`reply+${TOKEN}@r.example.test`],
      subject: "[REQ-12] [QA loc-20261013-1124-915a] Question",
      text: `Agent reply.\nhttps://app.example.test/x?t=${TOKEN}`,
    })
    expect(card.replyTo).toEqual(["reply+…@r.example.test"])
    expect(card.excerpt).toBe("Agent reply. [link]")
    expect(JSON.stringify(card)).not.toContain(TOKEN)
  })

  test("an outgoing mail (single `to`) becomes a one-recipient card", () => {
    const card = mailCard("T1 inbound", "sent", {
      from: "test@example.com",
      to: "rfq@example.test",
      subject: "s",
      text: "t",
    })
    expect(card).toMatchObject({ to: ["rfq@example.test"], replyTo: [] })
  })

  test("the log anchors once and serialises only cards", () => {
    const log = new VideoLog()
    log.markVideoStart(1000)
    log.markVideoStart(2000)
    log.mail(
      "T5 customer replies",
      "sent",
      {
        from: "test@example.com",
        to: `reply+${TOKEN}@r.example.test`,
        subject: "Re: x",
        text: "ok",
      },
      4500,
    )
    const data = log.toJSON()
    expect(data.videoStartedAt).toBe(1000)
    expect(data.mail[0]).toMatchObject({
      at: 4500,
      step: "T5 customer replies",
    })
    expect(JSON.stringify(data)).not.toContain(TOKEN)
    expect(parseVideoLog(JSON.stringify(data))).toEqual(data)
    expect(parseVideoLog("{}")).toBeNull()
    expect(parseVideoLog("not json")).toBeNull()
  })
})

test.describe("videoEnabled", () => {
  test("on by default; off/0/false/no switch it off", () => {
    expect(videoEnabled({})).toBe(true)
    expect(videoEnabled({ FLOWREEL_VIDEO: "on" })).toBe(true)
    for (const value of ["off", "OFF", "0", "false", "no"]) {
      expect(videoEnabled({ FLOWREEL_VIDEO: value })).toBe(false)
    }
    // No alias is registered for VIDEO in the runtime: other names are
    // ignored (env.spec.ts covers registered aliases).
    expect(videoEnabled({ SOME_OTHER_VIDEO: "off" })).toBe(true)
  })

  test("the off reason names FLOWREEL_VIDEO", () => {
    expect(videoOffReason({ FLOWREEL_VIDEO: "off" })).toBe("FLOWREEL_VIDEO=off")
    expect(videoOffReason({})).toBe("FLOWREEL_VIDEO=off")
  })
})
