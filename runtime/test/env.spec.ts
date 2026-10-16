// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "@playwright/test"

import {
  envName,
  envNames,
  envValue,
  envVar,
  registerEnvAliases,
} from "../src/core/env.js"

// FLOWREEL_* first, then the aliases a project registered, in order; unset
// and empty values fall through; messages name the variable that was
// actually set. flowreel registers no alias of its own. Keys here are
// test-only so the shared registry never leaks into other specs.

test("flowreel itself registers no alias: only FLOWREEL_<KEY> is read", () => {
  // No runtime spec registers VIDEO, so this is the built-in map.
  expect(envNames("VIDEO")).toEqual(["FLOWREEL_VIDEO"])
  expect(envValue({ FLOWREEL_VIDEO: "off" }, "VIDEO")).toBe("off")
  expect(envName({}, "VIDEO")).toBe("FLOWREEL_VIDEO")
})

test("FLOWREEL_<KEY> is read first, then a registered alias", () => {
  registerEnvAliases({ ENV_SPEC_FIRST: ["LEGACY_FIRST"] })
  expect(envNames("ENV_SPEC_FIRST")).toEqual([
    "FLOWREEL_ENV_SPEC_FIRST",
    "LEGACY_FIRST",
  ])
  expect(envValue({ LEGACY_FIRST: "Ava" }, "ENV_SPEC_FIRST")).toBe("Ava")
  expect(
    envValue(
      { FLOWREEL_ENV_SPEC_FIRST: "Zoe", LEGACY_FIRST: "Ava" },
      "ENV_SPEC_FIRST",
    ),
  ).toBe("Zoe")
  expect(envValue({}, "ENV_SPEC_FIRST")).toBeUndefined()
})

test("an empty value falls through to the next name", () => {
  registerEnvAliases({ ENV_SPEC_EMPTY: ["LEGACY_EMPTY"] })
  expect(
    envVar(
      { FLOWREEL_ENV_SPEC_EMPTY: "", LEGACY_EMPTY: "off" },
      "ENV_SPEC_EMPTY",
    ),
  ).toEqual({ name: "LEGACY_EMPTY", value: "off" })
  expect(
    envVar({ FLOWREEL_ENV_SPEC_EMPTY: "", LEGACY_EMPTY: "" }, "ENV_SPEC_EMPTY"),
  ).toBe(undefined)
})

test("envName names the variable that was set, else the FLOWREEL_ name", () => {
  registerEnvAliases({ ENV_SPEC_NAME: ["LEGACY_NAME"] })
  expect(envName({ LEGACY_NAME: "none" }, "ENV_SPEC_NAME")).toBe("LEGACY_NAME")
  expect(envName({}, "ENV_SPEC_NAME")).toBe("FLOWREEL_ENV_SPEC_NAME")
  expect(envName({}, "UNKNOWN_KEY")).toBe("FLOWREEL_UNKNOWN_KEY")
})

test("a project can register more aliases; known ones are not duplicated", () => {
  registerEnvAliases({ TEST_ONLY_KEY: ["OLD_A", "OLD_B"] })
  registerEnvAliases({ TEST_ONLY_KEY: ["OLD_B", "OLD_C"] })
  expect(envNames("TEST_ONLY_KEY")).toEqual([
    "FLOWREEL_TEST_ONLY_KEY",
    "OLD_A",
    "OLD_B",
    "OLD_C",
  ])
  expect(envValue({ OLD_C: "c", OLD_B: "b" }, "TEST_ONLY_KEY")).toBe("b")
})
