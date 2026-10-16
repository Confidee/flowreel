import { join } from "node:path"

import { expect, test } from "@playwright/test"

import { E2E_FLOWREEL } from "../../../flowreel.config"

import { narrationProblems, stepTitles } from "./narration-keys"

// The round trip's narration (narration/smoke.json) against its flow: every
// step has a line, no line names a step that no longer exists, and nothing
// in a line is never-speak. Rename together with the round trip.

test("the round trip's narration covers every step, and only those", () => {
  const steps = stepTitles(join(E2E_FLOWREEL, "flows", "smoke.spec.ts"))
  expect(steps.length, "the flow declares its steps").toBeGreaterThan(0)
  expect(
    narrationProblems("smoke", { frame: ["intro", "outro"], steps }),
  ).toEqual([])
})
