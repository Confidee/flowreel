// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs"

import { ConfigError } from "../core/errors.js"

// Every string a flow sends or types lives in a texts file (JSON:
// { "subjects": { key: text }, "bodies": { key: text } }), so a project can
// scan all of them with one guard (a forbidden-vocabulary check, say)
// before anything reaches the app under test. Placeholders are
// `{NAME}`: `{RUN_ID}` always, others per call.

export type TextGroup = "subjects" | "bodies"
export type Texts = Record<TextGroup, Record<string, string>>

/** Where a flow's strings come from. */
export interface TextsSource {
  /** True when the key exists in the group. */
  has(group: TextGroup, key: string): boolean
  /** The raw string (placeholders not filled); throws for an unknown key. */
  raw(group: TextGroup, key: string): string
}

export interface JsonTextsOptions {
  /** The message for an unknown key (default names the file). */
  missing?: (group: TextGroup, key: string) => string
}

/**
 * A texts file, read once on first use (read, not imported, so it works
 * under any loader without a JSON import attribute).
 */
export function jsonTexts(
  file: string,
  options: JsonTextsOptions = {},
): TextsSource & { readonly file: string } {
  let texts: Texts | undefined
  const load = (): Texts => {
    if (!texts) {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Texts>
      texts = { subjects: raw.subjects ?? {}, bodies: raw.bodies ?? {} }
    }
    return texts
  }
  return {
    file,
    has: (group, key) => load()[group][key] !== undefined,
    raw(group, key) {
      const value = load()[group][key]
      if (value === undefined) {
        throw new ConfigError(
          options.missing?.(group, key) ??
            `Unknown ${group} key "${key}" in ${file}.`,
        )
      }
      return value
    },
  }
}

/** Replaces every `{RUN_ID}`; other braces are left as they are. */
export function fillRunId(value: string, runId: string): string {
  return value.replaceAll("{RUN_ID}", runId)
}

/**
 * Strict: `{NAME}` placeholders are replaced from `vars`, and an unknown
 * placeholder is an error, so a typo never reaches the app.
 */
export function interpolateText(
  value: string,
  vars: Record<string, string>,
): string {
  return value.replace(/\{([A-Z][A-Z0-9_]*)\}/g, (_, name: string) => {
    if (!(name in vars)) {
      throw new ConfigError(`Text placeholder {${name}} has no value.`)
    }
    return vars[name]
  })
}

/** The marker every run-created subject starts with: "[QA <RUN_ID>]". */
export const runMarker = (runId: string) => `[QA ${runId}]`

/** "[QA <RUN_ID>] <text>": a subject the run (and its cleanup) can find. */
export function runSubject(runId: string, text: string): string {
  return `${runMarker(runId)} ${text}`
}
