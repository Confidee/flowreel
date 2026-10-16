// SPDX-License-Identifier: Apache-2.0

import { type Brand, type Logos, NEUTRAL_BRAND, rgba } from "./brand.js"
import {
  type CardCopy,
  DEFAULT_CARD_COPY,
  type StandbyText,
  stateless,
} from "./copy.js"
import { APP_RECT, FRAME } from "./geometry.js"
import type { MailCard } from "./recorder.js"
import { redactAddress, redactText } from "./redact.js"

// HTML templates for the run video: the intro, email and outro cards, the
// caption bar, the frame around the recording (logo watermark top-right),
// the fast-forward and wait badges, and the development -> staging pipeline
// cards. Pure strings in the project's Brand and CardCopy (createCards);
// render.ts screenshots them to PNG in an unrecorded browser context and
// ffmpeg.ts composes them. No external font or asset: the logos arrive as
// data: URIs (Brand.logos) and text uses the system font stack.

const CAPTION_TOP = APP_RECT.y + APP_RECT.height

/** Text made safe to interpolate into card HTML (`& < > " '` escaped). */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

const e = escapeHtml

/** A full-frame card page (FRAME-sized, system fonts, white text). */
export function cardPage(
  css: string,
  body: string,
  background = "transparent",
): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${FRAME.width}px;height:${FRAME.height}px;overflow:hidden}
body{position:relative;background:${background};color:#fff;
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
-webkit-font-smoothing:antialiased}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.ellipsis{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nw{white-space:nowrap}
${css}
</style></head><body>${body}</body></html>`
}

/** "13 Oct 2026, 11:24 UTC": UTC like the RUN_ID, no locale dependence. */
export function formatUtc(date: Date): string {
  const months = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ")
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
}

/** 1234 -> "1.2 s"; null or a non-finite value -> "—". */
export function seconds(ms: number | null): string {
  return ms === null || !Number.isFinite(ms)
    ? "—"
    : `${(ms / 1000).toFixed(1)} s`
}

/**
 * Escaped text with every hyphenated word (a record number, a RUN_ID) kept
 * on one line, so a wrapped subject never splits it.
 */
function keepTogether(escaped: string): string {
  return escaped.replace(
    /\S*-\S*/g,
    (word) => `<span class="nw">${word}</span>`,
  )
}

/** A card's text, redacted once more at render time (defence in depth). */
function safe(card: MailCard): MailCard {
  return {
    ...card,
    from: redactAddress(card.from),
    to: card.to.map(redactAddress),
    replyTo: card.replyTo.map(redactAddress),
    subject: redactText(card.subject),
    excerpt: redactText(card.excerpt),
  }
}

const capitalise = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1)

/** What the run video's intro card shows (Cards.introHtml). */
export interface IntroData {
  logos: Logos
  target: string
  runId: string
  startedAt: Date
}

/** One row of the outro's step table. */
export interface OutroStep {
  id: string
  status: string
  durationMs: number | null
}

/** What the run video's outro card shows (Cards.outroHtml). */
export interface OutroData {
  logos: Logos
  verdict: "PASS" | "FAIL" | "N/A"
  reason: string
  runId: string
  steps: OutroStep[]
  latenciesMs: Record<string, unknown>
}

/** Development -> staging pipeline: one stage on the intro / chapter card. */
export interface PipelineStageCard {
  /** "Development" / "Staging". */
  title: string
  /** One line on what the stage runs against. */
  detail: string
  runId: string | null
  /** PASS / FAIL / N/A / not run / not configured / skipped. */
  verdict: string
  /** Why it did not run, or why it shows no recording; null = it plays. */
  note: string | null
}

/** What the pipeline video's intro card shows (Cards.pipelineIntroHtml). */
export interface PipelineIntroData {
  logos: Logos
  module: string
  pipelineId: string
  startedAt: Date
  stages: PipelineStageCard[]
}

/** One stage's result for one step in the pipeline comparison. */
export interface ComparisonCell {
  status: string
  durationMs: number | null
}

/** One step of the pipeline comparison, across the stages. */
export interface ComparisonRow {
  id: string
  /** One cell per stage, in stage order; null = that stage has no table. */
  cells: (ComparisonCell | null)[]
}

/** One latency of the pipeline comparison, across the stages. */
export interface ComparisonLatency {
  key: string
  label: string
  /** One value per stage, in stage order. */
  values: (number | null)[]
}

/** What the pipeline outro shows (Cards.comparisonHtml). */
export interface ComparisonData {
  pipelineId: string
  verdict: string
  reason: string
  stages: { title: string; verdict: string; runId: string | null }[]
  rows: ComparisonRow[]
  latencies: ComparisonLatency[]
}

/** What createCards renders in: the Brand and the CardCopy. */
export interface CardTheme {
  brand: Brand
  copy: CardCopy
}

/** The card templates in one brand and copy (createCards). */
export interface Cards {
  readonly brand: Brand
  readonly copy: CardCopy
  /**
   * A step's caption: the code and the plain-language title. A step id
   * listed in copy.stepTitles takes that title; otherwise copy.stepCode
   * splits "A4.1 Search finds the record" into "A4.1" and the sentence.
   */
  stepLabel: (id: string) => { code: string; title: string }
  /** A latency key's label in the copy (copy.latencyLabels), else the key. */
  latencyLabel: (key: string) => string
  /** The latency keys the copy names, in the order the outro lists them. */
  readonly latencyKeys: string[]
  /** The run video's opening card: logo, run title, target, run id, start time. */
  introHtml: (d: IntroData) => string
  /**
   * A full-frame card for one email the run sent or received: the step's
   * code and title, From / To / Reply-To / Subject and an excerpt, every
   * address and token redacted first (redact.ts).
   */
  emailHtml: (logos: Logos, raw: MailCard) => string
  /** The run video's closing card: verdict, reason, step table, latencies. */
  outroHtml: (d: OutroData) => string
  /**
   * What the recorded page shows before the first step. Painting it at once
   * gives the recording its first frame at the moment the page is created:
   * the page video's clock starts at its first frame, so a blank about:blank
   * (which paints nothing) would shift every caption late.
   */
  standbyHtml: (logos: Logos, runId: string, text?: StandbyText) => string
  /** Transparent frame overlay: brand strips around the recording + watermark. */
  frameHtml: (
    logos: Logos,
    runId: string,
    target: string,
    title?: string,
  ) => string
  /**
   * CI-style status glyph: a filled circle with a white check (passed) or
   * cross (failed). Inline SVG, so the render needs no icon font.
   */
  statusIcon: (status: "passed" | "failed", size: number) => string
  /** Transparent caption overlay for one step: the bar under the recording. */
  captionHtml: (stepId: string, status: "passed" | "failed") => string
  /** Transparent badge for a sped-up stretch (a long wait, qa pace). */
  speedHtml: (speed: number) => string
  /** Demo pace: a long wait plays in real time with this caption on top. */
  waitHtml: (text: string) => string
  /** The pipeline video's opening card: the module and each stage (title, detail, run id). */
  pipelineIntroHtml: (d: PipelineIntroData) => string
  /**
   * The chapter card before a stage's part (`index` counts from 0); a
   * stage's note (why it has nothing to play) shows under its verdict.
   */
  chapterHtml: (logos: Logos, index: number, stage: PipelineStageCard) => string
  /** The pipeline outro: verdicts, steps and latencies development vs staging. */
  comparisonHtml: (logos: Logos, d: ComparisonData) => string
}

/**
 * The card templates in a project's `brand` (default NEUTRAL_BRAND) and
 * `copy` (default DEFAULT_CARD_COPY). Pure: every template returns a
 * self-contained HTML page (no external asset) for render.ts to screenshot;
 * every interpolated value is escaped.
 */
export function createCards(theme: Partial<CardTheme> = {}): Cards {
  const brand = theme.brand ?? NEUTRAL_BRAND
  const copy = theme.copy ?? DEFAULT_CARD_COPY
  const c = brand.colors
  const gradient = brand.gradient
  const shadow = (alpha: number) => rgba(c.shadow, alpha)
  /** An <img> for a logo, or nothing when the brand has none. */
  const logo = (cls: string, src: string | null, alt = e(brand.name)) =>
    src ? `<img class="${cls}" src="${src}" alt="${alt}">` : ""

  const stepCode = stateless(copy.stepCode)

  function stepLabel(id: string): { code: string; title: string } {
    const code = stepCode.exec(id)?.[0] ?? ""
    const title = copy.stepTitles[id] ?? (id.slice(code.length).trim() || id)
    return { code, title }
  }

  const latencyLabel = (key: string) => copy.latencyLabels[key] ?? key

  const verdictColour = (verdict: string) =>
    verdict === "PASS" ? c.pass : verdict === "FAIL" ? c.fail : c.neutral

  function introHtml(d: IntroData): string {
    const staging = d.target === "staging"
    return cardPage(
      `.wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:28px}
.logo{width:560px}
h1{font-size:60px;font-weight:700;letter-spacing:-0.5px}
.sub{font-size:24px;opacity:.9;margin-top:-14px}
.pills{display:flex;gap:14px;margin-top:10px}
.pill{font-size:22px;padding:10px 22px;border-radius:999px;background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.45)}
.pill.target{background:#fff;color:${c.primary};font-weight:700;letter-spacing:1px}`,
      `<div class="wrap">
${logo("logo", d.logos.onBrand)}
<h1>${e(copy.run.title)}</h1>
<p class="sub">${e(staging ? copy.run.subtitle.staging : copy.run.subtitle.local)}</p>
<div class="pills">
<span class="pill target">${e(staging ? copy.run.target.staging : copy.run.target.local)}</span>
<span class="pill mono">${e(d.runId)}</span>
<span class="pill">${e(formatUtc(d.startedAt))}</span>
</div>
</div>`,
      gradient,
    )
  }

  function emailHtml(logos: Logos, raw: MailCard): string {
    const card = safe(raw)
    const { code, title } = stepLabel(card.step)
    const sent = card.direction === "sent"
    const f = copy.mail.fields
    const row = (label: string, value: string, extra = "") =>
      value
        ? `<div class="row"><div class="k">${e(label)}</div><div class="v ellipsis ${extra}">${keepTogether(e(value))}</div></div>`
        : ""
    return cardPage(
      `.top{position:absolute;left:64px;right:64px;top:40px;display:flex;align-items:center;justify-content:space-between}
.logo{height:34px}
.step{font-size:22px;opacity:.95}
.step b{background:#fff;color:${c.primary};padding:4px 12px;border-radius:8px;margin-right:10px}
.mail{position:absolute;left:120px;right:120px;top:128px;background:#fff;color:${c.ink};border-radius:20px;
box-shadow:0 24px 60px ${shadow(0.35)};overflow:hidden}
.head{display:flex;align-items:center;gap:14px;padding:22px 36px;background:${c.tint};border-bottom:1px solid ${c.tintLine};
font-size:24px;font-weight:700;color:${c.primary}}
.brand{margin-left:auto;height:26px}
.icon{width:40px;height:40px;border-radius:10px;background:${c.primary};color:#fff;display:flex;align-items:center;justify-content:center;font-size:22px}
.fields{padding:20px 36px 8px}
.row{display:flex;gap:18px;font-size:23px;line-height:1.5;padding:3px 0}
.k{width:130px;flex:none;color:${c.muted}}
.v{flex:1;min-width:0}
.v.subject{font-weight:700;white-space:normal;
display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.body{margin:12px 36px 30px;padding:18px 22px;background:${c.quote};border-left:4px solid ${c.accent};border-radius:8px;
font-size:22px;line-height:1.5;color:${c.body};display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.note{position:absolute;left:0;right:0;bottom:30px;text-align:center;font-size:18px;opacity:.85}`,
      `<div class="top"><span class="step"><b>${e(code || copy.mail.code)}</b>${e(title)}</span>${logo("logo", logos.onBrand)}</div>
<div class="mail">
<div class="head"><span class="icon">${sent ? "&#8599;" : "&#8601;"}</span>${e(sent ? copy.mail.sent : copy.mail.received)}${logo("brand", logos.onLight, "")}</div>
<div class="fields">
${row(f.from, card.from)}
${row(f.to, card.to.join(", "))}
${row(f.replyTo, card.replyTo.join(", "))}
${row(f.subject, card.subject, "subject")}
</div>
${card.excerpt ? `<div class="body">${e(card.excerpt)}</div>` : ""}
</div>
<p class="note">${e(copy.mail.note)}</p>`,
      gradient,
    )
  }

  function outroHtml(d: OutroData): string {
    const colour = verdictColour(d.verdict)
    const mark = (status: string) =>
      status === "passed"
        ? `<span class="m ok">&#10003;</span>`
        : status === "failed"
          ? `<span class="m bad">&#10007;</span>`
          : `<span class="m skip">&ndash;</span>`
    const rows = d.steps
      .map((s) => {
        const { code, title } = stepLabel(s.id)
        return `<div class="tr ${s.status === "failed" ? "failed" : ""}">${mark(s.status)}<b>${e(code)}</b><span class="t ellipsis">${e(title)}</span><span class="st">${e(s.status)}</span><span class="d">${e(seconds(s.durationMs))}</span></div>`
      })
      .join("")
    const latencies = Object.entries(d.latenciesMs)
      .map(
        ([key, value]) =>
          `<li><span>${e(latencyLabel(key))}</span><b>${e(seconds(Number(value)))}</b></li>`,
      )
      .join("")
    return cardPage(
      `.left{position:absolute;left:64px;top:56px;width:400px}
.logo{width:300px}
.verdict{margin-top:40px;display:inline-block;font-size:64px;font-weight:800;letter-spacing:2px;padding:6px 30px;border-radius:16px;background:#fff;color:${colour}}
.reason{margin-top:18px;font-size:21px;line-height:1.4;opacity:.95;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
h3{margin-top:30px;font-size:18px;text-transform:uppercase;letter-spacing:1.5px;opacity:.85}
ul{list-style:none;margin-top:10px;font-size:20px}
li{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.3)}
.run{position:absolute;left:64px;bottom:44px;font-size:18px;opacity:.9}
.table{position:absolute;left:520px;right:64px;top:56px;background:#fff;color:${c.ink};border-radius:20px;padding:14px 26px;
box-shadow:0 24px 60px ${shadow(0.35)}}
.tr{display:flex;align-items:center;gap:14px;height:62px;font-size:22px;border-bottom:1px solid ${c.line}}
.tr:last-child{border-bottom:none}
.tr.failed{color:${c.fail}}
.tr b{width:40px;flex:none}
.t{flex:1;min-width:0}
.st{width:88px;flex:none;color:${c.muted};font-size:18px}
.tr.failed .st{color:${c.fail}}
.d{width:76px;flex:none;text-align:right;font-variant-numeric:tabular-nums}
.m{width:34px;height:34px;flex:none;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:700;color:#fff}
.ok{background:${c.pass}}.bad{background:${c.fail}}.skip{background:${c.skip}}`,
      `<div class="left">
${logo("logo", d.logos.onBrand)}
<div><span class="verdict">${e(d.verdict)}</span></div>
<p class="reason">${e(d.reason)}</p>
${latencies ? `<h3>${e(copy.outro.latencies)}</h3><ul>${latencies}</ul>` : ""}
</div>
<p class="run mono">${e(d.runId)}</p>
<div class="table">${rows || `<div class="tr">${e(copy.outro.noSteps)}</div>`}</div>`,
      gradient,
    )
  }

  function standbyHtml(
    logos: Logos,
    runId: string,
    text: StandbyText = copy.standby,
  ): string {
    return cardPage(
      `.wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;color:${c.ink}}
.logo{width:420px}
h1{font-size:34px;font-weight:700}
p{font-size:22px;color:${c.muted}}`,
      `<div class="wrap">
${logo("logo", logos.onLight)}
<h1>${e(text.heading)}</h1>
<p>${e(text.line)}</p>
<p class="mono">${e(runId)}</p>
</div>`,
      "#fff",
    )
  }

  function frameHtml(
    logos: Logos,
    runId: string,
    target: string,
    title = copy.run.title,
  ): string {
    const strip = (x: number, y: number, w: number, h: number) =>
      `<div class="s" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;background-position:-${x}px -${y}px"></div>`
    const { x, y, width, height } = APP_RECT
    return cardPage(
      `.s{position:absolute;background:${gradient};background-size:${FRAME.width}px ${FRAME.height}px}
.hole{position:absolute;left:${x}px;top:${y}px;width:${width}px;height:${height}px;box-shadow:0 0 0 1px ${shadow(0.25)},0 10px 30px ${shadow(0.35)}}
.label{position:absolute;left:${x}px;top:0;height:${y}px;display:flex;align-items:center;font-size:16px;opacity:.95}
.label b{margin-right:8px}
.wm{position:absolute;right:${FRAME.width - x - width}px;top:9px;height:19px}`,
      `${strip(0, 0, FRAME.width, y)}
${strip(0, y, x, height)}
${strip(x + width, y, FRAME.width - x - width, height)}
${strip(0, CAPTION_TOP, FRAME.width, FRAME.height - CAPTION_TOP)}
<div class="hole"></div>
<div class="label"><b>${e(title)}</b><span class="mono">${e(runId)} · ${e(target)}</span></div>
${logo("wm", logos.onBrand)}`,
    )
  }

  function statusIcon(status: "passed" | "failed", size: number): string {
    const failed = status === "failed"
    const mark = failed
      ? `<path d="M8.5 8.5l7 7M15.5 8.5l-7 7"/>`
      : `<path d="M7.5 12.5l3 3 6-6.5"/>`
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="${failed ? c.fail : c.pass}"/><g fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">${mark}</g></svg>`
  }

  function captionHtml(stepId: string, status: "passed" | "failed"): string {
    const { code, title } = stepLabel(stepId)
    const failed = status === "failed"
    return cardPage(
      `.bar{position:absolute;left:0;top:${CAPTION_TOP}px;width:${FRAME.width}px;height:${FRAME.height - CAPTION_TOP}px;
background:${failed ? c.fail : c.primary};display:flex;align-items:center;gap:16px;padding:0 ${APP_RECT.x}px;font-size:24px}
.code{background:#fff;color:${failed ? c.fail : c.primary};font-weight:800;padding:2px 12px;border-radius:8px}
.title{flex:1;min-width:0;font-weight:600}
.badge{display:flex;align-items:center;gap:8px;background:#fff;border-radius:999px;padding:4px 16px 4px 5px;
font-size:19px;font-weight:700;color:${failed ? c.fail : c.pass};box-shadow:0 1px 3px rgba(0,0,0,.18)}
.badge svg{display:block}`,
      `<div class="bar"><span class="code">${e(code || copy.caption.code)}</span><span class="title ellipsis">${e(title)}</span><span class="badge ${failed ? "failed" : "passed"}">${statusIcon(status, 28)}<span>${e(failed ? copy.caption.failed : copy.caption.passed)}</span></span></div>`,
    )
  }

  const BADGE_CSS = `.b{position:absolute;left:50%;top:5px;transform:translateX(-50%);height:26px;padding:0 14px;border-radius:999px;
background:${rgba(c.ink, 0.75)};display:flex;align-items:center;font-size:15px;font-weight:600;white-space:nowrap}`

  function speedHtml(speed: number): string {
    return cardPage(BADGE_CSS, `<div class="b">${copy.speedBadge(speed)}</div>`)
  }

  function waitHtml(text: string): string {
    return cardPage(
      BADGE_CSS,
      `<div class="b">${copy.waitBadge(e(text))}</div>`,
    )
  }

  function pipelineIntroHtml(d: PipelineIntroData): string {
    const rows = d.stages
      .map(
        (s, i) =>
          `<div class="st"><span class="n">${i + 1}</span><div class="tx"><b>${e(s.title)}</b><span class="ellipsis">${e(s.detail)}</span></div><span class="pill mono">${e(s.runId ?? s.verdict)}</span></div>`,
      )
      .join("")
    return cardPage(
      `.wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px}
.logo{width:460px}
h1{font-size:52px;font-weight:700;letter-spacing:-0.5px}
.sub{font-size:22px;opacity:.9;margin-top:-10px}
.stages{display:flex;flex-direction:column;gap:12px;width:880px;margin-top:8px}
.st{display:flex;align-items:center;gap:18px;padding:14px 22px;border-radius:16px;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.4)}
.n{width:40px;height:40px;flex:none;border-radius:50%;background:#fff;color:${c.primary};font-weight:800;font-size:22px;display:flex;align-items:center;justify-content:center}
.tx{flex:1;min-width:0;display:flex;flex-direction:column;font-size:19px;opacity:.95}
.tx b{font-size:24px}
.pill{flex:none;font-size:18px;padding:8px 16px;border-radius:999px;background:#fff;color:${c.primary};font-weight:700}`,
      `<div class="wrap">
${logo("logo", d.logos.onBrand)}
<h1>${copy.pipeline.heading(e(capitalise(d.module)))}</h1>
<p class="sub"><span class="mono">${e(d.pipelineId)}</span> · ${e(formatUtc(d.startedAt))}</p>
<div class="stages">${rows}</div>
</div>`,
      gradient,
    )
  }

  function chapterHtml(
    logos: Logos,
    index: number,
    stage: PipelineStageCard,
  ): string {
    const note = stage.note
      ? `<div class="note"><span class="v" style="color:${verdictColour(stage.verdict)}">${e(capitalise(stage.verdict))}</span><p>${e(stage.note)}</p></div>`
      : ""
    return cardPage(
      `.wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;padding:0 120px;text-align:center}
.logo{position:absolute;right:64px;top:44px;height:34px}
.k{font-size:22px;letter-spacing:3px;text-transform:uppercase;opacity:.85}
h1{font-size:84px;font-weight:800;letter-spacing:-1px}
.d{font-size:24px;opacity:.95}
.pill{font-size:20px;padding:8px 20px;border-radius:999px;background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.45)}
.note{margin-top:10px;max-width:900px;background:#fff;color:${c.ink};border-radius:18px;padding:20px 30px;box-shadow:0 24px 60px ${shadow(0.35)}}
.note .v{font-size:30px;font-weight:800}
.note p{margin-top:8px;font-size:21px;line-height:1.45;color:${c.body};overflow-wrap:anywhere;
display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}`,
      `${logo("logo", logos.onBrand)}
<div class="wrap">
<p class="k">${e(copy.pipeline.stage(index + 1))}</p>
<h1>${e(stage.title)}</h1>
<p class="d">${e(stage.detail)}</p>
${stage.runId ? `<span class="pill mono">${e(stage.runId)}</span>` : ""}
${note}
</div>`,
      gradient,
    )
  }

  function comparisonHtml(logos: Logos, d: ComparisonData): string {
    const mark = (cell: ComparisonCell | null) => {
      if (!cell) return `<span class="c none">&ndash;</span>`
      const icon =
        cell.status === "passed"
          ? `<span class="m ok">&#10003;</span>`
          : cell.status === "failed"
            ? `<span class="m bad">&#10007;</span>`
            : `<span class="m skip">&ndash;</span>`
      return `<span class="c ${cell.status === "failed" ? "failed" : ""}">${icon}<span class="d">${e(cell.durationMs === null ? cell.status : seconds(cell.durationMs))}</span></span>`
    }
    const head = d.stages
      .map((s) => `<span class="c h">${e(s.title)}</span>`)
      .join("")
    const rows = d.rows
      .map((r) => {
        const { code, title } = stepLabel(r.id)
        return `<div class="tr"><b>${e(code)}</b><span class="t ellipsis">${e(title)}</span>${r.cells.map(mark).join("")}</div>`
      })
      .join("")
    const chips = d.stages
      .map(
        (s) =>
          `<li><span>${e(s.title)}</span><b style="color:${verdictColour(s.verdict)}">${e(s.verdict)}</b></li>`,
      )
      .join("")
    const latencies = d.latencies
      .map(
        (l) =>
          `<div class="lr"><span class="ll ellipsis">${e(l.label)}</span>${l.values.map((v) => `<span class="lv">${e(seconds(v))}</span>`).join("")}</div>`,
      )
      .join("")
    return cardPage(
      `.left{position:absolute;left:56px;top:48px;width:420px}
.logo{width:240px}
.verdict{margin-top:26px;display:inline-block;font-size:48px;font-weight:800;letter-spacing:2px;padding:4px 24px;border-radius:14px;background:#fff;color:${verdictColour(d.verdict)}}
.reason{margin-top:14px;font-size:19px;line-height:1.4;opacity:.95;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
ul{list-style:none;margin-top:16px;background:#fff;border-radius:14px;padding:4px 18px;color:${c.ink}}
li{display:flex;justify-content:space-between;align-items:center;padding:8px 0;font-size:20px;border-bottom:1px solid ${c.line}}
li:last-child{border-bottom:none}
h3{margin-top:22px;font-size:16px;text-transform:uppercase;letter-spacing:1.5px;opacity:.85}
.lt{margin-top:8px;font-size:17px}
.lr{display:flex;gap:10px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.3)}
.lr.h{font-weight:700;opacity:.85}
.ll{flex:1;min-width:0}
.lv{width:104px;flex:none;text-align:right;font-variant-numeric:tabular-nums}
.run{position:absolute;left:56px;bottom:36px;font-size:17px;opacity:.9}
.table{position:absolute;left:510px;right:56px;top:48px;background:#fff;color:${c.ink};border-radius:20px;padding:10px 24px;
box-shadow:0 24px 60px ${shadow(0.35)}}
.tr{display:flex;align-items:center;gap:12px;height:58px;font-size:20px;border-bottom:1px solid ${c.line}}
.tr:last-child{border-bottom:none}
.tr.hd{height:44px;font-size:16px;color:${c.muted};text-transform:uppercase;letter-spacing:1px}
.tr b{width:36px;flex:none}
.t{flex:1;min-width:0}
.c{width:150px;flex:none;display:flex;align-items:center;gap:8px}
.c.failed{color:${c.fail}}
.c.none{color:${c.muted};padding-left:10px}
.d{font-size:17px;font-variant-numeric:tabular-nums}
.m{width:28px;height:28px;flex:none;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:#fff}
.ok{background:${c.pass}}.bad{background:${c.fail}}.skip{background:${c.skip}}`,
      `<div class="left">
${logo("logo", logos.onBrand)}
<div><span class="verdict">${e(d.verdict)}</span></div>
<p class="reason">${e(d.reason)}</p>
<ul>${chips}</ul>
${latencies ? `<h3>${e(copy.outro.latencies)}</h3><div class="lt"><div class="lr h"><span class="ll"></span>${d.stages.map((s) => `<span class="lv">${e(s.title)}</span>`).join("")}</div>${latencies}</div>` : ""}
</div>
<p class="run mono">${e(d.pipelineId)}</p>
<div class="table"><div class="tr hd"><b></b><span class="t">${e(copy.pipeline.step)}</span>${head}</div>${rows || `<div class="tr">${e(copy.outro.noSteps)}</div>`}</div>`,
      gradient,
    )
  }

  return {
    brand,
    copy,
    stepLabel,
    latencyLabel,
    latencyKeys: Object.keys(copy.latencyLabels),
    introHtml,
    emailHtml,
    outroHtml,
    standbyHtml,
    frameHtml,
    statusIcon,
    captionHtml,
    speedHtml,
    waitHtml,
    pipelineIntroHtml,
    chapterHtml,
    comparisonHtml,
  }
}
