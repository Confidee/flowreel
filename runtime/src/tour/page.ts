// SPDX-License-Identifier: Apache-2.0

import type { StorageState } from "../app/personas.js"

// Helpers for the RECORDED page of a tour: swapping the persona it shows
// without signing in, the staging privacy mask, and pausing at the pace.

// ---------------------------------------------------------------------------
// Persona swap
// ---------------------------------------------------------------------------

type Cookie = StorageState["cookies"][number]

/** The slice of a Page that swapPersona touches (unit-testable with a fake). */
export interface PersonaSwapTarget {
  context(): {
    clearCookies(): Promise<void>
    addCookies(
      cookies: (Cookie | { name: string; value: string; url: string })[],
    ): Promise<void>
  }
  url(): string
  reload(): Promise<unknown>
}

/**
 * Replaces the page's cookies with `state`'s (one continuous recording, no
 * sign-in: the sessions come from global setup), adds `keep` (layout
 * cookies the recording relies on) and reloads an app page so the app
 * renders as the new persona. A page that is not an http(s) page yet (a
 * standby card) is not reloaded.
 */
export async function swapPersona(
  page: PersonaSwapTarget,
  state: Pick<StorageState, "cookies">,
  keep: { name: string; value: string; url: string }[] = [],
): Promise<void> {
  const context = page.context()
  await context.clearCookies()
  await context.addCookies([...state.cookies, ...keep])
  if (/^https?:/.test(page.url())) await page.reload()
}

// ---------------------------------------------------------------------------
// Privacy mask (staging recordings)
// ---------------------------------------------------------------------------

/**
 * On staging the recorded page can show real people's data on admin and
 * listing pages. Every table row (and ARIA grid row) is blurred unless its
 * text carries one of the keep-list strings (this run's id, a QA persona or
 * mailbox address): blurred by default (CSS), un-blurred by a script once a
 * row is known to be QA, so no frame shows a real row sharp. Assertion-
 * neutral: a CSS filter changes neither the DOM text nor Playwright's
 * visibility. Development recordings are never masked (seed data only).
 */

/** The keep list: lower-cased, unique, without empty entries. */
export function privacyKeepList(
  values: readonly (string | null | undefined)[],
): string[] {
  return [
    ...new Set(
      values.filter((k): k is string => !!k).map((k) => k.toLowerCase()),
    ),
  ]
}

/** Whether a row with this text stays sharp on a staging recording. */
export function rowKept(text: string, keep: readonly string[]): boolean {
  const value = text.toLowerCase()
  return keep.some((k) => k !== "" && value.includes(k))
}

/**
 * The rows the mask blurs unless marked kept (header rows never), on every
 * page except the ones installPrivacyMask is told to leave alone.
 */
export const PRIVACY_MASK_CSS = `html:not([data-qa-unmasked]) tbody tr:not([data-qa-keep]), html:not([data-qa-unmasked]) [role="row"]:not([data-qa-keep]):not(thead [role="row"]):not(:has([role="columnheader"])) { filter: blur(7px) !important; }`

// The browser globals installPrivacyMask uses (the runtime compiles without
// the DOM library; the function body runs in the page, not in Node).
interface MaskNode {
  textContent: string | null
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  appendChild(node: unknown): unknown
  id: string
}
declare const document: {
  documentElement: MaskNode | null
  getElementById(id: string): unknown
  createElement(tag: string): MaskNode
  querySelectorAll(selector: string): Iterable<MaskNode>
  addEventListener(type: string, listener: () => void): void
}
declare const window: { location: { pathname: string } }
declare const MutationObserver: new (callback: () => void) => {
  observe(target: unknown, options: Record<string, boolean>): void
}

/**
 * Runs in the recorded page (addInitScript; self-contained): injects the
 * blur CSS as soon as the document exists and marks QA rows kept on every
 * DOM change. Pages whose path matches `unmasked` (a regex source) are not
 * masked. Attribute writes are not observed, so it never loops.
 */
export function installPrivacyMask(args: {
  keep: string[]
  css: string
  unmasked: string
}) {
  const ROWS = 'tbody tr, [role="row"]'
  const id = "qa-privacy-mask"
  const unmasked = new RegExp(args.unmasked)
  const ensureStyle = () => {
    if (document.getElementById(id) || !document.documentElement) return
    const style = document.createElement("style")
    style.id = id
    style.textContent = args.css
    document.documentElement.appendChild(style)
  }
  const mark = () => {
    ensureStyle()
    const root = document.documentElement
    if (root) {
      if (unmasked.test(window.location.pathname)) {
        root.setAttribute("data-qa-unmasked", "")
      } else root.removeAttribute("data-qa-unmasked")
    }
    for (const row of document.querySelectorAll(ROWS)) {
      const text = (row.textContent ?? "").toLowerCase()
      const kept = args.keep.some((k) => k !== "" && text.includes(k))
      if (kept) row.setAttribute("data-qa-keep", "")
      else row.removeAttribute("data-qa-keep")
    }
  }
  ensureStyle()
  new MutationObserver(mark).observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
  })
  document.addEventListener("DOMContentLoaded", mark)
}

/** Avatar images the recorded page never waits on (fail them at once). */
export const GRAVATAR_URLS = /^https:\/\/([a-z0-9-]+\.)?gravatar\.com\//

// ---------------------------------------------------------------------------
// Pace
// ---------------------------------------------------------------------------

/** Holds `ms` (nothing at 0): the pause after a key assertion. */
export function pauseFor(ms: number): Promise<void> {
  return ms > 0
    ? new Promise((done) => setTimeout(done, ms))
    : Promise.resolve()
}
