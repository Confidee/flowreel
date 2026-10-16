import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

import { parseCatalogue } from "@confidee/flowreel/tour"
import { expect, test } from "@playwright/test"

import { E2E_FLOWREEL } from "../../../flowreel.config"
import { TOUR, TOUR_AREAS, TOUR_CATALOGUE } from "../tour"

import { narrationProblems, stepTitles } from "./narration-keys"

// The tour's owner-approved catalogue and its narration:
//   - the committed mirror (tour.ts TOUR_CATALOGUE) equals CATALOGUE.md,
//     so a policy cannot drift from what the owner approved;
//   - every area's narration (narration/tour-<letter>.json) has its frame
//     lines, a line per feature and per step, and no stale key.
// With `typescript` 5.x or 6.x installed, scanAreaSpec() / checkDeclaredFeatures()
// from @confidee/flowreel/tour also check each test() starts with
// feature() and nothing skips outside it.

test("the catalogue mirror equals CATALOGUE.md", () => {
  const document = readFileSync(join(E2E_FLOWREEL, "CATALOGUE.md"), "utf8")
  expect(
    parseCatalogue(document, { letters: TOUR.letters }),
    "change CATALOGUE.md (the owner's) first, then TOUR_CATALOGUE",
  ).toEqual(TOUR_CATALOGUE)
})

for (const area of TOUR_AREAS) {
  const letter = area.letter.toLowerCase()
  test(`tour-${letter}: narration covers every feature and step, and only those`, () => {
    const dir = join(E2E_FLOWREEL, "flows", "tour")
    const specs = readdirSync(dir).filter(
      (f) => f.startsWith(`${letter}-`) && f.endsWith(".spec.ts"),
    )
    expect(specs.length, `a flows/tour/${letter}-<slug>.spec.ts`).toBe(1)
    const steps = stepTitles(join(dir, specs[0]))
    const features = Object.keys(TOUR_CATALOGUE).filter(
      (id) => TOUR.areaOfFeature(id)?.letter === area.letter,
    )
    expect(
      narrationProblems(`tour-${letter}`, {
        frame: ["area", "outro"],
        features,
        steps,
      }),
    ).toEqual([])
  })
}
