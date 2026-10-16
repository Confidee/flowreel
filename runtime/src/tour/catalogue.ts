// SPDX-License-Identifier: Apache-2.0

import { ConfigError } from "../core/errors.js"

import type { CatalogueEntry, TourManifest } from "./manifest.js"
import type { FeatureOptions, Policy } from "./policy.js"

// The feature catalogue: every feature's slug and owner-approved staging
// policy. A project keeps its catalogue as a markdown document (the
// inventory) and a committed mirror the runtime checks against; this file
// parses the document (so a test can prove the two equal) and refuses a
// feature() whose policy is not the catalogue's.

export interface ParseCatalogueOptions {
  /** The area letters (TourManifest.letters); default A-Z. */
  letters?: string
  /** The document's name in errors (default "CATALOGUE.md"). */
  file?: string
}

/**
 * Parses a catalogue document into { id: { slug, policy } }. Rules (the
 * catalogue's own legend): the first cell is "<id> <slug>"; the policy is
 * the table's Policy column, read by its leading word ("both+undo …",
 * "both (…)", "dev (…)"), where "dev; staging `view`" is `view`
 * (development runs the full flow, staging renders read-only). A section
 * titled "(dev only)" has no Policy column: its rows are `dev`, except a
 * row whose notes name the page the section's "Staging: `view` of
 * `<path>`" line allows, which is `view`.
 */
export function parseCatalogue(
  markdown: string,
  options: ParseCatalogueOptions = {},
): Record<string, CatalogueEntry> {
  const head = new RegExp(`^([${options.letters ?? "A-Z"}]\\d{1,2})\\s+(\\S+)$`)
  const file = options.file ?? "CATALOGUE.md"
  const out: Record<string, CatalogueEntry> = {}
  let devOnly = false
  let stagingViewPath: string | null = null
  let policyColumn = -1
  const cells = (line: string) =>
    line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((c) => c.trim())
  for (const line of markdown.split("\n")) {
    if (line.startsWith("## ")) {
      devOnly = /\(dev only\)/i.test(line)
      stagingViewPath = null
      policyColumn = -1
      continue
    }
    const view = /^Reason:.*Staging: `view` of `([^`]+)`/.exec(line)
    if (view) stagingViewPath = view[1]
    if (!line.startsWith("|")) continue
    const row = cells(line)
    if (row[0] === "id") {
      policyColumn = row.indexOf("Policy")
      continue
    }
    const m = head.exec(row[0])
    if (!m) continue
    const [, id, slug] = m
    let policy: Policy
    if (devOnly) {
      policy =
        stagingViewPath &&
        row.slice(1).some((c) => c.includes(stagingViewPath!))
          ? "view"
          : "dev"
    } else {
      const raw = policyColumn >= 0 ? (row[policyColumn] ?? "") : ""
      policy = policyOfCell(raw, id, file)
    }
    out[id] = { slug, policy }
  }
  return out
}

function policyOfCell(raw: string, id: string, file: string): Policy {
  if (/^dev\b.*staging\s+`view`/.test(raw)) return "view"
  const word = /^(both\+undo|both|dev|view)\b/.exec(raw)
  if (!word) {
    throw new ConfigError(
      `${file}: feature ${id} has no recognisable policy (${JSON.stringify(raw)}).`,
    )
  }
  return word[1] as Policy
}

export interface CataloguePolicyOptions {
  /** Where the catalogue lives, for the "not in the catalogue" message. */
  source?: string
  /** What to change first, for the policy-mismatch message. */
  change?: string
}

/**
 * Refuses a feature whose declared policy is not the catalogue's (the
 * staging policy is the owner's decision, not the flow's).
 */
export function assertCataloguePolicy(
  options: Pick<FeatureOptions, "id" | "policy">,
  catalogue: TourManifest["catalogue"],
  messages: CataloguePolicyOptions = {},
): CatalogueEntry {
  const entry = catalogue[options.id]
  if (!entry) {
    throw new ConfigError(
      `feature(): ${options.id} is not in the tour catalogue${messages.source ? ` (${messages.source})` : ""}.`,
    )
  }
  if (entry.policy !== options.policy) {
    throw new ConfigError(
      `feature(): ${options.id} declares policy "${options.policy}" but the catalogue says "${entry.policy}" (owner-approved; change ${messages.change ?? "the catalogue"} first, never the flow alone).`,
    )
  }
  return entry
}
