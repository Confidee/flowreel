// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "@playwright/test"
import type { TestResult, TestStep } from "@playwright/test/reporter"

import {
  type RoundTripModule,
  type TourModule,
  featureStatus,
  featureTable,
  modulesByKind,
  parseFeatureAnnotation,
  planStepIds,
  stepFailureLocation,
  stepOutcome,
  tourVerdict,
} from "../src/reporter/index.js"

// The reporter's pure rules.

test.describe("feature status and the tour verdict", () => {
  test("status from the result, the skip reason and the view mode", () => {
    expect(featureStatus("passed", null, { mode: "full" }, "local")).toBe(
      "passed",
    )
    expect(featureStatus("passed", null, { mode: "view" }, "staging")).toBe(
      "view-only",
    )
    expect(featureStatus("passed", null, { mode: "view" }, "local")).toBe(
      "passed",
    )
    expect(featureStatus("timedOut", null, null, "local")).toBe("failed")
    expect(
      featureStatus(
        "skipped",
        "development only: x",
        { mode: "full" },
        "staging",
      ),
    ).toBe("dev-only")
    expect(
      featureStatus("skipped", "N/A: something", { mode: "full" }, "staging"),
    ).toBe("N/A")
    // A project's own development-only prefix.
    expect(
      featureStatus("skipped", "dev: x", { mode: "full" }, "staging", "dev: "),
    ).toBe("dev-only")
  })

  test("a test that never recorded its policy through feature() is failed", () => {
    // Ran (passed) without feature(): its policy was never applied.
    expect(featureStatus("passed", null, null, "staging")).toBe("failed")
    expect(featureStatus("passed", null, null, "local")).toBe("failed")
    // A hand-written skip is not feature()'s skip, whatever its text.
    expect(
      featureStatus("skipped", "development only: x", null, "staging"),
    ).toBe("failed")
    // Never started (a failed dependency): not run, not failed.
    expect(featureStatus("skipped", null, null, "staging")).toBe("not run")
    expect(parseFeatureAnnotation(undefined)).toBeNull()
    expect(parseFeatureAnnotation("{oops")).toBeNull()
    expect(parseFeatureAnnotation('{"id":"A4"}')).toBeNull()
    expect(
      parseFeatureAnnotation('{"id":"A4","policy":"both","mode":"sideways"}'),
    ).toBeNull()
    expect(
      parseFeatureAnnotation(
        '{"id":"A4","policy":"both","devOnlyReason":null,"mode":"full"}',
      )?.id,
    ).toBe("A4")
  })

  test("FAIL on a failure, N/A when nothing was verified, else PASS", () => {
    expect(
      tourVerdict([
        { id: "A1", status: "passed" },
        { id: "A2", status: "failed" },
      ]),
    ).toEqual({ verdict: "FAIL", reason: "Failed: A2." })
    expect(tourVerdict([{ id: "G1", status: "dev-only" }]).verdict).toBe("N/A")
    expect(tourVerdict([]).reason).toBe("No tour feature ran.")
    expect(
      tourVerdict([
        { id: "F3", status: "view-only" },
        { id: "G1", status: "dev-only" },
      ]),
    ).toEqual({
      verdict: "PASS",
      reason: "1 tour feature(s) verified, 1 development-only.",
    })
    expect(tourVerdict([{ id: "A1", status: "passed" }]).reason).toBe(
      "1 tour feature(s) verified.",
    )
  })
})

test.describe("stepFailureLocation", () => {
  const SPEC = "/repo/e2e/flows/round-trip.spec.ts"

  function step(errorFile: string | null, children: TestStep[] = []): TestStep {
    return {
      title: "S4 customer receives",
      location: { file: SPEC, line: 120, column: 3 },
      error: errorFile
        ? { message: "x", location: { file: errorFile, line: 9, column: 5 } }
        : { message: "x" },
      steps: children,
    } as unknown as TestStep
  }

  test("a waiter TimeoutError in a library points at the step, not the library", () => {
    const where = stepFailureLocation(step("/repo/e2e/lib/errors.ts"))
    expect(where).toEqual({ file: SPEC, line: 120, column: 3 })
  })

  test("an expect failure in the spec points at the expect line", () => {
    expect(stepFailureLocation(step(SPEC))).toEqual({
      file: SPEC,
      line: 9,
      column: 5,
    })
  })

  test("a failing child located in a library also falls back to the step", () => {
    const child = step("/repo/e2e/lib/poll.ts")
    expect(stepFailureLocation(step(null, [child]))?.line).toBe(120)
  })
})

test.describe("stepOutcome", () => {
  const start = new Date(10_000)
  const step = (duration: number, error?: TestStep["error"]) =>
    ({ duration, error, startTime: new Date(14_000) }) as TestStep
  const result = (status: TestResult["status"]) =>
    ({ status, duration: 9_000, startTime: start }) as TestResult

  test("a finished step keeps its own duration and error", () => {
    expect(stepOutcome(step(1_200), result("passed"))).toEqual({
      failed: false,
      open: false,
      durationMs: 1_200,
    })
    expect(
      stepOutcome(step(1_200, { message: "nope" }), result("failed")),
    ).toEqual({ failed: true, open: false, durationMs: 1_200 })
  })

  test("the step left open by a test timeout failed and ran to the end", () => {
    // Test 10.0 s - 19.0 s, step started at 14.0 s and never ended.
    expect(stepOutcome(step(-1), result("timedOut"))).toEqual({
      failed: true,
      open: true,
      durationMs: 5_000,
    })
    expect(stepOutcome(step(-1), result("interrupted")).failed).toBe(true)
    expect(stepOutcome(step(-1), result("passed")).failed).toBe(false)
  })
})

test.describe("featureTable", () => {
  const row = {
    id: "A1",
    title: "list | views",
    area: "A",
    policy: "both",
    status: "passed" as const,
    reason: null,
    durationMs: 1_500,
    videoAtSec: 75,
    file: "e2e/flows/a.spec.ts",
    line: 3,
  }

  test("rows with clock positions and escaped cells", () => {
    expect(
      featureTable(
        [
          row,
          {
            ...row,
            id: "A2",
            videoAtSec: null,
            durationMs: null,
            reason: "a\nb",
          },
        ],
        null,
      ),
    ).toEqual([
      "## Tour features",
      "",
      "| Feature | Title | Area | Status | Duration | Video at | Note |",
      "|---|---|---|---|---|---|---|",
      "| A1 | list \\| views | A | passed | 1.5s | 1:15 |  |",
      "| A2 | list \\| views | A | passed | — | — | a b |",
    ])
  })

  test("the tour video line: links when produced, the reason when not", () => {
    expect(
      featureTable([], {
        produced: true,
        tour: { path: "r/t.mp4", file: "t one.mp4", durationSec: 12 },
        areas: [{ area: "A", path: "r/a.mp4", file: "a.mp4", durationSec: 3 }],
      })[2],
    ).toBe("Tour video: [t one.mp4](t%20one.mp4) (12.0s). Areas: [A](a.mp4).")
    expect(featureTable([], { produced: false, reason: "off" })[2]).toBe(
      "Tour video: not produced (off).",
    )
  })
})

test.describe("module descriptors", () => {
  const module: RoundTripModule = {
    kind: "round-trip",
    name: "orders",
    project: "orders",
    planStepPattern: /^\|\s*(S\d+ [^|]*?)\s*\|/gm,
    verdictCopy: { passed: "p", notInRun: "n", skipped: "s" },
  }

  test("plan step ids come from the plan table, in order", () => {
    const plan = [
      "# Plan",
      "| Step | What |",
      "|---|---|",
      "| S1 send | the customer writes |",
      "| S2 reply  | the agent answers |",
      "| not a step | x |",
    ].join("\n")
    expect(planStepIds(module, plan)).toEqual(["S1 send", "S2 reply"])
    // Twice in a row: a global pattern keeps no state between calls.
    expect(planStepIds(module, plan)).toEqual(["S1 send", "S2 reply"])
    expect(
      planStepIds(
        { ...module, planStepPattern: /^\|\s*(S\d+ [^|]*?)\s*\|/m },
        plan,
      ),
    ).toEqual(["S1 send", "S2 reply"])
    expect(
      planStepIds({ ...module, planStepPattern: undefined }, plan),
    ).toEqual([])
  })

  test("modules split by kind: exactly one round trip, at most one tour", () => {
    const tour: TourModule = {
      kind: "tour",
      name: "orders-tour",
      isProject: () => false,
      areaOfProject: () => null,
      parseFeatureTitle: () => null,
      parseStepTitle: () => null,
      featureAnnotation: "tour-feature",
      devOnlyPrefix: "development only: ",
    }
    expect(modulesByKind([tour, module])).toEqual({ roundTrip: module, tour })
    expect(modulesByKind([module])).toEqual({
      roundTrip: module,
      tour: undefined,
    })
    expect(() => modulesByKind([tour])).toThrow(
      'modules: expected exactly one "round-trip" module, got 0.',
    )
    expect(() => modulesByKind([module, module])).toThrow(
      'modules: expected exactly one "round-trip" module, got 2.',
    )
    expect(() => modulesByKind([module, tour, tour])).toThrow(
      'modules: expected at most one "tour" module, got 2.',
    )
  })
})
