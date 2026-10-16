// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "@playwright/test"

import { registerEnvAliases } from "../src/core/env.js"
import {
  EXIT,
  type PipelineArgsSpec,
  UsageError,
  configProblemOf,
  parsePipelineArgs,
  preferredEnvName,
  stageEnv,
  stageVerdictFrom,
} from "../src/pipeline/index.js"
import { parsePace } from "../src/tour/policy.js"

// Argument, env and verdict edges of the pipeline module that pipeline.spec
// does not reach: inline and flag-like values, the project's own wording,
// registered legacy env names, and verdicts for a child killed by a signal.

const SPEC: PipelineArgsSpec<"gate" | "tour"> = {
  modules: ["gate", "tour"],
  defaultModule: "gate",
  tourModules: ["tour"],
  parseAreas: (raw) => raw.split(","),
  parsePace: (raw) => parsePace(raw, "--pace"),
}

function refusal(
  argv: string[],
  spec: PipelineArgsSpec<"gate" | "tour"> = SPEC,
) {
  try {
    parsePipelineArgs(argv, spec)
  } catch (error) {
    expect(error).toBeInstanceOf(UsageError)
    return (error as Error).message
  }
  throw new Error(`expected a usage error for ${argv.join(" ")}`)
}

test.describe("arguments", () => {
  test("a flag where a value belongs is a missing value, not the value", () => {
    expect(refusal(["--module", "--local"])).toBe(
      "--module needs a name (e.g. --module gate).",
    )
    expect(refusal(["--module", "tour", "--area", "--local"])).toBe(
      "--area needs letters (e.g. --area A,C).",
    )
    expect(refusal(["--module", "tour", "--pace", "--local"])).toBe(
      "--pace needs demo or qa.",
    )
    expect(refusal(["--module="])).toBe(
      "--module needs a name (e.g. --module gate).",
    )
  })

  test("the project words its own --area noun and example", () => {
    expect(
      refusal(["--module", "tour", "--area"], {
        ...SPEC,
        areaNoun: "area letters",
        areaExample: "B,D",
      }),
    ).toBe("--area needs area letters (e.g. --area B,D).")
  })

  test("inline values, -h, and --narration without a value", () => {
    expect(
      parsePipelineArgs(
        ["--module=tour", "--area=A,B", "--pace=QA", "--narration=OFF", "-h"],
        SPEC,
      ),
    ).toMatchObject({
      module: "tour",
      areas: ["A", "B"],
      pace: "qa",
      narration: "off",
      help: true,
    })
    expect(parsePipelineArgs(["--help"], SPEC).help).toBe(true)
    expect(refusal(["--narration"])).toBe("--narration needs on or off.")
    expect(refusal(["--headed=1"])).toBe("--headed takes no value.")
    expect(refusal(["--no-video=1"])).toBe("--no-video takes no value.")
    expect(refusal(["--staging-only=1"])).toBe("--staging-only takes no value.")
    expect(refusal(["--keep-db=1", "--module", "tour"])).toBe(
      "--keep-db takes no value.",
    )
  })

  test("--area and --pace refuse a non-tour module, naming the tours", () => {
    expect(refusal(["--area", "A"])).toBe(
      "--area, --pace and --keep-db apply to --module tour only.",
    )
    expect(refusal(["--pace", "demo"])).toBe(
      "--area, --pace and --keep-db apply to --module tour only.",
    )
  })
})

test.describe("stage env with legacy names", () => {
  test("a registered legacy name is the preferred one", () => {
    // A key no other spec reads, so the registration cannot leak into them.
    registerEnvAliases({ PIPELINE_EDGES_KEY: ["APP_PIPELINE_EDGES"] })
    expect(preferredEnvName("PIPELINE_EDGES_KEY")).toBe("APP_PIPELINE_EDGES")
  })

  test("the project's session prefixes are never inherited", () => {
    const env = stageEnv(
      "staging",
      "r1",
      { APP_STATE_AGENT: "{}", FLOWREEL_STATE_AGENT: "{}", PATH: "/bin" },
      { headed: false, video: true },
      { isSecret: () => false, statePrefixes: ["APP_STATE_"] },
    )
    expect(env.APP_STATE_AGENT).toBeUndefined()
    expect(env.FLOWREEL_STATE_AGENT).toBeUndefined()
    expect(env.PATH).toBe("/bin")
  })
})

test.describe("verdicts for a child killed by a signal", () => {
  test("no summary: FAIL naming the signal", () => {
    expect(stageVerdictFrom("development", null, null)).toEqual({
      stage: "development",
      verdict: "FAIL",
      reason: "no summary written (playwright exited by signal)",
    })
  })

  test("a PASS summary from a killed child is a FAIL", () => {
    expect(
      stageVerdictFrom("staging", { verdict: "PASS" }, null),
    ).toMatchObject({
      verdict: "FAIL",
      reason: "playwright exited by signal after a PASS summary",
    })
  })

  test("a failed restore keeps exit 1 PASS-compatible but a signal does not hide it", () => {
    const result = stageVerdictFrom("staging", { verdict: "PASS" }, null, 2)
    expect(result).toMatchObject({ verdict: "FAIL", undoFailed: 2 })
    // Exit 1 with unrestored changes keeps the verdict; the undo count carries the exit 4.
    expect(
      stageVerdictFrom("staging", { verdict: "PASS" }, 1, 2),
    ).toMatchObject({ verdict: "PASS", undoFailed: 2 })
    expect(EXIT.undoFailed).toBe(4)
  })
})

test("configProblemOf: the first line of any error, capped at 300 characters", () => {
  expect(configProblemOf("plain text")).toBe("plain text")
  expect(configProblemOf(new Error(`${"y".repeat(400)}\nsecond`))).toHaveLength(
    300,
  )
  expect(
    configProblemOf(new Error("Missing required staging config: A, B.")),
  ).toBe("missing A, B")
})
