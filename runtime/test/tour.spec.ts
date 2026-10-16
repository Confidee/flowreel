// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "@playwright/test"
import ts from "typescript"

import { InboundBudgetError } from "../src/core/errors.js"
import {
  FEATURE_ANNOTATION,
  InboundMailBudget,
  assertCataloguePolicy,
  checkDeclaredFeatures,
  declareFeature,
  defineTourManifest,
  detectModule,
  featureDecision,
  fileBudgetStore,
  parseCatalogue,
  parsePace,
  pauseFor,
  privacyKeepList,
  rowKept,
  scanAreaSpec,
  scanAreaSupport,
  swapPersona,
  tourModuleFrom,
} from "../src/tour/index.js"

// The tour module: the manifest (areas, projects, titles), module detection,
// policy and pace, the inbound budget, the catalogue, its static tripwire,
// feature() and the recorded page's helpers.

const TOUR = defineTourManifest({
  areas: [
    { letter: "A", slug: "listing", title: "Listing" },
    { letter: "B", slug: "detail", title: "Detail" },
    { letter: "D", slug: "admin", title: "Admin" },
  ],
  setupProject: "walk-setup",
  projectPrefix: "walk-",
  catalogue: {
    A1: { slug: "search", policy: "both" },
    A2: { slug: "bulk", policy: "both+undo" },
    B1: { slug: "assign", policy: "dev" },
    D1: { slug: "audit", policy: "view" },
  },
})

test.describe("manifest", () => {
  test("projects, areas, titles", () => {
    expect(TOUR.projectOfArea("B")).toBe("walk-b")
    expect(TOUR.areaOfProject("walk-d")?.slug).toBe("admin")
    expect(TOUR.areaOfProject("walk-c")).toBeNull()
    expect(TOUR.isTourProject("walk-setup")).toBe(true)
    expect(TOUR.isTourProject("gate")).toBe(false)
    expect(TOUR.parseFeatureTitle(" A1  search ")).toEqual({
      id: "A1",
      slug: "search",
    })
    expect(TOUR.parseFeatureTitle("C1 x")).toBeNull()
    expect(TOUR.parseStepTitle("D1.2 Opens the log")).toEqual({
      feature: "D1",
      n: 2,
      sentence: "Opens the log",
    })
    expect(TOUR.areaOfFeature("B1")?.letter).toBe("B")
    expect(TOUR.letters).toBe("ABD")
  })

  test("--area: sorted, unique, known letters only", () => {
    expect(TOUR.parseAreas("d, a ,A")).toEqual(["A", "D"])
    expect(() => TOUR.parseAreas(" , ")).toThrow(
      "--area needs one or more letters A, B, D (e.g. A,D).",
    )
    expect(() => TOUR.parseAreas("A,C")).toThrow(
      "Unknown area C; the tour has areas A, B, D.",
    )
  })

  test("a malformed manifest is refused", () => {
    const base = { setupProject: "s", catalogue: {} }
    expect(() => defineTourManifest({ ...base, areas: [] })).toThrow(
      /needs areas/,
    )
    expect(() =>
      defineTourManifest({
        ...base,
        areas: [{ letter: "ab", slug: "x", title: "x" }],
      }),
    ).toThrow(/one capital letter/)
    expect(() =>
      defineTourManifest({
        ...base,
        areas: [
          { letter: "A", slug: "x", title: "x" },
          { letter: "A", slug: "y", title: "y" },
        ],
      }),
    ).toThrow(/repeat/)
    expect(() =>
      defineTourManifest({
        ...base,
        areas: [{ letter: "A", slug: "x", title: "x" }],
        catalogue: { B1: { slug: "x", policy: "both" } },
      }),
    ).toThrow(/Catalogue id "B1"/)
  })

  test("module detection: FLOWREEL_MODULE, else any tour project", () => {
    const options = {
      modules: ["gate", "walk"] as const,
      tourModule: "walk" as const,
      fallback: "gate" as const,
      isTourProject: TOUR.isTourProject,
    }
    expect(detectModule([], {}, options)).toBe("gate")
    expect(detectModule(["--project=walk-a"], {}, options)).toBe("walk")
    expect(detectModule(["--project", "walk-setup"], {}, options)).toBe("walk")
    expect(
      detectModule(
        ["--project=walk-a"],
        { FLOWREEL_MODULE: " gate " },
        options,
      ),
    ).toBe("gate")
    expect(detectModule([], { FLOWREEL_MODULE: "nope" }, options)).toBe("gate")
  })
})

test.describe("policy and pace", () => {
  test("development runs everything; staging skips dev, views view", () => {
    for (const policy of ["both", "both+undo", "dev", "view"] as const) {
      expect(
        featureDecision({ id: "A1", policy, devOnlyReason: "why" }, "local"),
      ).toEqual({ skip: null, mode: "full" })
    }
    expect(
      featureDecision(
        { id: "B1", policy: "dev", devOnlyReason: " needs a seam " },
        "staging",
      ),
    ).toEqual({
      skip: "development only: needs a seam",
      mode: "full",
    })
    expect(featureDecision({ id: "D1", policy: "view" }, "staging").mode).toBe(
      "view",
    )
    expect(() => featureDecision({ id: "B1", policy: "dev" }, "local")).toThrow(
      /needs devOnlyReason/,
    )
    expect(() =>
      featureDecision({ id: "B1", policy: "x" as never }, "local"),
    ).toThrow(/unknown policy/)
  })

  test("pace: demo by default, qa, nothing else", () => {
    expect(parsePace(undefined)).toBe("demo")
    expect(parsePace(" QA ")).toBe("qa")
    expect(() => parsePace("fast", "MY_PACE")).toThrow(
      'MY_PACE must be "demo" or "qa" (got "fast").',
    )
  })
})

test.describe("inbound budget", () => {
  test("staging refuses BEFORE the (max+1)th send; local only counts; the file survives a new worker", () => {
    const dir = mkdtempSync(join(tmpdir(), "flowreel-budget-"))
    try {
      const file = join(dir, "inbound.json")
      const budget = new InboundMailBudget(fileBudgetStore(file), "staging", {
        max: 2,
      })
      expect(budget.consume("one")).toBe(1)
      expect(
        new InboundMailBudget(fileBudgetStore(file), "staging", {
          max: 2,
        }).consume("two"),
      ).toBe(2)
      let error: unknown
      try {
        budget.consume("three")
      } catch (e) {
        error = e
      }
      expect(error).toBeInstanceOf(InboundBudgetError)
      expect((error as Error).message).toBe(
        'Refusing inbound mail "three": this staging tour already sent 2 of at most 2; create the record through the app instead, or make the feature development-only.',
      )
      const saved = JSON.parse(readFileSync(file, "utf8")) as {
        sends: { what: string }[]
      }
      expect(saved.sends.map((s) => s.what)).toEqual(["one", "two"])
      const local = new InboundMailBudget(
        fileBudgetStore(join(dir, "l.json")),
        "local",
        { max: 0 },
      )
      expect(local.consume("x")).toBe(1)
      writeFileSync(file, "junk")
      expect(fileBudgetStore(file).read()).toEqual({ count: 0, sends: [] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

test.describe("catalogue", () => {
  test("parses Policy columns, `dev; staging view` and dev-only sections", () => {
    const md = [
      "## Area A",
      "| id | Feature | Policy |",
      "|---|---|---|",
      "| A1 search | x | both (own records only) |",
      "| A2 bulk | x | both+undo (restored) |",
      "| A3 shadow | x | dev; staging `view` |",
      "## Area D (dev only)",
      "Reason: x. Staging: `view` of `/admin/audit` only.",
      "| id | Feature | Notes |",
      "|---|---|---|",
      "| D1 audit | x | `/admin/audit` |",
      "| D2 purge | x | `/admin/purge` |",
    ].join("\n")
    expect(parseCatalogue(md, { letters: TOUR.letters })).toEqual({
      A1: { slug: "search", policy: "both" },
      A2: { slug: "bulk", policy: "both+undo" },
      A3: { slug: "shadow", policy: "view" },
      D1: { slug: "audit", policy: "view" },
      D2: { slug: "purge", policy: "dev" },
    })
    expect(() =>
      parseCatalogue("## A\n| id | Policy |\n| A1 x | maybe |", {
        file: "INVENTORY.md",
      }),
    ).toThrow('INVENTORY.md: feature A1 has no recognisable policy ("maybe").')
  })

  test("the declared policy must be the catalogue's", () => {
    expect(
      assertCataloguePolicy({ id: "A1", policy: "both" }, TOUR.catalogue).slug,
    ).toBe("search")
    expect(() =>
      assertCataloguePolicy({ id: "B1", policy: "both" }, TOUR.catalogue, {
        change: "INVENTORY.md",
      }),
    ).toThrow(
      'feature(): B1 declares policy "both" but the catalogue says "dev" (owner-approved; change INVENTORY.md first, never the flow alone).',
    )
    expect(() =>
      assertCataloguePolicy({ id: "Z1", policy: "both" }, TOUR.catalogue, {
        source: "flows/catalogue.ts",
      }),
    ).toThrow(
      "feature(): Z1 is not in the tour catalogue (flows/catalogue.ts).",
    )
  })

  test("the static tripwire: feature() first, no hooks, no in-body skip", () => {
    const spec = [
      "test.afterAll(async () => {})",
      'test("A1 search", async ({ app }, info) => {',
      '  feature(test, { id: "A1", policy: "both" })',
      '  info.skip(true, "no")',
      "})",
      'test.describe("group", () => {',
      '  test("A2 bulk", async () => {',
      '    const ctx = feature(test, { id: "A2", policy: "both" })',
      "  })",
      "})",
      'test("B1 assign", async () => {',
      "  await setup()",
      "})",
    ].join("\n")
    const { tests, problems } = scanAreaSpec(ts, "a-x.spec.ts", spec)
    expect(problems).toEqual([
      "a-x.spec.ts:1 test.afterAll(…) runs outside feature() (only feature() skips; no hooks in a tour area)",
      'a-x.spec.ts:4 .skip(…) inside test("A1 search") (only feature() skips)',
      'a-x.spec.ts:11 test("B1 assign") does not start with feature(test, { id, policy })',
    ])
    expect(checkDeclaredFeatures(TOUR, "a-x.spec.ts", "A", tests)).toEqual([
      'a-x.spec.ts:7 test("A2 bulk"): feature() declares policy "both", the catalogue says "both+undo"',
      'a-x.spec.ts:11 test("B1 assign"): B1 does not belong in area A',
    ])
    expect(
      scanAreaSupport(
        ts,
        "support/a.ts",
        "export const f = () => test.info().fixme()",
      ),
    ).toEqual([
      "support/a.ts:1 .fixme(…) in an area helper (only feature() skips)",
    ])
  })
})

test.describe("feature()", () => {
  class Skipped extends Error {}
  const fake = (title: string) => {
    const annotations: { type: string; description?: string }[] = []
    return {
      annotations,
      t: {
        info: () => ({ title, annotations }),
        skip: (condition: boolean, reason: string) => {
          if (condition) throw new Skipped(reason)
        },
      },
    }
  }
  const run = (target: "local" | "staging") => ({
    target,
    runId: () => "loc-1",
    manifest: TOUR,
  })

  test("declares the feature, records its annotation, returns its context", () => {
    const { t, annotations } = fake("D1 audit")
    expect(
      declareFeature(t, { id: "D1", policy: "view" }, run("staging")),
    ).toEqual({
      id: "D1",
      policy: "view",
      target: "staging",
      mode: "view",
      runId: "loc-1",
    })
    expect(annotations).toEqual([
      {
        type: FEATURE_ANNOTATION,
        description: JSON.stringify({
          id: "D1",
          policy: "view",
          devOnlyReason: null,
          mode: "view",
        }),
      },
    ])
  })

  test("a dev feature is skipped on staging, after its annotation, without asking for the run id", () => {
    const { t, annotations } = fake("B1 assign")
    let asked = false
    expect(() =>
      declareFeature(
        t,
        { id: "B1", policy: "dev", devOnlyReason: "seam" },
        { ...run("staging"), runId: () => ((asked = true), "x") },
      ),
    ).toThrow(new Skipped("development only: seam"))
    expect(annotations).toHaveLength(1)
    expect(asked).toBe(false)
  })

  test("title, slug and policy must be the catalogue's", () => {
    expect(() =>
      declareFeature(
        fake("A1 search").t,
        { id: "A2", policy: "both+undo" },
        { ...run("local"), titleReference: "plan §1" },
      ),
    ).toThrow(
      'feature(): the test title "A1 search" must be "A2 <slug>" (plan §1).',
    )
    expect(() =>
      declareFeature(
        fake("A1 find").t,
        { id: "A1", policy: "both" },
        run("local"),
      ),
    ).toThrow(
      'feature(): the test title "A1 find" must be "A1 search" (the catalogue\'s slug).',
    )
    expect(() =>
      declareFeature(
        fake("A1 search").t,
        { id: "A1", policy: "dev", devOnlyReason: "x" },
        run("local"),
      ),
    ).toThrow(/catalogue says "both"/)
  })

  test("tourModuleFrom: the reporter reads what feature() writes, overrides included", () => {
    const plain = tourModuleFrom(TOUR, { name: "walk" })
    expect(plain).toMatchObject({
      kind: "tour",
      name: "walk",
      featureAnnotation: FEATURE_ANNOTATION,
      devOnlyPrefix: "development only: ",
    })
    expect(plain).not.toHaveProperty("demos")
    expect(plain.isProject("walk-setup")).toBe(true)
    expect(plain.isProject("walk-b")).toBe(true)
    expect(plain.isProject("walk-c")).toBe(false)
    expect(plain.areaOfProject("walk-d")).toBe("D")
    expect(plain.areaOfProject("walk-setup")).toBeNull()
    expect(plain.parseFeatureTitle("A1 search")).toEqual({
      id: "A1",
      slug: "search",
    })
    expect(plain.parseStepTitle("A1.2 Finds it")).toEqual({
      feature: "A1",
      n: 2,
      sentence: "Finds it",
    })

    // A project that customises feature()'s strings passes the same
    // FeatureRun overrides: the skip reason and the annotation match.
    const overrides = { annotationType: "walk-feature", devOnlyPrefix: "dev: " }
    const custom = tourModuleFrom(TOUR, { name: "walk", feature: overrides })
    const { t, annotations } = fake("B1 assign")
    let reason = ""
    try {
      declareFeature(
        t,
        { id: "B1", policy: "dev", devOnlyReason: "seam" },
        { ...run("staging"), ...overrides },
      )
    } catch (error) {
      reason = (error as Error).message
    }
    expect(reason.startsWith(custom.devOnlyPrefix)).toBe(true)
    expect(annotations.map((a) => a.type)).toEqual([custom.featureAnnotation])
    const demos = {
      areas: [{ key: "A", title: "Listing", shows: "the list" }],
      fullTour: { file: "full.mp4", shows: "everything" },
    }
    expect(tourModuleFrom(TOUR, { name: "walk", demos }).demos).toBe(demos)
  })
})

test.describe("the recorded page", () => {
  test("swapPersona replaces the cookies, keeps layout cookies, reloads app pages only", async () => {
    for (const [url, reloads] of [
      ["https://qa.example.org/x", 1],
      ["about:blank", 0],
    ] as const) {
      const calls: unknown[] = []
      await swapPersona(
        {
          context: () => ({
            clearCookies: () => (calls.push("clear"), Promise.resolve()),
            addCookies: (c) => (calls.push(c), Promise.resolve()),
          }),
          url: () => url,
          reload: () => (calls.push("reload"), Promise.resolve()),
        },
        { cookies: [] },
        [{ name: "layout", value: "compact", url: "https://qa.example.org" }],
      )
      expect(calls.slice(0, 2)).toEqual([
        "clear",
        [{ name: "layout", value: "compact", url: "https://qa.example.org" }],
      ])
      expect(calls.filter((c) => c === "reload")).toHaveLength(reloads)
    }
  })

  test("the privacy keep list and rows", () => {
    const keep = privacyKeepList([
      "RUN-1",
      "Bot@Example.org",
      null,
      undefined,
      "",
      "bot@example.org",
    ])
    expect(keep).toEqual(["run-1", "bot@example.org"])
    expect(rowKept("Created by BOT@example.org", keep)).toBe(true)
    expect(rowKept("A real person", keep)).toBe(false)
    expect(rowKept("anything", [""])).toBe(false)
  })

  test("pauseFor holds only when asked", async () => {
    const started = Date.now()
    await pauseFor(0)
    expect(Date.now() - started).toBeLessThan(50)
    await pauseFor(20)
    expect(Date.now() - started).toBeGreaterThanOrEqual(15)
  })
})
