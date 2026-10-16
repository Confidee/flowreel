// SPDX-License-Identifier: Apache-2.0

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "@playwright/test"

import {
  type DemoCatalogue,
  type DemoSummary,
  areaDemoName,
  areaVerdict,
  demoPublisher,
  demosReadme,
  keepPassing,
  parseRunIdArg,
  planDemos,
  publishDemos,
  stagingSkip,
} from "../src/demos/index.js"

// Demo publishing: a demo-pace run's videos land in latest/ under the
// catalogue's fixed names.

const ROUND_TRIP = "00-orders-round-trip.mp4"
const FULL_TOUR = "04-orders-full-tour.mp4"

const catalogue: DemoCatalogue = {
  dir: "/nonexistent/demos/latest",
  runIdPattern: /^(?:loc|stg)-\d{8}-\d{4}-[0-9a-f]{4}$/,
  runDir: (runId) => `/nonexistent/results/${runId}`,
  roundTrip: {
    name: "orders",
    demo: { file: ROUND_TRIP, shows: "The order round trip." },
  },
  tour: {
    name: "orders-tour",
    demos: {
      areas: [
        { key: "A", title: "Listing & creation", shows: "The listing." },
        { key: "B", title: "Workspace", shows: "The workspace." },
        { key: "C", title: "Admin: people & configuration", shows: "Admin." },
      ],
      fullTour: { file: FULL_TOUR, shows: "Every area in one video." },
    },
  },
  readme: {
    heading: "Orders demo videos (latest)",
    notice: "**Internal only: may show staging data.** Keep it in the team.",
    updatedBy: "the example harness",
    runsFolder: "results/<run id>/",
    refreshCommand: "npm run demos -- <RUN_ID>",
  },
}

const KEYS = ["A", "B", "C"]

const tourSummary = (over: Partial<DemoSummary> = {}): DemoSummary => ({
  runId: "loc-20261014-1200-abcd",
  module: "orders-tour",
  target: "local",
  verdict: "PASS",
  startedAt: "2026-10-14T12:00:00.000Z",
  pace: { pace: "demo", slowFactor: 1.5 },
  narration: { produced: true, voice: "Ava (Premium)" },
  tourVideo: {
    produced: true,
    tour: { file: "orders-tour-x.mp4", durationSec: 100 },
    areas: KEYS.map((key) => ({
      area: key,
      file: `tour-${key.toLowerCase()}-x.mp4`,
      durationSec: 10,
    })),
  },
  features: [
    { area: "A", status: "passed" },
    { area: "B", status: "failed" },
    { area: "C", status: "dev-only" },
  ],
  ...over,
})

const entry = (file: string, verdict = "PASS") => ({
  file,
  shows: "",
  runId: "r",
  date: "",
  target: "local",
  voice: "v",
  pace: "demo",
  verdict,
  durationSec: 1,
})

test.describe("names and plan", () => {
  test("numbered names from the area order and titles", () => {
    expect(areaDemoName(catalogue, "A")).toBe(
      "01-area-A-listing-and-creation.mp4",
    )
    expect(areaDemoName(catalogue, "C")).toBe(
      "03-area-C-admin-people-and-configuration.mp4",
    )
    expect(() => areaDemoName(catalogue, "Z")).toThrow(/Unknown demo area/)
  })

  test("a qa-pace run never touches latest/", () => {
    expect(
      planDemos(
        catalogue,
        tourSummary({ pace: { pace: "qa", slowFactor: 1 } }),
      ),
    ).toEqual({ skip: "not a demo-pace run (qa pace never touches latest/)" })
    expect(planDemos(catalogue, tourSummary({ pace: "qa" }))).toMatchObject({
      skip: expect.stringContaining("not a demo-pace run"),
    })
  })

  test("a full demo tour: every area plus the full tour, verdict per area", () => {
    const plan = planDemos(catalogue, tourSummary())
    if ("skip" in plan) throw new Error(plan.skip)
    expect(plan.fullTour).toBe(true)
    expect(plan.copies.map((c) => c.entry.file)).toEqual([
      ...KEYS.map((key) => areaDemoName(catalogue, key)),
      FULL_TOUR,
    ])
    expect(plan.copies[0].entry).toMatchObject({
      verdict: "PASS",
      shows: "The listing.",
      voice: "Ava (Premium)",
      pace: "demo (slow factor 1.5)",
      runId: "loc-20261014-1200-abcd",
      target: "local",
      durationSec: 10,
    })
    expect(plan.copies[1].entry.verdict).toBe("FAIL")
    expect(plan.copies[2].entry.verdict).toBe("N/A")
    expect(areaVerdict(tourSummary().features, "B")).toBe("FAIL")
    expect(areaVerdict(tourSummary().features, "C")).toBe("N/A")
    expect(areaVerdict(undefined, "A")).toBe("N/A")
  })

  test("a silent run says why in the voice column", () => {
    const plan = planDemos(
      catalogue,
      tourSummary({ narration: { produced: false, reason: "voice off" } }),
    )
    if ("skip" in plan) throw new Error(plan.skip)
    expect(plan.copies[0].entry.voice).toBe("silent (voice off)")
  })

  test("a partial tour updates only its areas, never the full tour", () => {
    const plan = planDemos(
      catalogue,
      tourSummary({
        tourVideo: {
          produced: true,
          tour: { file: "t.mp4" },
          areas: [
            { area: "B", file: "tour-b-x.mp4", durationSec: 5 },
            { area: "Z", file: "tour-z-x.mp4", durationSec: 5 },
          ],
        },
      }),
    )
    if ("skip" in plan) throw new Error(plan.skip)
    expect(plan.fullTour).toBe(false)
    expect(plan.copies.map((c) => c.entry.file)).toEqual([
      areaDemoName(catalogue, "B"),
    ])
  })

  test("a tour run without a tour video or area video publishes nothing", () => {
    expect(
      planDemos(catalogue, tourSummary({ tourVideo: { produced: false } })),
    ).toEqual({ skip: "the run produced no tour video" })
    expect(
      planDemos(
        catalogue,
        tourSummary({ tourVideo: { produced: true, areas: [] } }),
      ),
    ).toEqual({ skip: "the run produced no area video" })
  })

  test("the round trip is its fixed file; paths outside the run are refused", () => {
    const rt: DemoSummary = {
      runId: "loc-20261014-1300-abcd",
      module: "orders",
      verdict: "PASS",
      pace: { pace: "demo", slowFactor: 1.5 },
      video: { produced: true, file: "orders-x.mp4", durationSec: 60 },
    }
    const plan = planDemos(catalogue, rt)
    expect("copies" in plan && plan.copies[0].entry.file).toBe(ROUND_TRIP)
    for (const file of ["../evil.mp4", "/abs/evil.mp4", ""]) {
      expect(
        planDemos(catalogue, { ...rt, video: { produced: true, file } }),
      ).toEqual({ skip: "the run produced no video" })
    }
    const noRoundTrip = { ...catalogue, roundTrip: undefined }
    expect(planDemos(noRoundTrip, rt)).toEqual({
      skip: "the demo catalogue has no round-trip demo",
    })
    // Another module's video is never the round trip's demo.
    expect(planDemos(catalogue, { ...rt, module: "billing" })).toEqual({
      skip: "no demo for module billing",
    })
    // A summary that records no module (written before the reporter
    // recorded one) is the round trip's, as before the extraction.
    const legacy = planDemos(catalogue, { ...rt, module: undefined })
    expect("copies" in legacy && legacy.copies[0].entry.file).toBe(ROUND_TRIP)
  })

  test("a tour run against a catalogue without a tour is not the round trip", () => {
    const noTour = { ...catalogue, tour: undefined }
    const summary = tourSummary({
      video: { produced: true, file: "orders-tour-x.mp4", durationSec: 100 },
    })
    for (const options of [{}, { automatic: true }]) {
      expect(planDemos(noTour, summary, options)).toEqual({
        skip: "no demo for module orders-tour",
      })
    }
  })

  test("the README carries the catalogue's copy and lists every file", () => {
    const plan = planDemos(catalogue, tourSummary())
    if ("skip" in plan) throw new Error(plan.skip)
    const readme = demosReadme(
      catalogue,
      plan.copies.map((c) => c.entry),
      new Date("2026-10-14T13:00:00Z"),
    )
    expect(readme.split("\n").slice(0, 5)).toEqual([
      "# Orders demo videos (latest)",
      "",
      "**Internal only: may show staging data.** Keep it in the team.",
      "",
      "Updated 2026-10-14T13:00:00.000Z by the example harness. Each file is copied from its run folder under `results/<run id>/`, which stays as the evidence. Refresh from a run: `npm run demos -- <RUN_ID>`.",
    ])
    for (const c of plan.copies) expect(readme).toContain(c.entry.file)
  })

  test("the command takes a run id, never a path", () => {
    expect(parseRunIdArg(catalogue, " loc-20261014-1200-abcd ")).toBe(
      "loc-20261014-1200-abcd",
    )
    expect(parseRunIdArg(catalogue, "../loc-20261014-1200-abcd")).toBeNull()
    expect(parseRunIdArg(catalogue, "pipe-20261014-1200-abcd")).toBeNull()
    expect(parseRunIdArg(catalogue, undefined)).toBeNull()
  })

  test("never a path, even with a loose pattern", () => {
    const loose = { ...catalogue, runIdPattern: /[a-z]/ }
    for (const raw of [
      "../../x",
      "a/b",
      "a\\b",
      "..",
      ".",
      "x..y",
      "/etc",
      "a\0b",
      "",
    ]) {
      expect(parseRunIdArg(loose, raw), JSON.stringify(raw)).toBeNull()
    }
    expect(parseRunIdArg(loose, "run-1")).toBe("run-1")
  })

  test("a g or y flag on the pattern keeps no state between calls", () => {
    for (const flags of ["g", "y", "gy"]) {
      const stateful = {
        ...catalogue,
        runIdPattern: new RegExp(catalogue.runIdPattern.source, flags),
      }
      for (let i = 0; i < 3; i += 1) {
        expect(parseRunIdArg(stateful, "loc-20261014-1200-abcd"), flags).toBe(
          "loc-20261014-1200-abcd",
        )
      }
    }
  })
})

test.describe("publishDemos", () => {
  test("copies, replaces the tour set on a full run, keeps the round trip", () => {
    const root = mkdtempSync(join(tmpdir(), "flowreel-demos-"))
    try {
      const run = join(root, "run")
      const latest = join(root, "latest")
      mkdirSync(run)
      mkdirSync(latest)
      writeFileSync(join(latest, ROUND_TRIP), "old round trip")
      writeFileSync(
        join(latest, "demos.json"),
        JSON.stringify({ entries: [entry(ROUND_TRIP), entry(FULL_TOUR)] }),
      )
      const summary = tourSummary()
      for (const a of summary.tourVideo!.areas!)
        writeFileSync(join(run, a.file!), a.area!)
      writeFileSync(join(run, "orders-tour-x.mp4"), "tour")
      writeFileSync(join(run, "summary.json"), JSON.stringify(summary))
      const outcome = publishDemos(
        catalogue,
        run,
        latest,
        new Date("2026-10-14T13:00:00Z"),
      )
      expect(outcome).toEqual({
        published: true,
        dir: latest,
        files: [...KEYS.map((key) => areaDemoName(catalogue, key)), FULL_TOUR],
      })
      expect(
        readFileSync(join(latest, areaDemoName(catalogue, "C")), "utf8"),
      ).toBe("C")
      expect(readFileSync(join(latest, FULL_TOUR), "utf8")).toBe("tour")
      // The round trip is not part of a tour run's set.
      expect(readFileSync(join(latest, ROUND_TRIP), "utf8")).toBe(
        "old round trip",
      )
      const manifest = JSON.parse(
        readFileSync(join(latest, "demos.json"), "utf8"),
      ) as { updatedAt: string; entries: { file: string }[] }
      expect(manifest.updatedAt).toBe("2026-10-14T13:00:00.000Z")
      expect(manifest.entries.map((e) => e.file).sort()).toEqual(
        [
          ROUND_TRIP,
          ...KEYS.map((k) => areaDemoName(catalogue, k)),
          FULL_TOUR,
        ].sort(),
      )
      const readme = readFileSync(join(latest, "README.md"), "utf8")
      expect(readme).toContain(ROUND_TRIP)
      expect(readme).toContain(FULL_TOUR)
      expect(existsSync(join(latest, `${FULL_TOUR}.part`))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("automatic: a non-development run never reaches latest/; on purpose it does", () => {
    const staging = tourSummary({
      runId: "stg-20261014-1200-abcd",
      target: "staging",
    })
    expect(planDemos(catalogue, staging, { automatic: true })).toEqual({
      skip: stagingSkip(catalogue),
    })
    expect(stagingSkip(catalogue)).toBe(
      "a staging run (automatic publishing takes development runs only; npm run demos -- <RUN_ID> publishes it on purpose)",
    )
    expect(
      planDemos(catalogue, tourSummary(), { automatic: true }),
    ).toMatchObject({ fullTour: true })
    expect(planDemos(catalogue, staging)).toMatchObject({ fullTour: true })
    expect(
      planDemos({ ...catalogue, developmentTarget: "dev" }, tourSummary(), {
        automatic: true,
      }),
    ).toEqual({ skip: stagingSkip(catalogue) })
    const root = mkdtempSync(join(tmpdir(), "flowreel-demos-"))
    try {
      writeFileSync(join(root, "summary.json"), JSON.stringify(staging))
      expect(
        publishDemos(catalogue, root, join(root, "latest"), new Date(), {
          automatic: true,
        }),
      ).toEqual({ published: false, reason: stagingSkip(catalogue) })
      expect(existsSync(join(root, "latest"))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("automatic: a FAIL video never replaces a PASS one, and the tour set is then kept", () => {
    const plan = planDemos(catalogue, tourSummary({ verdict: "FAIL" }))
    if ("skip" in plan) throw new Error(plan.skip)
    const existing = [
      areaDemoName(catalogue, "B"),
      FULL_TOUR,
      areaDemoName(catalogue, "A"),
    ].map((file) => entry(file))
    const kept = keepPassing(plan, existing)
    // Area B and the full tour failed this run; area A passed.
    expect(kept.kept).toEqual([areaDemoName(catalogue, "B"), FULL_TOUR])
    expect(kept.fullTour).toBe(false)
    expect(kept.copies.map((c) => c.entry.file)).toContain(
      areaDemoName(catalogue, "A"),
    )
    expect(kept.copies.map((c) => c.entry.file)).not.toContain(FULL_TOUR)
    // Nothing passing there yet: everything is published.
    expect(keepPassing(plan, []).kept).toEqual([])
  })

  test("automatic: a failed round trip over a passing one publishes nothing", () => {
    const root = mkdtempSync(join(tmpdir(), "flowreel-demos-"))
    try {
      const latest = join(root, "latest")
      mkdirSync(latest)
      writeFileSync(
        join(latest, "demos.json"),
        JSON.stringify({ entries: [entry(ROUND_TRIP)] }),
      )
      writeFileSync(join(root, "rt.mp4"), "new")
      writeFileSync(
        join(root, "summary.json"),
        JSON.stringify({
          module: "orders",
          target: "local",
          verdict: "FAIL",
          pace: { pace: "demo", slowFactor: 1.5 },
          video: { produced: true, file: "rt.mp4" },
        }),
      )
      expect(
        publishDemos(catalogue, root, latest, new Date(), { automatic: true }),
      ).toEqual({
        published: false,
        reason: `this run failed; the passing videos in latest/ stay (${ROUND_TRIP})`,
      })
      expect(existsSync(join(latest, ROUND_TRIP))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("a missing video or summary publishes nothing", () => {
    const root = mkdtempSync(join(tmpdir(), "flowreel-demos-"))
    try {
      expect(publishDemos(catalogue, root, join(root, "latest"))).toEqual({
        published: false,
        reason: "the run has no readable summary.json",
      })
      writeFileSync(join(root, "summary.json"), JSON.stringify(tourSummary()))
      expect(publishDemos(catalogue, root, join(root, "latest"))).toEqual({
        published: false,
        reason: "tour-a-x.mp4 is missing",
      })
      expect(existsSync(join(root, "latest"))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

test.describe("demoPublisher", () => {
  test("binds the catalogue under the names a demos module exports", () => {
    const demos = demoPublisher(catalogue)
    expect(demos.dir).toBe(catalogue.dir)
    expect(demos.stagingSkip).toBe(stagingSkip(catalogue))
    expect(demos.areaDemoName("B")).toBe(areaDemoName(catalogue, "B"))
    expect(demos.parseRunIdArg("loc-20261014-1200-abcd")).toBe(
      "loc-20261014-1200-abcd",
    )
    expect(demos.runDirOf("loc-1")).toBe("/nonexistent/results/loc-1")
    expect(demos.planDemos(tourSummary())).toEqual(
      planDemos(catalogue, tourSummary()),
    )
    expect(demos.demosReadme([], new Date(0))).toBe(
      demosReadme(catalogue, [], new Date(0)),
    )
    const root = mkdtempSync(join(tmpdir(), "flowreel-demos-"))
    try {
      // The default folder is the catalogue's; a run without a summary
      // never creates it.
      expect(demos.publishDemos(root)).toEqual({
        published: false,
        reason: "the run has no readable summary.json",
      })
      expect(existsSync(catalogue.dir)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
