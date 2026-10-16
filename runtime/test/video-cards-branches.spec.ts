// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "@playwright/test"

import { NEUTRAL_BRAND } from "../src/video/brand.js"
import { createCards } from "../src/video/cards.js"
import { DEFAULT_CARD_COPY, defineCardCopy } from "../src/video/copy.js"
import type { FeatureStatus } from "../src/reporter/status.js"
import { createTourCards } from "../src/video/tour-cards.js"

// Corners of the card templates: custom step titles, the sent-mail card, an
// empty excerpt, comparison cells of every kind, and the tour cards with no
// policy / no reason / an unlisted status.

const LOGOS = { onBrand: null, onLight: null }

test.describe("cards", () => {
  test("a step title from the copy wins over the one in the id", () => {
    const cards = createCards({
      copy: defineCardCopy({
        stepTitles: { "T1 inbound": "A customer writes" },
      }),
    })
    expect(cards.stepLabel("T1 inbound")).toEqual({
      code: "T1",
      title: "A customer writes",
    })
    expect(cards.stepLabel("T2 open it")).toEqual({
      code: "T2",
      title: "open it",
    })
    // An id that is only a code keeps the id as the title.
    expect(cards.stepLabel("T3").title).toBe("T3")
  })

  const mail = {
    step: "T1 inbound",
    from: "a@example.test",
    to: ["b@example.test"],
    replyTo: [],
    subject: "Hello",
    excerpt: "",
  }

  test("a sent mail says sent, and an empty excerpt shows no body", () => {
    const cards = createCards()
    const sent = cards.emailHtml(LOGOS, { ...mail, direction: "sent" })
    expect(sent).toContain(DEFAULT_CARD_COPY.mail.sent)
    expect(sent).toContain("&#8599;")
    expect(sent).not.toContain('<div class="body">')
    const received = cards.emailHtml(LOGOS, {
      ...mail,
      direction: "received",
      excerpt: "Some text",
    })
    expect(received).toContain(DEFAULT_CARD_COPY.mail.received)
    expect(received).toContain("&#8601;")
    expect(received).toContain('<div class="body">Some text</div>')
  })

  test("comparison cells: missing, passed, failed, skipped, timed and untimed", () => {
    const html = createCards().comparisonHtml(LOGOS, {
      pipelineId: "p-1",
      verdict: "FAIL",
      reason: "",
      stages: [
        { title: "One", verdict: "PASS", runId: null },
        { title: "Two", verdict: "FAIL", runId: null },
        { title: "Three", verdict: "PASS", runId: null },
        { title: "Four", verdict: "PASS", runId: null },
      ],
      rows: [
        {
          id: "S1 step",
          cells: [
            null,
            { status: "passed", durationMs: 1_500 },
            { status: "failed", durationMs: null },
            { status: "skipped", durationMs: null },
          ],
        },
      ],
      latencies: [],
    })
    expect(html).toContain('<span class="c none">&ndash;</span>')
    expect(html).toContain(
      '<span class="m ok">&#10003;</span><span class="d">1.5 s</span>',
    )
    expect(html).toContain(
      '<span class="c failed"><span class="m bad">&#10007;</span><span class="d">failed</span>',
    )
    expect(html).toContain(
      '<span class="m skip">&ndash;</span><span class="d">skipped</span>',
    )
  })
})

test.describe("tour cards", () => {
  const tour = createTourCards()

  test("feature cards: no policy badge, and a missing reason shows only the head", () => {
    const devOnly = tour.featureCardHtml({
      logos: LOGOS,
      id: "A1",
      title: "ledger",
      area: "A",
      policy: null,
      kind: "dev-only",
    })
    expect(devOnly).not.toContain('<span class="badge">')
    expect(devOnly).toContain(`<b>${DEFAULT_CARD_COPY.tour.devOnly}</b></div>`)
    const notRun = tour.featureCardHtml({
      logos: LOGOS,
      id: "A2",
      title: "inbox",
      area: "A",
      policy: "both",
      kind: "not-run",
    })
    expect(notRun).toContain(`<b>${DEFAULT_CARD_COPY.tour.notRun}</b></div>`)
    expect(notRun).toContain('<span class="badge">')
    const withReason = tour.featureCardHtml({
      logos: LOGOS,
      id: "A2",
      title: "inbox",
      area: "A",
      policy: null,
      kind: "not-run",
      reason: "skipped on purpose",
    })
    expect(withReason).toContain("<p>skipped on purpose</p>")
    const plain = tour.featureCardHtml({
      logos: LOGOS,
      id: "A3",
      title: "list",
      area: "A",
      policy: null,
      kind: "title",
    })
    expect(plain).not.toContain('class="note"><b>')
  })

  test("a status the copy does not label falls back to its own name, and an unknown one to the neutral mark", () => {
    const strange = "mystery" as FeatureStatus
    const bare = createTourCards(
      createCards({
        copy: {
          ...DEFAULT_CARD_COPY,
          tour: { ...DEFAULT_CARD_COPY.tour, statuses: {} },
        } as typeof DEFAULT_CARD_COPY,
      }),
    )
    const html = bare.scoreboardHtml({
      logos: LOGOS,
      heading: "Area",
      subheading: "",
      columns: ["Development"],
      rows: [
        {
          id: "A1",
          title: "x",
          cells: [{ status: strange, durationMs: 1_000 }],
        },
      ],
      counts: { passed: 1 },
      page: 1,
      pages: 1,
    })
    // Without a label in the copy the count line shows the status itself.
    expect(html).toContain("<span>passed</span>")
    // The unknown status is drawn like "not run": the skip colour and dash.
    expect(html).toContain(
      `background:${NEUTRAL_BRAND.colors.skip}">&ndash;</span>`,
    )
  })
})
