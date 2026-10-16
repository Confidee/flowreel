import { readFileSync } from "node:fs"

import { videoKit } from "../brand"

// Shared by the unit specs: the step titles a flow file declares and what
// is wrong with a module's narration file against them. A helper, not a
// spec (unit.config.ts runs *.spec.ts only).

/** Keys that frame a video rather than name a step or a feature. */
const FRAME_KEYS = new Set([
  "intro",
  "outro",
  "outro.pass",
  "outro.fail",
  "outro.n/a",
  "area",
])

const STEP_CALL = /\btest\.step\(\s*(["'`])((?:(?!\1)[^\\]|\\.)+?)\1/g

/**
 * Every literal `test.step("…")` title in a flow file. A title built at run
 * time (a variable, a `${…}` template) is not seen: give such steps a line
 * under their step code, which every variant shares.
 */
export function stepTitles(file: string): string[] {
  return [...readFileSync(file, "utf8").matchAll(STEP_CALL)]
    .map((m) => m[2])
    .filter((title) => !title.includes("${"))
}

export interface NarrationExpectations {
  /** Frame keys this video must have ("intro" / "area", "outro"). */
  frame: string[]
  /** Feature ids whose title card needs a line (tour areas). */
  features?: string[]
  /** Every step title the module's flows declare. */
  steps: string[]
}

/**
 * The problems of narration/<module>.json: a missing frame, feature or step
 * line, a key that names nothing (stale), a line with something
 * never-speak in it, or a line that is not a sentence.
 */
export function narrationProblems(
  module: string,
  expected: NarrationExpectations,
): string[] {
  const kit = videoKit()
  const lines = kit.lines(module)
  const file = `narration/${module}.json`
  const problems: string[] = []
  const features = expected.features ?? []
  const codes = new Set(expected.steps.map((t) => kit.narration.stepCode(t)))

  for (const key of [...expected.frame, ...features]) {
    if (!lines[key]) problems.push(`${file}: no "${key}" line`)
  }
  for (const title of expected.steps) {
    const code = kit.narration.stepCode(title)
    if (!lines[title] && !(code && lines[code])) {
      problems.push(`${file}: step "${title}" has no line (key "${code}")`)
    }
  }
  for (const [key, value] of Object.entries(lines)) {
    const email = /^(.+)\.email(?:\.\d+)?$/.exec(key)
    const named = email ? email[1] : key
    const known =
      FRAME_KEYS.has(key) ||
      features.includes(named) ||
      codes.has(named) ||
      expected.steps.includes(named)
    if (!known) problems.push(`${file}: "${key}" names no step or feature`)
    const unspeakable = kit.narration.unspeakableParts(value)
    if (unspeakable.length > 0) {
      problems.push(
        `${file}: "${key}" says ${unspeakable.map((p) => JSON.stringify(p)).join(", ")}`,
      )
    }
    if (!/[.!?]$/.test(value.trim())) {
      problems.push(`${file}: "${key}" does not end as a sentence`)
    }
  }
  return problems
}
