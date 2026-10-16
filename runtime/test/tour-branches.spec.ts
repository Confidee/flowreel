// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "@playwright/test"
import ts from "typescript"

import { ConfigError, InboundBudgetError } from "../src/core/errors.js"
import {
  InboundMailBudget,
  assertCataloguePolicy,
  checkDeclaredFeatures,
  declareFeature,
  defineTourManifest,
  featureDecision,
  fileBudgetStore,
  parseCatalogue,
  scanAreaSpec,
} from "../src/tour/index.js"

// The tour module's less common paths: the static scan over odd shapes, the
// budget's stored and custom wording, manifest messages, and the refusals.

const manifestOf = (letters: string[]) =>
  defineTourManifest({
    areas: letters.map((letter) => ({
      letter,
      slug: letter.toLowerCase(),
      title: letter,
    })),
    setupProject: "setup",
    catalogue: {},
  })

test.describe("scanAreaSpec over unusual shapes", () => {
  const scan = (text: string) => scanAreaSpec(ts, "s.spec.ts", text)

  test("non-statements and non-calls at the top level are ignored", () => {
    const { tests, problems } = scan(
      ["const x = 1", "x", "1 + 1", 'import("y")', ""].join("\n"),
    )
    expect(tests).toEqual([])
    expect(problems).toEqual([])
  })

  test("a non-literal title, an empty body and a non-function body each need feature()", () => {
    const { tests, problems } = scan(
      [
        "test(`a${b}`, async () => {})",
        'test("A2 y", handler)',
        'test("A3 z", async () => expr)',
        "test()",
        "",
      ].join("\n"),
    )
    expect(tests.map((t) => [t.title, t.id, t.policy])).toEqual([
      ["<non-literal title>", null, null],
      ["A2 y", null, null],
      ["A3 z", null, null],
      ["<non-literal title>", null, null],
    ])
    expect(problems).toHaveLength(4)
    expect(problems[1]).toContain('test("A2 y") does not start with feature')
  })

  test("feature() with a missing id, a missing policy or a non-literal value", () => {
    const { tests } = scan(
      [
        'test("A1 a", async () => { feature(test, { policy: "both" }) })',
        'test("A2 b", async () => { feature(test, { id: "A2" }) })',
        'test("A3 c", async () => { feature(test, { id: ID, policy: "both", ...rest, [k]: 1 }) })',
        'test("A4 d", async () => { const ctx = feature(test, { id: "A4", policy: "dev" }) })',
        'test("A5 e", async () => { const a = 1, b = feature(test, { id: "A5", policy: "dev" }) })',
        "",
      ].join("\n"),
    )
    expect(tests.map((t) => [t.id, t.policy])).toEqual([
      [null, "both"],
      ["A2", null],
      [null, "both"],
      ["A4", "dev"],
      [null, null],
    ])
  })

  test("a describe with a non-function body is skipped; a function expression is walked", () => {
    const { tests, problems } = scan(
      [
        'test.describe("g", body)',
        'test.describe("h", function () {',
        '  test("A1 a", async function ({ page }, info) {',
        '    feature(test, { id: "A1", policy: "both" })',
        '    info.skip(true, "no")',
        "  })",
        "})",
        'test.describe("i", () => expr)',
        "test.step()",
        "",
      ].join("\n"),
    )
    expect(tests.map((t) => t.title)).toEqual(["A1 a"])
    expect(problems).toEqual([
      's.spec.ts:5 .skip(…) inside test("A1 a") (only feature() skips)',
    ])
  })
})

test.describe("checkDeclaredFeatures", () => {
  const manifest = defineTourManifest({
    areas: [
      { letter: "A", slug: "a", title: "A" },
      { letter: "B", slug: "b", title: "B" },
    ],
    setupProject: "setup",
    catalogue: {
      A1: { slug: "one", policy: "both" },
      A2: { slug: "two", policy: "view" },
    },
  })
  const declared = (over: object) => ({
    title: "A1 one",
    id: "A1",
    policy: "both",
    line: 3,
    ...over,
  })

  test("every kind of mismatch is reported once, at its line", () => {
    const one = (over: object) =>
      checkDeclaredFeatures(manifest, "f.ts", "A", [declared(over)])
    expect([
      one({ title: "nonsense" }),
      one({ title: "A9 missing", id: "A9" }),
      one({ title: "A1 wrong-slug" }),
      one({ id: "A2" }),
      one({ policy: null }),
      one({ title: "A2 two", id: "A2", policy: "both" }),
    ]).toEqual([
      ['f.ts:3 test("nonsense"): title is not "<id> <slug>"'],
      ['f.ts:3 test("A9 missing"): A9 is not in the catalogue'],
      ['f.ts:3 test("A1 wrong-slug"): slug must be "one"'],
      ['f.ts:3 test("A1 one"): feature() declares id A2'],
      ['f.ts:3 test("A1 one"): feature() policy is not a string literal'],
      [
        'f.ts:3 test("A2 two"): feature() declares policy "both", the catalogue says "view"',
      ],
    ])
  })

  test("an id tested twice, across files, names where it was first tested", () => {
    const seen = new Map<string, string>()
    expect(
      checkDeclaredFeatures(manifest, "f.ts", "A", [declared({})], seen),
    ).toEqual([])
    expect(
      checkDeclaredFeatures(
        manifest,
        "g.ts",
        "A",
        [declared({ line: 9 })],
        seen,
      ),
    ).toEqual([
      'g.ts:9 test("A1 one"): A1 is also tested at f.ts:3 test("A1 one")',
    ])
  })
})

test.describe("the inbound budget", () => {
  test("a custom limit and hint; used reads the store", () => {
    let state = { count: 0, sends: [] as { what: string; at: string }[] }
    const budget = new InboundMailBudget(
      { read: () => state, write: (v) => (state = v) },
      "staging",
      { max: 1, refusalHint: "; use the app." },
    )
    expect(budget.used).toBe(0)
    expect(budget.consume("first", new Date(0))).toBe(1)
    expect(budget.used).toBe(1)
    expect(state.sends).toEqual([
      { what: "first", at: "1970-01-01T00:00:00.000Z" },
    ])
    expect(() => budget.consume("second")).toThrow(InboundBudgetError)
    expect(() => budget.consume("second")).toThrow(
      'Refusing inbound mail "second": this staging tour already sent 1 of at most 1; use the app.',
    )
  })

  test("a stored file with the wrong field types counts as empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "flowreel-budget-"))
    try {
      const path = join(dir, "nested", "budget.json")
      const store = fileBudgetStore(path)
      expect(store.read()).toEqual({ count: 0, sends: [] })
      store.write({ count: 2, sends: [{ what: "x", at: "t" }] })
      expect(store.read()).toEqual({
        count: 2,
        sends: [{ what: "x", at: "t" }],
      })
      writeFileSync(path, JSON.stringify({ count: "2", sends: "none" }))
      expect(store.read()).toEqual({ count: 0, sends: [] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

test.describe("manifest wording", () => {
  test("--area help names the range and an example for each shape of letters", () => {
    const help = (letters: string[]) => {
      try {
        manifestOf(letters).parseAreas(" , ")
      } catch (error) {
        return (error as ConfigError).message
      }
      return ""
    }
    expect(help(["A", "B", "C", "D"])).toBe(
      "--area needs one or more letters A-D (e.g. A,C).",
    )
    expect(help(["A", "B"])).toBe(
      "--area needs one or more letters A-B (e.g. A,B).",
    )
    expect(help(["A", "C", "E"])).toBe(
      "--area needs one or more letters A, C, E (e.g. A,E).",
    )
    expect(help(["Q"])).toBe("--area needs one or more letters Q (e.g. Q,Q).")
  })

  test("titles and feature ids that do not parse", () => {
    const m = manifestOf(["A", "B"])
    expect(m.parseStepTitle("A1 no dot")).toBeNull()
    expect(m.areaOfFeature("1")).toBeNull()
    expect(m.areaOfFeature("a1")).toBeNull()
    expect(m.areaOfFeature("Z1")).toBeNull()
    expect(m.areaOfFeature("B2")?.letter).toBe("B")
  })
})

test.describe("catalogue and feature() refusals", () => {
  test("a short row has no policy; a missing id without a source", () => {
    expect(() =>
      parseCatalogue("## A\n| id | Policy |\n| A1 x |", { file: "C.md" }),
    ).toThrow('C.md: feature A1 has no recognisable policy ("").')
    // A row before any header has no policy column at all.
    expect(() => parseCatalogue("## A\n| A1 x | both |")).toThrow(
      'CATALOGUE.md: feature A1 has no recognisable policy ("").',
    )
    expect(() =>
      assertCataloguePolicy({ id: "Z1", policy: "both" }, {}),
    ).toThrow("feature(): Z1 is not in the tour catalogue.")
  })

  test("a title that does not parse, with and without a reference", () => {
    const manifest = manifestOf(["A"])
    const t = {
      info: () => ({ title: "no id here", annotations: [] }),
      skip: () => undefined,
    }
    const run = { target: "local" as const, runId: () => "r", manifest }
    expect(() => declareFeature(t, { id: "A1", policy: "both" }, run)).toThrow(
      'feature(): the test title "no id here" must be "A1 <slug>".',
    )
    expect(() =>
      declareFeature(
        t,
        { id: "A1", policy: "both" },
        {
          ...run,
          titleReference: "see the plan",
        },
      ),
    ).toThrow('must be "A1 <slug>" (see the plan).')
  })

  test("staging runs a both feature in full mode", () => {
    expect(featureDecision({ id: "A1", policy: "both" }, "staging")).toEqual({
      skip: null,
      mode: "full",
    })
    expect(
      featureDecision({ id: "A1", policy: "both+undo" }, "staging").mode,
    ).toBe("full")
  })
})
