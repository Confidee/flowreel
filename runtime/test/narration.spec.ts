// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "@playwright/test"

import { registerEnvAliases } from "../src/core/env.js"
import {
  BASE_NEVER_SPEAK,
  DEFAULT_NARRATION_COPY,
  OPAQUE_TOKEN,
  defineNarrationCopy,
  everyMatch,
  neverSpeakOf,
} from "../src/narration/copy.js"
import {
  DEFAULT_SLOW_FACTOR,
  asSentence,
  createNarration,
  failureCategory,
  failureKind,
  failureLine,
  featureFallback,
  loadNarration,
  narrationDecision,
  narrationForcedOff,
  settingHintName,
  slowFactorOf,
  timelineOptionsFor,
  tourNarrationModule,
  videoPaceFor,
  videoPaceOf,
} from "../src/narration/narration.js"
import { createCards } from "../src/video/cards.js"
import { defineCardCopy } from "../src/video/copy.js"
import type { MailCard } from "../src/video/recorder.js"

// What the narrated videos say: curated lines over the caption's sentence,
// placeholders, the never-speak rules (with a project's own patterns), the
// email and failure lines, the card lines and the on/off and pace rules.

const cards = createCards({
  copy: defineCardCopy({
    stepTitles: { "R2 open": "The agent opens the case" },
    stepCode: /^(?:R\d+|[A-C]\d{1,2}\.\d{1,2})(?=\s|$)/,
  }),
})

const orbitCopy = defineNarrationCopy({
  speakablePatterns: [{ name: "a case number", pattern: /\[?\bCS-\d+\b\]?/gi }],
  placeholders: { CASE: "the case" },
  featureId: "[A-C]\\d{1,2}",
  email: {
    received: (subject) =>
      subject ? `A visitor writes: ${subject}` : "A visitor writes.",
    reply: "The visitor replies.",
  },
  roundTrip: { intro: "This is the Orbit round trip." },
})

const n = createNarration({ copy: orbitCopy, stepLabel: cards.stepLabel })
const neutral = createNarration({ stepLabel: createCards().stepLabel })

const card = (over: Partial<MailCard> = {}): MailCard => ({
  step: "R4 visitor receives",
  direction: "received",
  from: "Desk <desk@example.test>",
  to: ["visitor@example.test"],
  replyTo: [],
  subject: "[CS-12] [QA loc-20261014-1200-abcd] Order question",
  excerpt: "",
  ...over,
})

test.describe("step lines", () => {
  test("the default is the caption's sentence", () => {
    expect(n.defaultStepLine("B1.1 The agent takes the case")).toBe(
      "The agent takes the case.",
    )
    expect(n.defaultStepLine("R2 open")).toBe("The agent opens the case.")
    expect(n.stepCode("B12.3 x")).toBe("B12.3")
    expect(n.stepCode("R5 visitor replies")).toBe("R5")
  })

  test("a curated line overrides it: full title first, then the step code", () => {
    const lines = {
      "B1.1": "By code.",
      "B1.1 The agent takes the case": "By title.",
      "B1.2": "Second by code.",
    }
    expect(
      n.stepLine(lines, {
        title: "B1.1 The agent takes the case",
        failed: false,
      }),
    ).toBe("By title.")
    expect(n.stepLine(lines, { title: "B1.2 Grouped", failed: false })).toBe(
      "Second by code.",
    )
    expect(n.stepLine(lines, { title: "B1.3 Handed on", failed: false })).toBe(
      "Handed on.",
    )
  })

  test("a failed step adds its failure category, never the error text", () => {
    const line = n.stepLine(
      {},
      {
        title: "A4.2 Search finds the case by its number",
        failed: true,
        error:
          "TimeoutError: Timeout 30000ms exceeded at https://x.test/c/CS-9",
      },
    )
    expect(line).toBe(
      "Search finds the case by its number. This step failed: it timed out.",
    )
    expect(failureLine("expect(received).toBe(expected)")).toBe(
      "This step failed: the page did not show what was expected.",
    )
    expect(failureCategory(null)).toBe("it did not finish")
    expect(failureCategory("net::ERR_CONNECTION_REFUSED")).toBe(
      "the server could not be reached",
    )
    expect(failureCategory("403 Forbidden")).toBe("the app refused it")
    expect(failureCategory("something odd")).toBe("an unexpected error")
    expect(failureKind("Timeout 5000ms exceeded")).toBe("timeout")
  })

  test("the failure line and its categories come from the copy", () => {
    const own = createNarration({
      copy: defineNarrationCopy({
        failure: {
          line: (category) => `Fehler: ${category}.`,
          categories: { timeout: "Zeitüberschreitung" },
        },
      }),
      stepLabel: cards.stepLabel,
    })
    expect(
      own.stepLine({}, { title: "R2 open", failed: true, error: "timed out" }),
    ).toBe("The agent opens the case. Fehler: Zeitüberschreitung.")
    // Categories not given keep the default words.
    expect(
      own.stepLine({}, { title: "R2 open", failed: true, error: "403" }),
    ).toBe("The agent opens the case. Fehler: the app refused it.")
  })

  test("a long wait adds one wait line", () => {
    expect(n.stepLine({}, { title: "R2 open", failed: false }, "email")).toBe(
      `The agent opens the case. ${orbitCopy.waitLines.email}`,
    )
  })
})

test.describe("placeholders and never-speak rules", () => {
  test("placeholders become spoken words (the project's own too)", () => {
    expect(
      n.fillPlaceholders("{PASSED} of {COUNT}, {FAILED}, {RUN_ID}, {CASE}", {
        COUNT: 9,
        PASSED: 8,
        FAILED: 1,
      }),
    ).toBe("8 of 9, 1, this run, the case")
    expect(n.fillPlaceholders("{NOPE} and {COUNT}", {})).toBe("it and it")
    expect(neutral.fillPlaceholders("{CASE}", {})).toBe("it")
  })

  test("a project's patterns are checked after the base ones, before the catch-all", () => {
    expect(neverSpeakOf(orbitCopy).map((p) => p.name)).toEqual([
      ...BASE_NEVER_SPEAK.map((p) => p.name),
      "a case number",
      OPAQUE_TOKEN.name,
    ])
    const raw =
      "Mail test+qa@example.com at https://app.example.com/x about [QA stg-20261014-1200-ab12] CS-42 with reply token abcdef0123456789abcdef."
    expect(n.unspeakableParts(raw)).toEqual([
      "a QA subject prefix",
      "an email address",
      "a link",
      "a run id",
      "a case number",
      "an opaque token",
    ])
    const spoken = n.speakable(raw)
    expect(n.unspeakableParts(spoken)).toEqual([])
    expect(spoken).toBe("Mail at about with reply token.")
    // Without the project's pattern the number is plain text.
    expect(neutral.unspeakableParts("CS-42")).toEqual([])
    expect(n.unspeakableParts("loc-20261014-1200-abcd")).toContain("a run id")
  })

  test("defineNarrationCopy: an override given as undefined keeps the default", () => {
    const copy = defineNarrationCopy({
      featureId: undefined,
      speakablePatterns: undefined,
      featureFallback: undefined,
      placeholders: { ORDER: undefined } as unknown as Record<string, string>,
      failure: { line: undefined, categories: { timeout: undefined } },
      email: { reply: undefined },
      tour: { intro: undefined },
      pipeline: undefined,
    })
    expect(copy.featureId).toBe(DEFAULT_NARRATION_COPY.featureId)
    expect(copy.speakablePatterns).toEqual(
      DEFAULT_NARRATION_COPY.speakablePatterns,
    )
    expect(copy.featureFallback("A1", "x y")).toBe(
      DEFAULT_NARRATION_COPY.featureFallback("A1", "x y"),
    )
    expect(copy.placeholders).toEqual(DEFAULT_NARRATION_COPY.placeholders)
    expect(copy.failure).toEqual(DEFAULT_NARRATION_COPY.failure)
    expect(copy.email).toEqual(DEFAULT_NARRATION_COPY.email)
    expect(copy.tour).toEqual(DEFAULT_NARRATION_COPY.tour)
    expect(copy.pipeline).toEqual(DEFAULT_NARRATION_COPY.pipeline)
    const narration = createNarration({ copy, stepLabel: cards.stepLabel })
    expect(narration.emailCode("undefined x")).toBe("")
    expect(narration.emailCode("B12 x")).toBe("B12")
  })

  test("a pattern without the g flag still removes every match", () => {
    const line = "Merge ORD-12 into ORD-34 now"
    const copies = {
      defined: defineNarrationCopy({
        speakablePatterns: [{ name: "an order", pattern: /ORD-\d+/ }],
      }),
      // A copy put together by hand (no defineNarrationCopy) is safe too.
      raw: {
        ...DEFAULT_NARRATION_COPY,
        speakablePatterns: [{ name: "an order", pattern: /ORD-\d+/y }],
      },
    }
    for (const [label, copy] of Object.entries(copies)) {
      const narration = createNarration({ copy, stepLabel: cards.stepLabel })
      expect(narration.speakable(line), label).toBe("Merge into now")
      expect(narration.unspeakableParts("x ORD-34"), label).toEqual([
        "an order",
      ])
      for (const { pattern } of neverSpeakOf(copy)) {
        expect(pattern.global, label).toBe(true)
        expect(pattern.sticky, label).toBe(false)
      }
    }
    expect(
      copies.defined.speakablePatterns.map((p) => p.pattern.flags),
    ).toEqual(["g"])
    // Flags other than y are kept; an already-global pattern is left as is.
    expect(everyMatch(/a/iy).flags).toBe("gi")
    const global = /a/gi
    expect(everyMatch(global)).toBe(global)
  })

  test("a curated line goes through the same rules", () => {
    expect(n.curated({ x: "write to someone@example.com now" }, ["x"])).toBe(
      "Write to now.",
    )
    expect(n.curated({ x: "   " }, ["x"])).toBeNull()
    expect(asSentence("hello")).toBe("Hello.")
    expect(asSentence("Done!")).toBe("Done!")
  })
})

test.describe("email card lines", () => {
  test("received: the copy's line with the spoken subject", () => {
    expect(n.emailLine({}, card())).toBe("A visitor writes: Order question.")
    expect(n.emailLine({}, card({ subject: "[CS-1]" }))).toBe(
      "A visitor writes.",
    )
    expect(neutral.emailLine({}, card({ subject: "Hello" }))).toBe(
      "An email arrives: Hello.",
    )
  })

  test("sent replies and first mails", () => {
    expect(
      n.emailLine({}, card({ direction: "sent", subject: "Re: [CS-12] Q" })),
    ).toBe("The visitor replies.")
    expect(
      n.emailLine(
        {},
        card({ direction: "sent", subject: "[QA loc-20261014-1200-abcd] Hi" }),
      ),
    ).toBe("An email is sent: Hi.")
  })

  test("a curated <code>.email line wins; the n-th card may have its own", () => {
    expect(n.emailLine({ "R4.email": "Custom card line" }, card())).toBe(
      "Custom card line.",
    )
    const lines = { "B1.1.email": "First.", "B1.1.email.2": "Second." }
    const b = card({ step: "B1.1 Mail waits", direction: "sent" })
    expect(n.emailLine(lines, b)).toBe("First.")
    expect(n.emailLine(lines, b, 2)).toBe("Second.")
    expect(n.emailLine(lines, b, 3)).toBe("First.")
  })

  test("a feature id with an alternation stays anchored at the start", () => {
    const alt = createNarration({
      copy: defineNarrationCopy({ featureId: "AB|CD\\d" }),
      stepLabel: (title) => ({ code: "", title }),
    })
    expect(alt.emailCode("xx CD1 y")).toBe("")
    expect(alt.emailCode("CD1 y")).toBe("CD1")
    expect(alt.emailCode("AB y")).toBe("AB")
    expect(alt.spokenSubject("Ask CD1 about AB later")).toBe(
      "Ask CD1 about AB later",
    )
    expect(alt.spokenSubject("CD1 Ask later")).toBe("Ask later")
  })

  test("the feature id: read out of no subject, the key of a label without a step code", () => {
    expect(
      n.spokenSubject("[QA loc-20261014-1200-abcd] B8 Copy someone in"),
    ).toBe("Copy someone in")
    expect(
      n.spokenSubject("Re: [CS-4] [QA loc-20261014-1200-abcd] C14.2 Spam"),
    ).toBe("Spam")
    // Only a leading code of the project's feature-id shape.
    expect(n.spokenSubject("D1 B2B order")).toBe("D1 B2B order")
    expect(n.spokenSubject("B1 B2B order")).toBe("B2B order")
    expect(n.emailCode("B8.4 The delivered reply")).toBe("B8.4")
    expect(n.emailCode("R4 visitor receives")).toBe("R4")
    expect(n.emailCode("C5 requester receives the reply")).toBe("C5")
    expect(n.emailCode("something else")).toBe("")
  })
})

test.describe("card lines", () => {
  test("area intro and outro come from the area file with counts", () => {
    const lines = {
      area: "Area B has {COUNT} features.",
      outro: "{PASSED} of {COUNT} passed, {FAILED} failed.",
    }
    expect(
      n.tourCardLine(lines, {
        kind: "area-intro",
        area: "B",
        title: "Workspace",
        count: 17,
      }),
    ).toBe("Area B has 17 features.")
    expect(
      n.tourCardLine(
        {},
        {
          kind: "area-intro",
          area: "B",
          title: "Workspace",
          count: 17,
        },
      ),
    ).toBe("Area B: Workspace. 17 features.")
    const board = {
      kind: "area-scoreboard" as const,
      area: "B",
      count: 17,
      passed: 16,
      failed: 1,
    }
    expect(n.tourCardLine(lines, { ...board, page: 1 })).toBe(
      "16 of 17 passed, 1 failed.",
    )
    expect(n.tourCardLine(lines, { ...board, page: 2 })).toBeNull()
  })

  test("feature cards: curated, else the slug; stand-ins say why", () => {
    expect(
      n.tourCardLine(
        { B1: "Assignment." },
        { kind: "feature", id: "B1", title: "assign", card: "title" },
      ),
    ).toBe("Assignment.")
    expect(
      n.tourCardLine(
        {},
        { kind: "feature", id: "A4", title: "list-search", card: "title" },
      ),
    ).toBe("Feature A4: list search.")
    expect(featureFallback("A4", "list_search")).toBe(
      "Feature A4: list search.",
    )
    expect(
      n.tourCardLine(
        {},
        { kind: "feature", id: "B4", title: "x", card: "dev-only" },
      ),
    ).toContain("development only")
    expect(
      n.tourCardLine(
        {},
        { kind: "feature", id: "F3", title: "x", card: "view" },
      ),
    ).toContain("read-only")
    expect(
      n.tourCardLine(
        {},
        { kind: "feature", id: "F3", title: "x", card: "not-run" },
      ),
    ).toContain("did not run")
  })

  test("every tour sentence comes from the copy", () => {
    const own = createNarration({
      copy: defineNarrationCopy({
        featureFallback: (id, words) => `Funktion ${id}: ${words}`,
        tour: {
          areaIntro: (area, title, count) =>
            `Bereich ${area}: ${title}, ${count}`,
          areaChapter: (area, title) => `Kapitel ${area} ${title}`,
          devOnly: "Nur Entwicklung.",
          view: "Nur lesen.",
          notRun: "Nicht gelaufen.",
          areaOutro: (area, passed, count) =>
            `Ende ${area}: ${passed}/${count}`,
          summary: (passed, count, failed) =>
            `Alles: ${passed}/${count}/${failed}`,
          scoreboard: "Jede Funktion.",
        },
      }),
      stepLabel: cards.stepLabel,
    })
    const area = { area: "B", title: "Workspace", count: 3 }
    expect(own.tourCardLine({}, { kind: "area-intro", ...area })).toBe(
      "Bereich B: Workspace, 3.",
    )
    expect(own.tourCardLine({}, { kind: "area-chapter", ...area })).toBe(
      "Kapitel B Workspace.",
    )
    const feature = { kind: "feature" as const, id: "A4", title: "list-search" }
    expect(own.tourCardLine({}, { ...feature, card: "title" })).toBe(
      "Funktion A4: list search.",
    )
    expect(own.tourCardLine({}, { ...feature, card: "dev-only" })).toBe(
      "Funktion A4: list search. Nur Entwicklung.",
    )
    expect(own.tourCardLine({}, { ...feature, card: "view" })).toBe(
      "Funktion A4: list search. Nur lesen.",
    )
    expect(own.tourCardLine({}, { ...feature, card: "not-run" })).toBe(
      "Funktion A4: list search. Nicht gelaufen.",
    )
    expect(
      own.tourCardLine(
        {},
        {
          kind: "area-scoreboard",
          area: "B",
          page: 1,
          count: 3,
          passed: 2,
          failed: 1,
        },
      ),
    ).toBe("Ende B: 2/3.")
    expect(
      own.tourCardLine(
        {},
        { kind: "tour-summary", count: 3, passed: 2, failed: 1 },
      ),
    ).toBe("Alles: 2/3/1")
    expect(own.tourCardLine({}, { kind: "tour-scoreboard", page: 1 })).toBe(
      "Jede Funktion.",
    )
    expect(
      own.tourCardLine({}, { kind: "tour-scoreboard", page: 2 }),
    ).toBeNull()
  })

  test("tour intro and summary", () => {
    expect(
      neutral.tourCardLine(
        {},
        {
          kind: "tour-intro",
          count: 3,
          areas: 1,
          target: "local",
        },
      ),
    ).toBe(
      "This is the feature tour on development: 3 features in 1 area, each one recorded as a colleague would use it.",
    )
    expect(
      n.tourCardLine(
        {},
        { kind: "tour-summary", count: 3, passed: 2, failed: 1 },
      ),
    ).toBe("That is the whole tour: 2 of 3 features passed, and 1 failed.")
    expect(n.tourCardLine({}, { kind: "tour-scoreboard", page: 2 })).toBeNull()
  })

  test("the round trip's intro and outro (chosen by verdict)", () => {
    const lines = { "outro.pass": "All good.", outro: "{PASSED} of {COUNT}." }
    expect(
      n.roundTripCardLine(lines, "outro", { COUNT: 8, PASSED: 8 }, "PASS"),
    ).toBe("All good.")
    expect(
      n.roundTripCardLine(lines, "outro", { COUNT: 8, PASSED: 5 }, "FAIL"),
    ).toBe("5 of 8.")
    expect(n.roundTripCardLine({}, "intro", {})).toBe(
      "This is the Orbit round trip.",
    )
    expect(n.roundTripCardLine({}, "outro", { COUNT: 3, PASSED: 2 })).toBe(
      "2 of 3 steps passed.",
    )
  })

  test("the pipeline's own lines", () => {
    const lines = DEFAULT_NARRATION_COPY.pipeline
    expect(lines.chapter("Staging", true)).toBe("Staging.")
    expect(lines.chapter("Staging", false)).toBe(
      "Staging did not run this time.",
    )
  })
})

test.describe("on / off, pace and slow factor", () => {
  test("off unless turned on: the only voices are Apple's, licensed for personal use (Apple licence §2F)", () => {
    const off = {
      on: false,
      reason:
        "off unless FLOWREEL_NARRATION=on (the macOS voices are licensed for personal, non-commercial use only)",
    }
    for (const run of [
      { kind: "tour", pace: "demo" },
      { kind: "tour", pace: "qa" },
      { kind: "round-trip", pace: "demo" },
      { kind: "round-trip", pace: "qa" },
    ] as const) {
      expect(narrationDecision({}, run), `${run.kind} ${run.pace}`).toEqual(off)
    }
    expect(
      narrationDecision(
        { FLOWREEL_NARRATION: "on" },
        { kind: "round-trip", pace: "qa" },
      ),
    ).toEqual({ on: true })
    expect(
      narrationDecision(
        { FLOWREEL_NARRATION: "off" },
        { kind: "tour", pace: "demo" },
      ),
    ).toEqual({ on: false, reason: "FLOWREEL_NARRATION=off" })
    expect(narrationForcedOff({ FLOWREEL_NARRATION: "no" })).toBe(true)
    expect(narrationForcedOff({})).toBe(false)
  })

  test("a hint names the project's registered name, else FLOWREEL_<KEY>", () => {
    // A test-only key: aliases are process-wide and cannot be removed.
    expect(settingHintName("TEST_HINT_ONLY")).toBe("FLOWREEL_TEST_HINT_ONLY")
    registerEnvAliases({ TEST_HINT_ONLY: ["LEGACY_HINT_A", "LEGACY_HINT_B"] })
    expect(settingHintName("TEST_HINT_ONLY")).toBe("LEGACY_HINT_A")
  })

  test("the slow factor: 1.5 by default, 1-3 accepted", () => {
    expect(DEFAULT_SLOW_FACTOR).toBe(1.5)
    expect(slowFactorOf({})).toBe(1.5)
    expect(slowFactorOf({ FLOWREEL_SLOW_FACTOR: "2" })).toBe(2)
    expect(slowFactorOf({ FLOWREEL_SLOW_FACTOR: "0.5" })).toBe(1.5)
    expect(slowFactorOf({ FLOWREEL_SLOW_FACTOR: "x" })).toBe(1.5)
  })

  test("a tour's video pace follows its pace; the round trip is demo exactly when narrated", () => {
    expect(videoPaceOf(undefined)).toBe("demo")
    expect(videoPaceOf(" QA ")).toBe("qa")
    expect(videoPaceOf("fast")).toBe("demo")
    expect(videoPaceFor("tour", {})).toMatchObject({
      pace: "demo",
      slowFactor: 1.5,
      narration: { on: false },
    })
    expect(videoPaceFor("tour", { FLOWREEL_PACE: "qa" })).toMatchObject({
      pace: "qa",
      slowFactor: 1,
      narration: { on: false },
    })
    // An explicit pace wins over the environment.
    expect(videoPaceFor("tour", { FLOWREEL_PACE: "qa" }, "demo")).toMatchObject(
      { pace: "demo", narration: { on: false } },
    )
    expect(
      videoPaceFor("tour", { FLOWREEL_NARRATION: "on" }, "demo"),
    ).toMatchObject({ pace: "demo", narration: { on: true } })
    expect(videoPaceFor("round-trip", {})).toMatchObject({
      pace: "qa",
      slowFactor: 1,
    })
    expect(
      videoPaceFor("round-trip", { FLOWREEL_NARRATION: "on" }),
    ).toMatchObject({ pace: "demo", slowFactor: 1.5 })
    expect(timelineOptionsFor({ pace: "demo", slowFactor: 1.5 })).toEqual({
      slowFactor: 1.5,
      fastForward: false,
    })
    expect(timelineOptionsFor({ pace: "qa", slowFactor: 1 })).toEqual({})
  })
})

test.describe("curated line files", () => {
  test("strings only, no _comment keys; a missing file is no lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "flowreel-narration-"))
    try {
      writeFileSync(
        join(dir, "orbit.json"),
        JSON.stringify({ _note: "x", intro: "Hi.", n: 3 }),
      )
      writeFileSync(join(dir, "broken.json"), "{")
      expect(loadNarration("orbit", dir)).toEqual({ intro: "Hi." })
      expect(loadNarration("broken", dir)).toEqual({})
      expect(loadNarration("missing", dir)).toEqual({})
      expect(tourNarrationModule("B")).toBe("tour-b")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
