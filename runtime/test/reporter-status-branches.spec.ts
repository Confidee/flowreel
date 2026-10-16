// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "@playwright/test"
import type { TestStep } from "@playwright/test/reporter"

import { featureStatus, stepFailureLocation } from "../src/reporter/index.js"

// The reporter's pure rules: the remaining status and location branches.

const at = (file: string, line: number) => ({ file, line, column: 1 })

test.describe("feature status", () => {
  test("a status that is neither passed, skipped nor failed is not run", () => {
    expect(featureStatus("weird", null, { mode: "full" }, "local")).toBe(
      "not run",
    )
  })

  test("view-only needs both staging and view mode", () => {
    expect(featureStatus("passed", null, { mode: "full" }, "staging")).toBe(
      "passed",
    )
    expect(featureStatus("passed", null, { mode: "view" }, "staging")).toBe(
      "view-only",
    )
  })
})

test.describe("a failed step's location", () => {
  test("a failing child without its own location falls back to nothing deeper", () => {
    const step = {
      title: "S1",
      location: at("/spec.ts", 5),
      steps: [{ title: "c", error: { message: "x" }, steps: [] }],
    } as unknown as TestStep
    // The child has neither a location nor a deeper one: the step itself.
    expect(stepFailureLocation(step)).toEqual(at("/spec.ts", 5))
  })

  test("a step without a location reports the deeper failure as is", () => {
    const step = {
      title: "S1",
      steps: [
        {
          title: "c",
          error: { message: "x", location: at("/lib.ts", 9) },
          steps: [],
        },
      ],
    } as unknown as TestStep
    expect(stepFailureLocation(step)).toEqual(at("/lib.ts", 9))
  })

  test("a failing child with a location of its own in the same file is used", () => {
    const step = {
      title: "S1",
      location: at("/spec.ts", 5),
      steps: [
        {
          title: "c",
          error: { message: "x" },
          location: at("/spec.ts", 8),
          steps: [],
        },
      ],
    } as unknown as TestStep
    expect(stepFailureLocation(step)).toEqual(at("/spec.ts", 8))
  })
})
