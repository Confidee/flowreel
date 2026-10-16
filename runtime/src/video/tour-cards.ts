// SPDX-License-Identifier: Apache-2.0

import type { FeatureStatus } from "../reporter/status.js"
import type { Pace, Policy } from "../tour/policy.js"

import { type Logos, rgba } from "./brand.js"
import {
  type CardTheme,
  type Cards,
  cardPage,
  createCards,
  escapeHtml,
  formatUtc,
  seconds,
} from "./cards.js"
import { APP_RECT, FRAME } from "./geometry.js"

// HTML cards for the feature tour videos: the tour and area intros, area
// chapter cards, the feature title card with its policy badge, the
// "Development only" / "Read-only on staging" / "Not run" cards, the persona
// badge in the recording's brand strip, and the scoreboards (one run, or
// development and staging side by side). Pure strings in the project's
// Brand and CardCopy; render.ts paints them, ffmpeg.ts encodes them.

const e = escapeHtml

/** What the full tour video's intro card shows (TourCards.tourIntroHtml). */
export interface TourIntroData {
  logos: Logos
  target: string
  runId: string
  startedAt: Date
  pace: Pace
  areas: { letter: string; title: string; count: number }[]
}

/** What an area's intro or chapter card shows (TourCards.areaIntroHtml). */
export interface AreaCardData {
  logos: Logos
  letter: string
  title: string
  count: number
  target: string
  pace: Pace
  runId: string
}

/** Which feature card: its title card, or the stand-in for a feature without a recording. */
export type FeatureCardKind = "title" | "dev-only" | "view" | "not-run"

/** What a feature's title or stand-in card shows (TourCards.featureCardHtml). */
export interface FeatureCardData {
  logos: Logos
  id: string
  title: string
  area: string
  policy: Policy | null
  kind: FeatureCardKind
  /** Why it did not run (dev-only reason, skip reason). */
  reason?: string | null
}

/** One feature row of a scoreboard. */
export interface ScoreRow {
  id: string
  title: string
  /** One cell per column (one run, or development and staging). */
  cells: ({ status: FeatureStatus; durationMs: number | null } | null)[]
}

/** One scoreboard page (TourCards.scoreboardHtml). */
export interface ScoreboardData {
  logos: Logos
  heading: string
  subheading: string
  /** Column titles ("Development", "Staging"); one column = no header. */
  columns: string[]
  rows: ScoreRow[]
  /** Counts shown on the left: status -> n. */
  counts: Partial<Record<FeatureStatus, number>>
  verdict?: string
  page: number
  pages: number
}

export const SCOREBOARD_ROWS = 9

/** The order a scoreboard lists its counts in. */
export const FEATURE_STATUSES: FeatureStatus[] = [
  "passed",
  "failed",
  "dev-only",
  "view-only",
  "N/A",
  "not run",
]

/**
 * The feature-tour card templates (createTourCards), built on a project's
 * {@link Cards} so they share its Brand and CardCopy (`copy.tour`). Every
 * template returns a self-contained HTML page for render.ts to paint.
 */
export interface TourCards {
  /** The run-video cards these are built on (brand, copy, step labels). */
  readonly cards: Cards
  /**
   * The full tour video's opening card: logo, tour title, target and pace
   * pills, run id, start time and every area with its feature count.
   */
  tourIntroHtml: (d: TourIntroData) => string
  /** The area MP4's intro (also the chapter card inside the full tour). */
  areaIntroHtml: (d: AreaCardData, chapter?: boolean) => string
  /** A feature's title card (1.5 s) or its stand-in card (3 s). */
  featureCardHtml: (d: FeatureCardData) => string
  /** Transparent overlay: "as <persona>" in the recording's top brand strip. */
  personaBadgeHtml: (persona: string) => string
  /** One page of a scoreboard (rows beyond SCOREBOARD_ROWS go on later pages). */
  scoreboardHtml: (d: ScoreboardData) => string
}

/** The tour cards in one brand and copy (or on top of existing Cards). */
export function createTourCards(
  theme: Partial<CardTheme> | Cards = {},
): TourCards {
  const cards = "stepLabel" in theme ? theme : createCards(theme)
  const { brand, copy } = cards
  const c = brand.colors
  const t = copy.tour
  const gradient = brand.gradient
  const logo = (cls: string, src: string | null) =>
    src ? `<img class="${cls}" src="${src}" alt="${e(brand.name)}">` : ""

  const STATUS_STYLE: Record<FeatureStatus, { mark: string; bg: string }> = {
    passed: { mark: "&#10003;", bg: c.pass },
    failed: { mark: "&#10007;", bg: c.fail },
    "dev-only": { mark: "D", bg: c.devOnly },
    "view-only": { mark: "V", bg: c.primary },
    "N/A": { mark: "&ndash;", bg: c.skip },
    "not run": { mark: "&ndash;", bg: c.skip },
  }
  const label = (status: FeatureStatus) => t.statuses[status] ?? status

  const statusMark = (status: FeatureStatus, size = 30) => {
    const s = STATUS_STYLE[status] ?? STATUS_STYLE["not run"]
    return `<span class="m" style="width:${size}px;height:${size}px;background:${s.bg}">${s.mark}</span>`
  }

  const COMMON_CSS = `.m{flex:none;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:800;color:#fff}
.logo-top{position:absolute;right:64px;top:44px;height:34px}
.pill{font-size:20px;padding:8px 20px;border-radius:999px;background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.45)}
.pill.solid{background:#fff;color:${c.primary};font-weight:700}`

  const paceName = (pace: Pace) => (pace === "demo" ? t.pace.demo : t.pace.qa)
  const targetName = (target: string) =>
    target === "staging" ? t.targetName.staging : t.targetName.development

  function tourIntroHtml(d: TourIntroData): string {
    const rows = d.areas
      .map(
        (a) =>
          `<div class="ar"><b>${e(a.letter)}</b><span class="ellipsis">${e(a.title)}</span><span class="n">${e(t.features(a.count))}</span></div>`,
      )
      .join("")
    return cardPage(
      `${COMMON_CSS}
.wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px}
.logo{width:420px}
h1{font-size:56px;font-weight:800;letter-spacing:-0.5px}
.pills{display:flex;gap:12px}
.areas{display:grid;grid-template-columns:1fr 1fr;gap:8px 18px;width:900px;margin-top:6px}
.ar{display:flex;align-items:center;gap:12px;padding:8px 16px;border-radius:12px;background:rgba(255,255,255,.14);font-size:19px}
.ar b{width:30px;height:30px;flex:none;border-radius:8px;background:#fff;color:${c.primary};display:flex;align-items:center;justify-content:center}
.ar span.ellipsis{flex:1;min-width:0}
.ar .n{flex:none;opacity:.85;font-size:16px}`,
      `<div class="wrap">
${logo("logo", d.logos.onBrand)}
<h1>${e(t.title)}</h1>
<div class="pills"><span class="pill solid">${e(d.target === "staging" ? t.targetPill.staging : t.targetPill.development)}</span><span class="pill mono">${e(d.runId)}</span><span class="pill">${e(formatUtc(d.startedAt))}</span><span class="pill">${e(paceName(d.pace))}</span></div>
<div class="areas">${rows}</div>
</div>`,
      gradient,
    )
  }

  function areaIntroHtml(d: AreaCardData, chapter = false): string {
    return cardPage(
      `${COMMON_CSS}
.wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;text-align:center;padding:0 120px}
.k{font-size:22px;letter-spacing:3px;text-transform:uppercase;opacity:.85}
.letter{width:120px;height:120px;border-radius:28px;background:#fff;color:${c.primary};font-size:72px;font-weight:800;display:flex;align-items:center;justify-content:center}
h1{font-size:64px;font-weight:800;letter-spacing:-1px}
.pills{display:flex;gap:12px}`,
      `${logo("logo-top", d.logos.onBrand)}
<div class="wrap">
<p class="k">${e(chapter ? t.area : t.areaKicker)}</p>
<div class="letter">${e(d.letter)}</div>
<h1>${e(d.title)}</h1>
<div class="pills"><span class="pill solid">${e(t.features(d.count))}</span>${chapter ? "" : `<span class="pill">${e(targetName(d.target))}</span><span class="pill">${e(paceName(d.pace))}</span><span class="pill mono">${e(d.runId)}</span>`}</div>
</div>`,
      gradient,
    )
  }

  function featureCardHtml(d: FeatureCardData): string {
    const banner =
      d.kind === "dev-only"
        ? { head: t.devOnly, text: d.reason ?? "" }
        : d.kind === "view"
          ? { head: t.view.head, text: t.view.text }
          : d.kind === "not-run"
            ? { head: t.notRun, text: d.reason ?? "" }
            : null
    return cardPage(
      `${COMMON_CSS}
.wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;text-align:center;padding:0 110px}
.k{font-size:20px;letter-spacing:3px;text-transform:uppercase;opacity:.85}
.id{font-size:30px;font-weight:800;background:#fff;color:${c.primary};padding:6px 22px;border-radius:12px}
h1{font-size:60px;font-weight:800;letter-spacing:-0.5px;overflow-wrap:anywhere}
.badge{font-size:19px;padding:7px 18px;border-radius:999px;background:${rgba(c.ink, 0.28)};border:1px solid rgba(255,255,255,.4)}
.note{margin-top:6px;max-width:880px;background:#fff;color:${c.ink};border-radius:18px;padding:18px 28px;box-shadow:0 24px 60px ${rgba(c.shadow, 0.35)}}
.note b{font-size:28px;color:${d.kind === "view" ? c.primary : c.neutral}}
.note p{margin-top:6px;font-size:21px;line-height:1.45;color:${c.body};display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}`,
      `${logo("logo-top", d.logos.onBrand)}
<div class="wrap">
<p class="k">${e(t.area)} ${e(d.area)}</p>
<span class="id">${e(d.id)}</span>
<h1>${e(d.title)}</h1>
${d.policy ? `<span class="badge">${e(t.policies[d.policy])}</span>` : ""}
${banner ? `<div class="note"><b>${e(banner.head)}</b>${banner.text ? `<p>${e(banner.text)}</p>` : ""}</div>` : ""}
</div>`,
      gradient,
    )
  }

  function personaBadgeHtml(persona: string): string {
    const right = FRAME.width - APP_RECT.x - APP_RECT.width + 120
    return cardPage(
      `.b{position:absolute;right:${right}px;top:6px;height:24px;padding:0 12px 0 10px;border-radius:999px;background:#fff;color:${c.primary};
display:flex;align-items:center;gap:6px;font-size:15px;font-weight:700;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.18)}
.b i{font-style:normal;font-weight:500;color:${c.muted}}`,
      `<div class="b"><i>${e(t.persona)}</i>${e(persona)}</div>`,
    )
  }

  function scoreboardHtml(d: ScoreboardData): string {
    const verdictColour =
      d.verdict === "PASS" ? c.pass : d.verdict === "FAIL" ? c.fail : c.neutral
    const cell = (x: ScoreRow["cells"][number]) =>
      x
        ? `<span class="c">${statusMark(x.status, 28)}<span class="d">${e(x.durationMs === null ? label(x.status) : seconds(x.durationMs))}</span></span>`
        : `<span class="c none">&ndash;</span>`
    const head =
      d.columns.length > 1
        ? `<div class="tr hd"><b></b><span class="t">${e(t.feature)}</span>${d.columns.map((col) => `<span class="c h">${e(col)}</span>`).join("")}</div>`
        : ""
    const rows = d.rows
      .map(
        (r) =>
          `<div class="tr ${r.cells.some((x) => x?.status === "failed") ? "failed" : ""}"><b>${e(r.id)}</b><span class="t ellipsis">${e(r.title)}</span>${r.cells.map(cell).join("")}</div>`,
      )
      .join("")
    const counts = FEATURE_STATUSES.filter(
      (status) => (d.counts[status] ?? 0) > 0,
    )
      .map(
        (status) =>
          `<li>${statusMark(status, 24)}<span>${e(label(status))}</span><b>${d.counts[status]}</b></li>`,
      )
      .join("")
    return cardPage(
      `${COMMON_CSS}
.left{position:absolute;left:56px;top:52px;width:400px}
.logo{width:240px}
h2{margin-top:26px;font-size:34px;font-weight:800;line-height:1.15}
.sub{margin-top:8px;font-size:19px;opacity:.92}
.verdict{margin-top:18px;display:inline-block;font-size:40px;font-weight:800;letter-spacing:2px;padding:2px 20px;border-radius:12px;background:#fff;color:${verdictColour}}
ul{list-style:none;margin-top:18px;background:#fff;border-radius:14px;padding:4px 16px;color:${c.ink}}
li{display:flex;align-items:center;gap:10px;padding:7px 0;font-size:19px;border-bottom:1px solid ${c.line}}
li:last-child{border-bottom:none}
li span{flex:1}
.pg{position:absolute;left:56px;bottom:36px;font-size:17px;opacity:.9}
.table{position:absolute;left:500px;right:56px;top:52px;background:#fff;color:${c.ink};border-radius:20px;padding:8px 22px;box-shadow:0 24px 60px ${rgba(c.shadow, 0.35)}}
.tr{display:flex;align-items:center;gap:12px;height:62px;font-size:20px;border-bottom:1px solid ${c.line}}
.tr:last-child{border-bottom:none}
.tr.failed{color:${c.fail}}
.tr.hd{height:42px;font-size:15px;color:${c.muted};text-transform:uppercase;letter-spacing:1px}
.tr b{width:52px;flex:none}
.t{flex:1;min-width:0}
.c{width:150px;flex:none;display:flex;align-items:center;gap:8px}
.c.none{color:${c.muted};padding-left:10px}
.d{font-size:16px;font-variant-numeric:tabular-nums}`,
      `<div class="left">
${logo("logo", d.logos.onBrand)}
<h2>${e(d.heading)}</h2>
<p class="sub">${e(d.subheading)}</p>
${d.verdict ? `<div><span class="verdict">${e(d.verdict)}</span></div>` : ""}
${counts ? `<ul>${counts}</ul>` : ""}
</div>
${d.pages > 1 ? `<p class="pg">${e(t.page(d.page, d.pages))}</p>` : ""}
<div class="table">${head}${rows || `<div class="tr">${e(t.noFeatures)}</div>`}</div>`,
      gradient,
    )
  }

  return {
    cards,
    tourIntroHtml,
    areaIntroHtml,
    featureCardHtml,
    personaBadgeHtml,
    scoreboardHtml,
  }
}
