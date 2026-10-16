// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "@playwright/test"

import { ConfigError } from "../src/core/errors.js"
import {
  type CleanupAdapter,
  cleanUpRunRecords,
  cleanupCandidates,
  cleanupLine,
  currentRunId,
  fileCounter,
  fillRunId,
  interpolateText,
  jsonTexts,
  makePipelineId,
  makeRunId,
  nextRoundRobin,
  runMarker,
  runStartOf,
  runSubject,
  stampedId,
} from "../src/run/index.js"

// The run module: run ids, the texts a flow sends, round-robin rotation
// between runs and the off-camera cleanup of a run's records.

const at = new Date(Date.UTC(2026, 9, 13, 9, 5))

test.describe("run ids", () => {
  test("<prefix>-YYYYMMDD-HHMM-xxxx in UTC, four hex digits", () => {
    expect(stampedId("x", at, () => 0)).toBe("x-20261013-0905-0000")
    expect(makeRunId("staging", at, () => 0.5)).toBe("stg-20261013-0905-8000")
    expect(makeRunId("local", at, () => 0.99999)).toMatch(
      /^loc-20261013-0905-[0-9a-f]{4}$/,
    )
    expect(makePipelineId(at, () => 0)).toBe("pipe-20261013-0905-0000")
    expect(
      makeRunId("local", at, () => 0, {
        local: "dev",
        staging: "s",
        pipeline: "p",
      }),
    ).toBe("dev-20261013-0905-0000")
  })

  test("a run's start from its stamp", () => {
    expect(runStartOf("stg-20261013-0905-abcd")).toBe(at.getTime())
    expect(runStartOf("custom")).toBeNull()
  })

  test("currentRunId reads FLOWREEL_RUN_ID; unset names the variable", () => {
    expect(currentRunId({ FLOWREEL_RUN_ID: "loc-1" })).toBe("loc-1")
    expect(() => currentRunId({})).toThrow(ConfigError)
    expect(() => currentRunId({ FLOWREEL_RUN_ID: "" })).toThrow(
      "FLOWREEL_RUN_ID is not set; the Playwright config must set it before workers start.",
    )
    expect(() => currentRunId({}, { label: "MY_RUN", hint: "set it" })).toThrow(
      "MY_RUN is not set; set it.",
    )
  })
})

test.describe("texts", () => {
  test("raw strings, has(), unknown keys, read once", () => {
    const dir = mkdtempSync(join(tmpdir(), "flowreel-texts-"))
    try {
      const file = join(dir, "texts.json")
      writeFileSync(file, JSON.stringify({ subjects: { s: "Hi {RUN_ID}" } }))
      const texts = jsonTexts(file)
      expect(texts.raw("subjects", "s")).toBe("Hi {RUN_ID}")
      expect(texts.has("bodies", "b")).toBe(false)
      expect(() => texts.raw("bodies", "b")).toThrow(
        `Unknown bodies key "b" in ${file}.`,
      )
      // Read once: a later change on disk is not seen.
      writeFileSync(file, "{}")
      expect(texts.has("subjects", "s")).toBe(true)
      const custom = jsonTexts(file, { missing: (g, k) => `no ${g}.${k}` })
      expect(() => custom.raw("subjects", "s")).toThrow("no subjects.s")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("placeholders: RUN_ID only, or strict", () => {
    expect(fillRunId("{RUN_ID}/{RUN_ID} {OTHER}", "r")).toBe("r/r {OTHER}")
    expect(
      interpolateText("{RUN_ID} {FEATURE}", { RUN_ID: "r", FEATURE: "A1" }),
    ).toBe("r A1")
    expect(() => interpolateText("{NOPE}", {})).toThrow(
      "Text placeholder {NOPE} has no value.",
    )
    expect(interpolateText("{lower} {}", {})).toBe("{lower} {}")
    expect(runSubject("r", "x")).toBe("[QA r] x")
    expect(runMarker("r")).toBe("[QA r]")
  })
})

test.describe("round robin", () => {
  test("rotates, persists, wraps; a corrupt counter restarts", () => {
    let value: string | undefined
    const store = { read: () => value, write: (v: string) => void (value = v) }
    expect(
      ["a", "b"].map(() => nextRoundRobin(["a", "b", "c"], store)),
    ).toEqual(["a", "b"])
    expect(nextRoundRobin(["a", "b", "c"], store)).toBe("c")
    expect(nextRoundRobin(["a", "b", "c"], store)).toBe("a")
    value = "7"
    expect(nextRoundRobin(["a", "b"], store)).toBe("b")
    value = "junk"
    expect(nextRoundRobin(["a", "b"], store)).toBe("a")
    expect(() => nextRoundRobin([], store, "none")).toThrow("none")
  })

  test("the file counter creates its folder and treats a missing file as unset", () => {
    const dir = mkdtempSync(join(tmpdir(), "flowreel-counter-"))
    try {
      const counter = fileCounter(join(dir, "a", "b", "counter"))
      expect(counter.read()).toBeUndefined()
      counter.write("3")
      expect(counter.read()).toBe("3")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

test.describe("cleanup", () => {
  const ADAPTER: CleanupAdapter = {
    isRecordNumber: (n) => /^REC-\d+$/.test(n),
    doneStatuses: new Set(["done", "archived"]),
  }
  const RUN = "stg-20261013-0905-abcd"

  test("only tracked numbers and this run's marked rows, of the adapter's shape", () => {
    expect(
      cleanupCandidates(
        ADAPTER,
        RUN,
        ["REC-1", "REC-1", "nope"],
        [
          { number: "REC-2", subject: `[QA ${RUN}] x` },
          { number: "REC-3", subject: "[QA other] y" },
          { number: "OTHER-4", subject: `[QA ${RUN}] z` },
          { number: "REC-5", subject: `[QA ${RUN}] skipped` },
        ],
        new Set(["REC-5"]),
      ),
    ).toEqual(["REC-1", "REC-2"])
  })

  test("solves open ones; done, unreadable and refused are reported; never throws", async () => {
    const solved: string[] = []
    const result = await cleanUpRunRecords(ADAPTER, RUN, {
      tracked: ["REC-1", "REC-2", "REC-3", "REC-4"],
      listOpen: [
        () => Promise.reject(new Error("listing down")),
        () => Promise.resolve([{ number: "REC-5", subject: `[QA ${RUN}] a` }]),
      ],
      status: [
        (n) =>
          n === "REC-3"
            ? Promise.reject(new Error("hidden"))
            : Promise.resolve(
                {
                  "REC-1": "open",
                  "REC-2": "done",
                  "REC-4": "open",
                  "REC-5": "open",
                }[n]!,
              ),
      ],
      solve: [
        (n) =>
          n === "REC-4"
            ? Promise.reject(new Error("\nrefused\nmore"))
            : (solved.push(n), Promise.resolve()),
        (n) =>
          n === "REC-4"
            ? Promise.reject(new Error("also refused"))
            : Promise.resolve(),
      ],
    })
    expect(result).toEqual({
      solved: ["REC-1", "REC-5"],
      done: ["REC-2"],
      unreadable: ["REC-3"],
      failed: [{ number: "REC-4", error: "also refused" }],
    })
    expect(solved).toEqual(["REC-1", "REC-5"])
    expect(cleanupLine("A1", result)).toBe(
      "[flowreel] A1: QA records off camera: solved REC-1, REC-5; COULD NOT SOLVE REC-4 (also refused); not readable by any QA persona (deleted or restricted) REC-3.",
    )
    expect(
      cleanupLine(
        "A1",
        { solved: [], done: [], unreadable: [], failed: [] },
        { logPrefix: "app", noun: "items" },
      ),
    ).toBe("[app] A1: items off camera: nothing open.")
  })
})
