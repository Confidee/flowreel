// SPDX-License-Identifier: Apache-2.0

import {
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
  type DemoEntry,
  type DemoSummary,
  areaDemoName,
  areaVerdict,
  demosReadme,
  planDemos,
  publishDemos,
} from "../src/demos/index.js"

// Demo publishing: the summary shapes older or partial runs leave behind,
// and the files a publish keeps.

const FULL_TOUR = "04-full-tour.mp4"

const catalogue: DemoCatalogue = {
  dir: "/nonexistent/demos/latest",
  runIdPattern: /^run-\d+$/,
  runDir: (runId) => `/nonexistent/results/${runId}`,
  roundTrip: {
    name: "orders",
    demo: { file: "00-orders.mp4", shows: "The round trip." },
  },
  tour: {
    name: "orders-tour",
    demos: {
      areas: [
        { key: "A", title: "First", shows: "The first area." },
        { key: "B", title: "Second", shows: "The second area." },
      ],
      fullTour: { file: FULL_TOUR, shows: "Every area." },
    },
  },
  readme: {
    heading: "Demos",
    notice: "Internal.",
    updatedBy: "the example harness",
    runsFolder: "results/<run id>/",
    refreshCommand: "npm run demos",
  },
}

const withoutTour: DemoCatalogue = { ...catalogue, tour: undefined }

const demo = (over: Partial<DemoSummary> = {}): DemoSummary => ({
  pace: "demo",
  ...over,
})

const copies = (plan: ReturnType<typeof planDemos>) => {
  if ("skip" in plan) throw new Error(plan.skip)
  return plan.copies
}

test.describe("planning from partial summaries", () => {
  test("an unknown area name is an error, with or without a tour", () => {
    expect(() => areaDemoName(withoutTour, "A")).toThrow(
      'Unknown demo area "A".',
    )
    expect(() => areaDemoName(catalogue, "Z")).toThrow('Unknown demo area "Z".')
  })

  test("an area with no features is N/A", () => {
    expect(areaVerdict(undefined, "A")).toBe("N/A")
    expect(areaVerdict([{ area: "B", status: "passed" }], "A")).toBe("N/A")
    // A malformed (null) feature row is ignored.
    const rows = [null, { area: "A", status: "view-only" }] as unknown as {
      area: string
    }[]
    expect(areaVerdict(rows, "A")).toBe("PASS")
  })

  test("a round trip summary with the bare minimum: unknown run, silent, no length", () => {
    const [copy] = copies(
      planDemos(
        catalogue,
        demo({ video: { produced: true, file: "orders.mp4" } }),
      ),
    )
    expect(copy.entry).toEqual({
      file: "00-orders.mp4",
      shows: "The round trip.",
      runId: "unknown-run",
      date: "",
      target: "?",
      voice: "silent (no narration)",
      pace: "demo",
      verdict: "?",
      durationSec: null,
    })
  })

  test("narration without a voice name is 'narrated'; a slow factor joins the pace", () => {
    const [copy] = copies(
      planDemos(
        catalogue,
        demo({
          pace: { pace: "demo", slowFactor: 2 },
          narration: { produced: true },
          video: { produced: true, file: "orders.mp4", durationSec: 5 },
        }),
      ),
    )
    expect(copy.entry).toMatchObject({
      voice: "narrated",
      pace: "demo (slow factor 2)",
      durationSec: 5,
    })
    const plain = copies(
      planDemos(
        catalogue,
        demo({
          pace: { pace: "demo" },
          video: { produced: true, file: "orders.mp4" },
        }),
      ),
    )
    expect(plain[0].entry.pace).toBe("demo")
  })

  test("a summary with no pace is not a demo run", () => {
    expect(planDemos(catalogue, {})).toEqual({
      skip: "not a demo-pace run (qa pace never touches latest/)",
    })
  })

  test("a tour run: unsafe, unknown and missing areas are left out", () => {
    const tour = {
      name: "orders-tour",
    }
    const plan = planDemos(
      catalogue,
      demo({
        module: tour.name,
        tourVideo: {
          produced: true,
          tour: { file: "../escape.mp4" },
          areas: [
            { area: "A", file: "a.mp4" },
            { area: "B", file: "/abs/b.mp4" },
            { area: "Z", file: "z.mp4" },
            null as unknown as { area: string },
          ],
        },
      }),
    )
    // Only A is safe: not the whole tour, so no full-tour video either.
    expect(plan).toMatchObject({ fullTour: false })
    const c = copies(plan)
    expect(c.map((x) => x.entry.file)).toEqual(["01-area-A-first.mp4"])
    expect(c[0].entry).toMatchObject({ verdict: "N/A", durationSec: null })
  })

  test("a full tour with an unsafe tour file publishes the areas only; areas may be absent", () => {
    const areas = ["A", "B"].map((area) => ({
      area,
      file: `${area}.mp4`,
      durationSec: 3,
    }))
    const unsafe = planDemos(
      catalogue,
      demo({
        module: "orders-tour",
        tourVideo: { produced: true, tour: { file: "a/../../x.mp4" }, areas },
      }),
    )
    expect(copies(unsafe)).toHaveLength(2)
    expect(unsafe).toMatchObject({ fullTour: true })
    const noFile = planDemos(
      catalogue,
      demo({
        module: "orders-tour",
        tourVideo: { produced: true, areas },
      }),
    )
    expect(copies(noFile)).toHaveLength(2)
    expect(
      planDemos(
        catalogue,
        demo({ module: "orders-tour", tourVideo: { produced: true } }),
      ),
    ).toEqual({ skip: "the run produced no area video" })
    const full = copies(
      planDemos(
        catalogue,
        demo({
          module: "orders-tour",
          tourVideo: { produced: true, tour: { file: "t.mp4" }, areas },
        }),
      ),
    )
    expect(full.at(-1)?.entry).toMatchObject({
      file: FULL_TOUR,
      verdict: "?",
      durationSec: null,
    })
  })
})

test.describe("the README and the published set", () => {
  const entry = (over: Partial<DemoEntry>): DemoEntry => ({
    file: "a b.mp4",
    shows: "x | y",
    runId: "run-1",
    date: "d",
    target: "local",
    voice: "v",
    pace: "demo",
    verdict: "PASS",
    durationSec: null,
    ...over,
  })

  test("an unknown length is a dash and a known one has a decimal", () => {
    const md = demosReadme(
      catalogue,
      [entry({}), entry({ file: "b.mp4", durationSec: 12.34 })],
      new Date(0),
    )
    expect(md).toContain("| [a b.mp4](a%20b.mp4) | x \\| y |")
    expect(md).toMatch(/\| PASS \| —/)
    expect(md).toContain("| 12.3s |")
  })

  test("a manifest without an entries list starts empty; a kept video is reported", () => {
    const root = mkdtempSync(join(tmpdir(), "flowreel-demos-"))
    try {
      const run = join(root, "run")
      const latest = join(root, "latest")
      mkdirSync(run)
      mkdirSync(latest)
      writeFileSync(join(run, "a.mp4"), "A")
      writeFileSync(join(run, "b.mp4"), "B")
      writeFileSync(
        join(run, "summary.json"),
        JSON.stringify({
          runId: "run-2",
          module: "orders-tour",
          target: "local",
          verdict: "FAIL",
          pace: { pace: "demo" },
          tourVideo: {
            produced: true,
            areas: [
              { area: "A", file: "a.mp4" },
              { area: "B", file: "b.mp4" },
            ],
          },
          features: [
            { area: "A", status: "passed" },
            { area: "B", status: "failed" },
          ],
        }),
      )
      // Corrupt shape: not a list.
      writeFileSync(join(latest, "demos.json"), JSON.stringify({ entries: 1 }))
      const first = publishDemos(catalogue, run, latest, new Date(0), {
        automatic: true,
      })
      expect(first).toMatchObject({
        published: true,
        files: ["01-area-A-first.mp4", "02-area-B-second.mp4"],
      })
      expect("kept" in first).toBe(false)
      // The same run again: B's FAIL would replace the PASS? It was FAIL, so
      // nothing is kept. Mark B as a PASS already published, then rerun.
      const manifest = JSON.parse(
        readFileSync(join(latest, "demos.json"), "utf8"),
      ) as { entries: DemoEntry[] }
      for (const e of manifest.entries) {
        if (e.file.startsWith("02")) e.verdict = "PASS"
      }
      writeFileSync(join(latest, "demos.json"), JSON.stringify(manifest))
      const second = publishDemos(catalogue, run, latest, new Date(0), {
        automatic: true,
      })
      expect(second).toMatchObject({
        published: true,
        files: ["01-area-A-first.mp4"],
        kept: ["02-area-B-second.mp4"],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
