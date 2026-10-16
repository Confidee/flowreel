// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "@playwright/test"

import {
  NEUTRAL_BRAND,
  NEUTRAL_COLORS,
  brandGradient,
  defineBrand,
  rgba,
  svgDataUri,
} from "../src/video/brand.js"
import {
  createCards,
  escapeHtml,
  formatUtc,
  seconds,
} from "../src/video/cards.js"
import { DEFAULT_CARD_COPY, defineCardCopy } from "../src/video/copy.js"
import type { MailCard } from "../src/video/recorder.js"
import { createTourCards } from "../src/video/tour-cards.js"

// The card templates draw every colour, logo and word from the project's
// Brand and CardCopy; the neutral defaults name no product and show no logo.

const LOGOS = {
  onBrand: "data:image/svg+xml;base64,V0hJVEU=",
  onLight: "data:image/svg+xml;base64,T1JJRw==",
}

const orbit = defineBrand({
  name: "Orbit",
  colors: { primary: "#123456", accent: "#abcdef", ink: "#101010" },
  logos: () => LOGOS,
})

const orbitCopy = defineCardCopy({
  stepTitles: { "R1 inbound": "A visitor writes in" },
  stepCode: /^(?:R\d+|[A-C]\d\.\d)(?=\s|$)/,
  run: { title: "Orbit round trip" },
  latencyLabels: { firstHopMs: "First hop", secondHopMs: "Second hop" },
  outro: { latencies: "Hops" },
  tour: { title: "Orbit tour", frameLabel: "Orbit" },
})

const mail = (over: Partial<MailCard> = {}): MailCard => ({
  step: "R1 inbound",
  direction: "received",
  from: "Desk <desk@example.test>",
  to: ["reply+abcdefghijklmnopqrstuvwxyz0123@example.test"],
  replyTo: [],
  subject: "Order <b>question</b> ORB-200012",
  excerpt: "See https://example.test/secret?token=abc",
  ...over,
})

test.describe("Brand", () => {
  test("defineBrand fills the neutral defaults and derives the gradient", () => {
    expect(NEUTRAL_BRAND.colors).toEqual(NEUTRAL_COLORS)
    expect(NEUTRAL_BRAND.logos()).toEqual({ onBrand: null, onLight: null })
    expect(orbit.colors.primary).toBe("#123456")
    expect(orbit.colors.pass).toBe(NEUTRAL_COLORS.pass)
    expect(orbit.gradient).toBe(
      "linear-gradient(135deg, #123456 0%, #abcdef 100%)",
    )
    expect(brandGradient({ primary: "#000", accent: "#fff" })).toBe(
      "linear-gradient(135deg, #000 0%, #fff 100%)",
    )
    expect(defineBrand({ gradient: "red" }).gradient).toBe("red")
  })

  test("rgba: hex + alpha in the compact CSS form", () => {
    expect(rgba("#0f2030", 0.75)).toBe("rgba(15,32,48,.75)")
    expect(rgba("#fff", 0.5)).toBe("rgba(255,255,255,.5)")
    expect(rgba("#003366", 1)).toBe("rgba(0,51,102,1)")
  })

  test("rgba: any other CSS colour keeps its transparency (color-mix)", () => {
    expect(rgba("teal", 0.3)).toBe("color-mix(in srgb, teal 30%, transparent)")
    expect(rgba(" rgb(1, 2, 3) ", 0.75)).toBe(
      "color-mix(in srgb, rgb(1, 2, 3) 75%, transparent)",
    )
    expect(rgba("#0f203080", 0.28)).toBe(
      "color-mix(in srgb, #0f203080 28%, transparent)",
    )
    expect(rgba("hsl(200 50% 40%)", 2)).toBe(
      "color-mix(in srgb, hsl(200 50% 40%) 100%, transparent)",
    )
    // A card in a non-hex brand keeps its translucent badge and shadows.
    const cards = createCards({
      brand: defineBrand({ colors: { ink: "rgb(16 16 16)", shadow: "navy" } }),
    })
    expect(cards.speedHtml(2)).toContain(
      "background:color-mix(in srgb, rgb(16 16 16) 75%, transparent)",
    )
    expect(
      cards.introHtml({
        logos: LOGOS,
        target: "local",
        runId: "r",
        startedAt: new Date(0),
      }),
    ).not.toMatch(/rgba\(navy/)
  })

  test("defineBrand: a colour given as undefined keeps its default", () => {
    const brand = defineBrand({
      name: undefined,
      colors: { primary: undefined, accent: "#fff" },
      gradient: undefined,
      logos: undefined,
    })
    expect(brand.colors).toEqual({ ...NEUTRAL_COLORS, accent: "#fff" })
    expect(brand.name).toBe("")
    expect(brand.gradient).toBe(
      brandGradient({ primary: NEUTRAL_COLORS.primary, accent: "#fff" }),
    )
    expect(brand.logos()).toEqual({ onBrand: null, onLight: null })
    expect(JSON.stringify(createCards({ brand }).speedHtml(2))).not.toContain(
      "undefined",
    )
  })

  test("svgDataUri reads the file; a missing file throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "flowreel-brand-"))
    try {
      writeFileSync(join(dir, "logo.svg"), "<svg/>")
      expect(svgDataUri(join(dir, "logo.svg"))).toBe(
        `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`,
      )
      expect(() => svgDataUri(join(dir, "missing.svg"))).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

test.describe("CardCopy", () => {
  test("defineCardCopy merges nested groups field by field", () => {
    expect(orbitCopy.run).toEqual({
      ...DEFAULT_CARD_COPY.run,
      title: "Orbit round trip",
    })
    expect(orbitCopy.mail).toEqual(DEFAULT_CARD_COPY.mail)
    expect(orbitCopy.tour.policies).toEqual(DEFAULT_CARD_COPY.tour.policies)
    expect(orbitCopy.tour.title).toBe("Orbit tour")
    const fields = defineCardCopy({ mail: { fields: { from: "Sender" } } }).mail
      .fields
    expect(fields).toEqual({ ...DEFAULT_CARD_COPY.mail.fields, from: "Sender" })
  })

  test("defineCardCopy: an override given as undefined keeps the default", () => {
    const copy = defineCardCopy({
      latencyLabels: undefined,
      stepTitles: undefined,
      stepCode: undefined,
      speedBadge: undefined,
      run: { title: undefined, subtitle: { staging: "S", local: "L" } },
      mail: { note: undefined, fields: { from: undefined } },
      tour: { title: undefined, policies: { dev: undefined }, view: undefined },
    })
    expect(copy.latencyLabels).toEqual({})
    expect(copy.stepTitles).toEqual({})
    expect(copy.stepCode).toBe(DEFAULT_CARD_COPY.stepCode)
    expect(copy.speedBadge(2)).toBe(DEFAULT_CARD_COPY.speedBadge(2))
    expect(copy.run).toEqual({
      ...DEFAULT_CARD_COPY.run,
      subtitle: { staging: "S", local: "L" },
    })
    expect(copy.mail).toEqual(DEFAULT_CARD_COPY.mail)
    expect(copy.tour).toEqual(DEFAULT_CARD_COPY.tour)
    // The kit builds: createCards reads latencyLabels' keys.
    const cards = createCards({ copy })
    expect(cards.latencyKeys).toEqual([])
    expect(cards.latencyLabel("x")).toBe("x")
  })

  test("the defaults name no product", () => {
    expect(DEFAULT_CARD_COPY.run.title).toBe("Round trip")
    expect(DEFAULT_CARD_COPY.tour.title).toBe("Feature tour")
    expect(DEFAULT_CARD_COPY.stepTitles).toEqual({})
    expect(DEFAULT_CARD_COPY.latencyLabels).toEqual({})
  })
})

test.describe("cards", () => {
  const cards = createCards({ brand: orbit, copy: orbitCopy })
  const neutral = createCards()

  test("stepLabel: the copy's titles, else the code before the sentence", () => {
    expect(cards.stepLabel("R1 inbound")).toEqual({
      code: "R1",
      title: "A visitor writes in",
    })
    expect(cards.stepLabel("B2.3 The agent files it")).toEqual({
      code: "B2.3",
      title: "The agent files it",
    })
    expect(cards.stepLabel("free text")).toEqual({
      code: "",
      title: "free text",
    })
    // The neutral step code: a letter, a number, an optional ".n".
    expect(neutral.stepLabel("A4.1 Search works")).toEqual({
      code: "A4.1",
      title: "Search works",
    })
    expect(neutral.stepLabel("T3 public reply").code).toBe("T3")
  })

  test("a g or y stepCode keeps no position between calls", () => {
    for (const stepCode of [/^A\d/g, /^A\d/y, /^A\d/gy]) {
      const raw = { ...DEFAULT_CARD_COPY, stepCode }
      for (const copy of [defineCardCopy({ stepCode }), raw]) {
        const own = createCards({ copy })
        for (let i = 0; i < 3; i++) {
          expect(own.stepLabel("A1 one"), String(stepCode)).toEqual({
            code: "A1",
            title: "one",
          })
        }
      }
      expect(defineCardCopy({ stepCode }).stepCode.flags).toBe("")
    }
    const plain = /^A\d/i
    expect(defineCardCopy({ stepCode: plain }).stepCode).toBe(plain)
  })

  test("latency labels and their order come from the copy", () => {
    expect(cards.latencyKeys).toEqual(["firstHopMs", "secondHopMs"])
    expect(cards.latencyLabel("firstHopMs")).toBe("First hop")
    expect(cards.latencyLabel("otherMs")).toBe("otherMs")
    expect(neutral.latencyKeys).toEqual([])
  })

  test("the intro wears the brand: gradient, logo, title, target pill", () => {
    const html = cards.introHtml({
      logos: orbit.logos(),
      target: "staging",
      runId: "stg-20261014-1200-ab12",
      startedAt: new Date(Date.UTC(2026, 9, 14, 12, 5)),
    })
    expect(html).toContain(orbit.gradient)
    expect(html).toContain(
      `<img class="logo" src="${LOGOS.onBrand}" alt="Orbit">`,
    )
    expect(html).toContain("<h1>Orbit round trip</h1>")
    expect(html).toContain(">STAGING</span>")
    expect(html).toContain("14 Oct 2026, 12:05 UTC")
    expect(html).toContain("color:#123456")
  })

  test("the neutral brand draws no logo", () => {
    const html = neutral.introHtml({
      logos: NEUTRAL_BRAND.logos(),
      target: "local",
      runId: "loc-1",
      startedAt: new Date(0),
    })
    expect(html).not.toContain("<img")
    expect(html).toContain("<h1>Round trip</h1>")
    expect(html).toContain(">LOCAL</span>")
    expect(
      neutral.frameHtml(NEUTRAL_BRAND.logos(), "loc-1", "local"),
    ).not.toContain("<img")
  })

  test("an email card is redacted again and escaped at render time", () => {
    const html = cards.emailHtml(LOGOS, mail())
    expect(html).not.toContain("abcdefghijklmnopqrstuvwxyz0123")
    expect(html).toContain("reply+…@example.test")
    expect(html).not.toContain("secret?token")
    expect(html).toContain("[link]")
    expect(html).toContain("Order &lt;b&gt;question&lt;/b&gt;")
    // A hyphenated record number never wraps.
    expect(html).toContain('<span class="nw">ORB-200012</span>')
    expect(html).toContain("<b>R1</b>A visitor writes in")
    expect(html).toContain("Email received")
    expect(html).toContain(`<img class="brand" src="${LOGOS.onLight}" alt="">`)
    expect(html).toContain(
      `box-shadow:0 24px 60px ${rgba(NEUTRAL_COLORS.shadow, 0.35)}`,
    )
    expect(cards.emailHtml(LOGOS, mail({ step: "free" }))).toContain(
      "<b>Mail</b>free",
    )
  })

  test("caption, speed and wait badges", () => {
    const passed = cards.captionHtml("B2.3 The agent files it", "passed")
    expect(passed).toContain("background:#123456")
    expect(passed).toContain("<span>Passed</span>")
    const failed = cards.captionHtml("free", "failed")
    expect(failed).toContain(`background:${NEUTRAL_COLORS.fail}`)
    expect(failed).toContain('<span class="code">Step</span>')
    expect(cards.speedHtml(3.6)).toContain(
      "&#9193; waiting, played 4&times; faster",
    )
    expect(cards.waitHtml("Waiting <here>")).toContain(
      "&#8987; Waiting &lt;here&gt;",
    )
    // Translucent overlays derive from the ink colour.
    expect(cards.speedHtml(2)).toContain("background:rgba(16,16,16,.75)")
  })

  test("outro: steps, latencies in the copy's words, verdict colour", () => {
    const html = cards.outroHtml({
      logos: LOGOS,
      verdict: "FAIL",
      reason: "R1 failed.",
      runId: "loc-1",
      steps: [{ id: "R1 inbound", status: "failed", durationMs: 1_500 }],
      latenciesMs: { firstHopMs: 2_000, otherMs: "x" },
    })
    expect(html).toContain("<h3>Hops</h3>")
    expect(html).toContain("<span>First hop</span><b>2.0 s</b>")
    expect(html).toContain("<span>otherMs</span><b>—</b>")
    expect(html).toContain(`color:${NEUTRAL_COLORS.fail}}`)
    const empty = cards.outroHtml({
      logos: LOGOS,
      verdict: "N/A",
      reason: "",
      runId: "loc-1",
      steps: [],
      latenciesMs: {},
    })
    expect(empty).toContain("No steps ran.")
    expect(empty).not.toContain("<h3>")
  })

  test("pipeline cards", () => {
    const stage = {
      title: "Development",
      detail: "Local",
      runId: null,
      verdict: "not run",
      note: "development FAIL",
    }
    const intro = cards.pipelineIntroHtml({
      logos: LOGOS,
      module: "orbit",
      pipelineId: "pipe-1",
      startedAt: new Date(0),
      stages: [stage],
    })
    expect(intro).toContain("<h1>Orbit: development &rarr; staging</h1>")
    const chapter = cards.chapterHtml(LOGOS, 1, stage)
    expect(chapter).toContain('<p class="k">Stage 2</p>')
    expect(chapter).toContain(">Not run</span>")
    const comparison = cards.comparisonHtml(LOGOS, {
      pipelineId: "pipe-1",
      verdict: "PASS",
      reason: "",
      stages: [{ title: "Development", verdict: "PASS", runId: "loc-1" }],
      rows: [
        { id: "R1 inbound", cells: [{ status: "passed", durationMs: 900 }] },
      ],
      latencies: [{ key: "firstHopMs", label: "First hop", values: [1_000] }],
    })
    expect(comparison).toContain('<span class="t">Step</span>')
    expect(comparison).toContain("<h3>Hops</h3>")
    expect(comparison).toContain("A visitor writes in")
  })

  test("standby page: the copy's text unless given", () => {
    expect(cards.standbyHtml(LOGOS, "loc-1")).toContain(
      DEFAULT_CARD_COPY.standby.line,
    )
    expect(
      cards.standbyHtml(LOGOS, "loc-1", { heading: "H", line: "L" }),
    ).toContain("<h1>H</h1>")
  })

  test("pure helpers", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    )
    expect(seconds(1_250)).toBe("1.3 s")
    expect(seconds(null)).toBe("—")
    expect(formatUtc(new Date(Date.UTC(2026, 0, 2, 3, 4)))).toBe(
      "2 Jan 2026, 03:04 UTC",
    )
  })
})

test.describe("tour cards", () => {
  const tour = createTourCards({ brand: orbit, copy: orbitCopy })

  test("built on the same cards", () => {
    const cards = createCards({ brand: orbit, copy: orbitCopy })
    expect(createTourCards(cards).cards).toBe(cards)
    expect(tour.cards.copy).toBe(orbitCopy)
  })

  test("intro, area and feature cards in the copy's words", () => {
    const intro = tour.tourIntroHtml({
      logos: LOGOS,
      target: "local",
      runId: "loc-1",
      startedAt: new Date(0),
      pace: "demo",
      areas: [{ letter: "A", title: "Lists", count: 1 }],
    })
    expect(intro).toContain("<h1>Orbit tour</h1>")
    expect(intro).toContain(">DEVELOPMENT</span>")
    expect(intro).toContain(">Demo pace</span>")
    expect(intro).toContain('<span class="n">1 feature</span>')
    const area = tour.areaIntroHtml({
      logos: LOGOS,
      letter: "A",
      title: "Lists",
      count: 2,
      target: "staging",
      pace: "qa",
      runId: "stg-1",
    })
    expect(area).toContain("Feature tour · area")
    expect(area).toContain(">2 features</span>")
    expect(area).toContain(">Staging</span>")
    expect(area).toContain(">QA pace</span>")
    expect(
      tour.areaIntroHtml(
        {
          logos: LOGOS,
          letter: "A",
          title: "Lists",
          count: 2,
          target: "staging",
          pace: "qa",
          runId: "stg-1",
        },
        true,
      ),
    ).toContain('<p class="k">Area</p>')
    const view = tour.featureCardHtml({
      logos: LOGOS,
      id: "A1",
      title: "list",
      area: "A · Lists",
      policy: "view",
      kind: "view",
    })
    expect(view).toContain("Staging read-only")
    expect(view).toContain("<b>Read-only on staging</b>")
    expect(view).toContain("Area A · Lists")
    expect(view).toContain("background:rgba(16,16,16,.28)")
  })

  test("persona badge and scoreboard", () => {
    expect(tour.personaBadgeHtml("admin")).toContain("<i>as</i>admin")
    const html = tour.scoreboardHtml({
      logos: LOGOS,
      heading: "Area A",
      subheading: "Development · loc-1",
      columns: ["Development", "Staging"],
      rows: [
        {
          id: "A1",
          title: "list",
          cells: [{ status: "dev-only", durationMs: null }, null],
        },
      ],
      counts: { failed: 2, passed: 1 },
      verdict: "FAIL",
      page: 1,
      pages: 2,
    })
    expect(html).toContain('<span class="t">Feature</span>')
    expect(html).toContain("Dev only")
    expect(html).toContain("Page 1 of 2")
    // Counts in the status order (passed before failed).
    expect(html.indexOf("<span>Passed</span>")).toBeLessThan(
      html.indexOf("<span>Failed</span>"),
    )
    expect(
      tour.scoreboardHtml({
        logos: LOGOS,
        heading: "",
        subheading: "",
        columns: ["Development"],
        rows: [],
        counts: {},
        page: 1,
        pages: 1,
      }),
    ).toContain("No features ran.")
  })
})
