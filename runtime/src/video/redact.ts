// SPDX-License-Identifier: Apache-2.0

// Redaction for the branded run video. Email cards show
// From/To/Reply-To/Subject and a body excerpt, but `reply+<token>` /
// `notify+<token>` addresses (which thread a reply into the app's record)
// must never appear on screen. Applied when the test records a card AND
// again when the card is rendered, so a log written by an older harness is
// still safe.

/** `reply+<token>@` / `notify+<token>@` keep only the prefix and domain. */
const THREAD_TOKEN = /\b(reply|notify)\+[^\s@<>"',;]+@/gi

/** Any other plus tag long enough to be a token (`test+agent@` stays). */
const LONG_PLUS_TAG = /\b([A-Za-z0-9._-]+)\+[^\s@<>"',;]{16,}@/g

/** Links can carry tokens (unsubscribe, portal, tracking): never shown. */
const URL = /\b(?:https?|mailto):[^\s<>"')\]]+/gi

/**
 * Opaque runs (base64/hex/JWT-ish) of 32+ chars with a digit somewhere, so a
 * "-----" rule line survives. RUN_IDs are 22 chars.
 */
const OPAQUE = /(?=[A-Za-z_\-+/=]*\d)[A-Za-z0-9_\-+/=]{32,}/g

/** Redacts tokens in one address or address-bearing header value. */
export function redactAddress(value: string): string {
  return value
    .replace(THREAD_TOKEN, (_match, prefix: string) => `${prefix}+…@`)
    .replace(LONG_PLUS_TAG, (_match, local: string) => `${local}+…@`)
}

/** Redacts tokens, links and opaque strings in free text. */
export function redactText(value: string): string {
  return redactAddress(value)
    .replace(URL, "[link]")
    .replace(OPAQUE, "[redacted]")
}

/** Rule lines ("-----", "=====") and the mail layout's reply marker. */
const RULE = /^\s*[-=_*~]{3,}\s*$/
const REPLY_MARKER = /reply above this line/i
/**
 * A non-production "Email Intercepted" banner (a common mail-sandbox
 * layout): a heading, then the recipient and environment lines. A text part
 * closes it with a rule; Graph's text rendering of an HTML part has no rule,
 * so the banner ends at the first line that is none of these.
 */
const INTERCEPT_START = /^\s*Email Intercepted\s*$/i
const INTERCEPT_LINE = /^\s*(?:Intended Recipient|Environment)\s*:/i

/**
 * A short, single-paragraph body excerpt for a card: quoted history (lines
 * starting with ">" and everything from an "On … wrote:" line), rule lines,
 * the reply marker and the interception banner are dropped, whitespace
 * collapsed, and the result cut at a word boundary. With `focus` (text the
 * step expects in the body, e.g. the agent's reply) the excerpt is the
 * paragraph holding it, starting at the focus, instead of the mail layout's
 * header.
 */
export function excerpt(body: string, max = 220, focus?: string): string {
  const lines: string[] = []
  let banner = false
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*On .+wrote:\s*$/.test(line)) break
    if (INTERCEPT_START.test(line)) {
      banner = true
      continue
    }
    if (banner) {
      if (RULE.test(line) || INTERCEPT_LINE.test(line) || !line.trim()) {
        continue
      }
      banner = false
    }
    if (/^\s*>/.test(line) || RULE.test(line) || REPLY_MARKER.test(line)) {
      continue
    }
    lines.push(line)
  }
  const squash = (text: string) => redactText(text).replace(/\s+/g, " ").trim()
  let flat = squash(lines.join(" "))
  const wanted = focus ? squash(focus) : ""
  if (wanted) {
    // The paragraph holding the focus text, so a layout footer after it
    // ("Product | www… | Copyright…") does not crowd the card.
    const paragraph = lines
      .join("\n")
      .split(/\n\s*\n/)
      .map(squash)
      .find((p) => p.includes(wanted))
    const at = (paragraph ?? flat).indexOf(wanted)
    if (paragraph !== undefined && at >= 0) {
      flat = at > 0 ? `…${paragraph.slice(at)}` : paragraph
    } else if (at > 0) {
      flat = `…${flat.slice(at)}`
    }
  }
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max)
  const space = cut.lastIndexOf(" ")
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}
