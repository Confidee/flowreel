// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "@playwright/test"

import { VideoLog, parseVideoLog } from "../src/video/recorder.js"
import { excerpt } from "../src/video/redact.js"

const source = {
  from: "a@example.test",
  to: "b@example.test",
  subject: "Hello",
  text: "Body",
}

test.describe("VideoLog", () => {
  test("the first video start wins; later marks are ignored", () => {
    const log = new VideoLog()
    expect(log.toJSON().videoStartedAt).toBeNull()
    log.markVideoStart(100)
    log.markVideoStart(200)
    expect(log.toJSON().videoStartedAt).toBe(100)
  })

  test("without an explicit time, events are stamped with now", () => {
    const log = new VideoLog()
    const before = Date.now()
    log.markVideoStart()
    log.mail("R1 inbound", "received", source)
    log.persona("admin")
    const after = Date.now()
    const data = log.toJSON()
    expect(data.videoStartedAt).toBeGreaterThanOrEqual(before)
    expect(data.videoStartedAt).toBeLessThanOrEqual(after)
    expect(data.mail[0].at).toBeGreaterThanOrEqual(before)
    expect(data.mail[0].at).toBeLessThanOrEqual(after)
    expect(data.personas?.[0].at).toBeGreaterThanOrEqual(before)
    expect(data.personas?.[0].at).toBeLessThanOrEqual(after)
  })

  test("personas appear in the JSON only once one was recorded, in order", () => {
    const log = new VideoLog()
    expect(log.toJSON()).not.toHaveProperty("personas")
    log.persona("agent", 10)
    log.persona("admin", 20)
    const data = log.toJSON()
    expect(data.personas).toEqual([
      { persona: "agent", at: 10 },
      { persona: "admin", at: 20 },
    ])
    // The snapshot is a copy: later events do not change it.
    log.persona("guest", 30)
    expect(data.personas).toHaveLength(2)
  })

  test("a round trip through JSON keeps mail and personas", () => {
    const log = new VideoLog()
    log.markVideoStart(1)
    log.mail("R1 inbound", "sent", source, 5)
    log.persona("admin", 7)
    expect(parseVideoLog(JSON.stringify(log))).toEqual(log.toJSON())
  })
})

test.describe("parseVideoLog", () => {
  test("empty, malformed or foreign input is null", () => {
    expect(parseVideoLog(null)).toBeNull()
    expect(parseVideoLog("")).toBeNull()
    expect(parseVideoLog("{ nope")).toBeNull()
    expect(parseVideoLog(JSON.stringify({ mail: "x" }))).toBeNull()
  })

  test("a non-numeric start becomes null; bad persona entries are dropped", () => {
    const parsed = parseVideoLog(
      JSON.stringify({
        videoStartedAt: "soon",
        mail: [],
        personas: [
          { persona: "admin", at: 1 },
          { persona: 3, at: 2 },
          { persona: "x", at: "late" },
          null,
        ],
      }),
    )
    expect(parsed).toEqual({
      videoStartedAt: null,
      mail: [],
      personas: [{ persona: "admin", at: 1 }],
    })
  })

  test("personas that are all invalid, or not a list, are omitted", () => {
    expect(
      parseVideoLog(JSON.stringify({ mail: [], personas: [{ at: 1 }] })),
    ).toEqual({ videoStartedAt: null, mail: [] })
    expect(
      parseVideoLog(JSON.stringify({ mail: [], personas: "admin" })),
    ).toEqual({ videoStartedAt: null, mail: [] })
  })
})

test.describe("excerpt with a focus", () => {
  test("a focus spanning two paragraphs falls back to the flat text", () => {
    const body = "Intro line\n\nfoo\n\nbar"
    // No single paragraph holds "foo bar", but the flattened body does.
    expect(excerpt(body, 220, "foo\n\nbar")).toBe("…foo bar")
  })

  test("a focus at the very start of the flat text changes nothing", () => {
    expect(excerpt("foo\n\nbar", 220, "foo\n\nbar")).toBe("foo bar")
  })

  test("a focus that is not in the body leaves the excerpt alone", () => {
    expect(excerpt("alpha beta", 220, "gamma")).toBe("alpha beta")
  })

  test("a long text is cut at a word boundary, else mid-word", () => {
    const words = "word ".repeat(10).trim()
    expect(excerpt(words, 22)).toBe("word word word word…")
    expect(excerpt("x".repeat(40), 22)).toBe(`${"x".repeat(22)}…`)
  })
})
