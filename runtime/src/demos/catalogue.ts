// SPDX-License-Identifier: Apache-2.0

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { basename, isAbsolute, join, relative, resolve } from "node:path"

// One fixed place for a project's demo videos: <demos>/latest/ (git-ignored).
// After a demo-pace run that produced videos, its final MP4s are copied
// there under fixed numbered names, replacing the previous ones, with a
// README.md saying what each shows, its run, date, target, voice, pace and
// verdict. The run folders stay as the evidence. A qa-pace run never
// touches latest/.
//
//   00-<round trip>.mp4                 the round trip (narrated = demo)
//   01-area-<key>-<title>.mp4 …         one per tour area, numbered in order
//   NN-<full tour>.mp4                  only from a run of every area
//
// The reporter publishes automatically at demo pace, but only for a
// development run (the catalogue's development target), and an automatic
// publish never replaces a PASS video with a FAIL one. Any other demo-pace
// run (a staging run) reaches latest/ only on purpose, through the demos
// command. The project's DemoCatalogue supplies the names, the copy and the
// folder; the planning here (planDemos, keepPassing, demosReadme) is pure
// and publishDemos copies.

/** A fixed demo file and what it shows. */
export interface DemoFile {
  file: string
  shows: string
}

/** One tour area's demo: its key (an area letter), title and description. */
export interface DemoArea {
  key: string
  /** The area's title; its slug names the file. */
  title: string
  shows: string
}

/** The README.md wording of latest/. */
export interface DemoReadmeCopy {
  /** The heading after "# " (e.g. "Product demo videos (latest)"). */
  heading: string
  /** The paragraph under the heading (a who-may-see-this notice). */
  notice: string
  /** Who updated it: "Updated <ISO> by <updatedBy>." */
  updatedBy: string
  /** Where the run folders are, as shown (e.g. "results/<run id>/"). */
  runsFolder: string
  /** The command that publishes a run on purpose (also in the skip reason). */
  refreshCommand: string
}

/**
 * A project's demo catalogue: where latest/ is, the round trip's and the
 * tour's fixed names, and the README copy. The `roundTrip` and `tour`
 * sections take a RoundTripModule / TourModule as is (they read only
 * `name` and its demo names). A run is published under a section only when
 * its summary's module is that section's `name`; a summary that records no
 * module (one written before the reporter recorded it) is the round trip's.
 */
export interface DemoCatalogue {
  /** The latest/ folder. */
  dir: string
  /**
   * The run id a demos command accepts. parseRunIdArg also refuses anything
   * path-like (a separator or "..") whatever the pattern, and ignores its
   * g / y flags.
   */
  runIdPattern: RegExp
  /** The run folder of a run id. */
  runDir(runId: string): string
  /** The target automatic publishing accepts (default "local"). */
  developmentTarget?: string
  roundTrip?: { name: string; demo: DemoFile }
  tour?: { name: string; demos: { areas: DemoArea[]; fullTour: DemoFile } }
  readme: DemoReadmeCopy
}

/** latest/'s manifest: what each fixed file is, from which run (demosReadme's source). */
export const DEMOS_MANIFEST = "demos.json"

/** One file in latest/ as demos.json and README.md list it. */
export interface DemoEntry {
  file: string
  shows: string
  runId: string
  /** ISO date-time the run started. */
  date: string
  target: string
  voice: string
  pace: string
  verdict: string
  durationSec: number | null
}

/** The slice of a run's summary.json the demos read. */
export interface DemoSummary {
  runId?: string
  module?: string
  target?: string
  verdict?: string
  startedAt?: string
  pace?: { pace?: string; slowFactor?: number } | string
  narration?: { produced?: boolean; voice?: string; reason?: string }
  video?: { produced?: boolean; file?: string; durationSec?: number }
  tourVideo?: {
    produced?: boolean
    tour?: { file?: string; durationSec?: number }
    areas?: { area?: string; file?: string; durationSec?: number }[]
  } | null
  features?: { area?: string; status?: string }[]
}

/** One planned copy: a run's video and the latest/ entry it becomes. */
export interface DemoCopy {
  /** Relative to the run folder. */
  from: string
  entry: DemoEntry
}

/** What planDemos decided: the copies (and whether they are a full tour), or why nothing. */
export type DemoPlan =
  { copies: DemoCopy[]; fullTour: boolean } | { skip: string }

export interface PublishOptions {
  /**
   * The reporter's publish after a run: development runs only, and a FAIL
   * video never replaces a PASS one. The demos command publishes as asked.
   */
  automatic?: boolean
}

/** What publishDemos did: the files copied (and kept), or why nothing was. */
export type PublishOutcome =
  | { published: true; dir: string; files: string[]; kept?: string[] }
  | { published: false; reason: string }

const slug = (title: string) =>
  title
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

/** "01-area-A-getting-started.mp4": the area's place (1-based), key and title. */
export function areaDemoName(catalogue: DemoCatalogue, key: string): string {
  const areas = catalogue.tour?.demos.areas ?? []
  const index = areas.findIndex((a) => a.key === key)
  const area = areas[index]
  if (!area) throw new Error(`Unknown demo area ${JSON.stringify(key)}.`)
  return `${String(index + 1).padStart(2, "0")}-area-${key}-${slug(area.title)}.mp4`
}

/** Why automatic publishing skips a non-development run. */
export function stagingSkip(catalogue: DemoCatalogue): string {
  return `a staging run (automatic publishing takes development runs only; ${catalogue.readme.refreshCommand} publishes it on purpose)`
}

const paceOf = (summary: DemoSummary) =>
  typeof summary.pace === "string" ? summary.pace : summary.pace?.pace

/** An area's verdict from its features: FAIL / PASS / N/A. */
export function areaVerdict(
  features: DemoSummary["features"],
  key: string,
): string {
  const own = (features ?? []).filter((f) => f?.area === key)
  if (own.some((f) => f.status === "failed")) return "FAIL"
  if (own.some((f) => f.status === "passed" || f.status === "view-only")) {
    return "PASS"
  }
  return "N/A"
}

/** Pure: what a run puts into latest/ (or why nothing). */
export function planDemos(
  catalogue: DemoCatalogue,
  summary: DemoSummary,
  options: PublishOptions = {},
): DemoPlan {
  if (paceOf(summary) !== "demo") {
    return { skip: "not a demo-pace run (qa pace never touches latest/)" }
  }
  if (
    options.automatic &&
    summary.target !== (catalogue.developmentTarget ?? "local")
  ) {
    return { skip: stagingSkip(catalogue) }
  }
  const voice = summary.narration?.produced
    ? (summary.narration.voice ?? "narrated")
    : `silent (${summary.narration?.reason ?? "no narration"})`
  const base = {
    runId: summary.runId ?? "unknown-run",
    date: summary.startedAt ?? "",
    target: summary.target ?? "?",
    voice,
    pace: [
      "demo",
      typeof summary.pace === "object" && summary.pace?.slowFactor
        ? `(slow factor ${summary.pace.slowFactor})`
        : "",
    ]
      .filter(Boolean)
      .join(" "),
  }
  const safe = (file: unknown): file is string =>
    typeof file === "string" &&
    file !== "" &&
    !isAbsolute(file) &&
    !file.split(/[\\/]/).includes("..")
  const tourModule = catalogue.tour
  if (tourModule && summary.module === tourModule.name) {
    const tour = summary.tourVideo
    if (!tour?.produced) return { skip: "the run produced no tour video" }
    const copies: DemoCopy[] = []
    const areas = tourModule.demos.areas
    for (const area of tour.areas ?? []) {
      const known = areas.find((a) => a.key === area?.area)
      if (!known || !safe(area.file)) continue
      copies.push({
        from: area.file,
        entry: {
          ...base,
          file: areaDemoName(catalogue, known.key),
          shows: known.shows,
          verdict: areaVerdict(summary.features, known.key),
          durationSec: area.durationSec ?? null,
        },
      })
    }
    const fullTour = areas.every((a) =>
      copies.some((c) => c.entry.file === areaDemoName(catalogue, a.key)),
    )
    if (fullTour && safe(tour.tour?.file)) {
      copies.push({
        from: tour.tour.file,
        entry: {
          ...base,
          file: tourModule.demos.fullTour.file,
          shows: tourModule.demos.fullTour.shows,
          verdict: summary.verdict ?? "?",
          durationSec: tour.tour.durationSec ?? null,
        },
      })
    }
    return copies.length > 0
      ? { copies, fullTour }
      : { skip: "the run produced no area video" }
  }
  if (!summary.video?.produced || !safe(summary.video.file)) {
    return { skip: "the run produced no video" }
  }
  if (!catalogue.roundTrip) {
    return { skip: "the demo catalogue has no round-trip demo" }
  }
  // Only the round trip's own run becomes its demo (a tour run against a
  // catalogue without a tour, or any other named module, is not it). A
  // summary with no module predates the reporter recording one and only
  // ever came from the round trip, so it still publishes as the round trip.
  if (
    summary.module !== undefined &&
    summary.module !== catalogue.roundTrip.name
  ) {
    return { skip: `no demo for module ${summary.module}` }
  }
  return {
    fullTour: false,
    copies: [
      {
        from: summary.video.file,
        entry: {
          ...base,
          file: catalogue.roundTrip.demo.file,
          shows: catalogue.roundTrip.demo.shows,
          verdict: summary.verdict ?? "?",
          durationSec: summary.video.durationSec ?? null,
        },
      },
    ],
  }
}

const cell = (value: string) => value.replace(/\|/g, "\\|").replace(/\n/g, " ")

/** Pure: latest/README.md from the current entries. */
export function demosReadme(
  catalogue: DemoCatalogue,
  entries: DemoEntry[],
  updatedAt: Date,
): string {
  const copy = catalogue.readme
  const sorted = [...entries].sort((a, b) => a.file.localeCompare(b.file))
  return [
    `# ${copy.heading}`,
    "",
    copy.notice,
    "",
    `Updated ${updatedAt.toISOString()} by ${copy.updatedBy}. Each file is copied from its run folder under \`${copy.runsFolder}\`, which stays as the evidence. Refresh from a run: \`${copy.refreshCommand}\`.`,
    "",
    "| Video | What it shows | Run | Date | Target | Voice | Pace | Verdict | Length |",
    "|---|---|---|---|---|---|---|---|---|",
    ...sorted.map(
      (e) =>
        `| [${e.file}](${encodeURI(e.file)}) | ${cell(e.shows)} | ${cell(e.runId)} | ${cell(e.date)} | ${cell(e.target)} | ${cell(e.voice)} | ${cell(e.pace)} | ${cell(e.verdict)} | ${e.durationSec === null ? "—" : `${e.durationSec.toFixed(1)}s`} |`,
    ),
    "",
  ].join("\n")
}

function readEntries(dir: string): DemoEntry[] {
  try {
    const raw = JSON.parse(readFileSync(join(dir, DEMOS_MANIFEST), "utf8")) as {
      entries?: unknown
    }
    return Array.isArray(raw.entries) ? (raw.entries as DemoEntry[]) : []
  } catch {
    return []
  }
}

/**
 * Pure, automatic publishing only: drops each copy whose FAIL video would
 * replace a PASS one already in latest/; the tour set is then no longer
 * replaced as a whole (the kept files stay).
 */
export function keepPassing(
  plan: { copies: DemoCopy[]; fullTour: boolean },
  existing: DemoEntry[],
): { copies: DemoCopy[]; fullTour: boolean; kept: string[] } {
  const kept: string[] = []
  const copies = plan.copies.filter((copy) => {
    const current = existing.find((e) => e.file === copy.entry.file)
    const keep = copy.entry.verdict === "FAIL" && current?.verdict === "PASS"
    if (keep) kept.push(copy.entry.file)
    return !keep
  })
  return { copies, fullTour: plan.fullTour && kept.length === 0, kept }
}

/**
 * Copies a run's demo videos into latest/ (each through a temporary name,
 * so a reader never sees half a file) and rewrites demos.json + README.md.
 * A full-tour run replaces the whole tour set; a partial one only its areas.
 */
export function publishDemos(
  catalogue: DemoCatalogue,
  runDir: string,
  dir: string = catalogue.dir,
  now: Date = new Date(),
  options: PublishOptions = {},
): PublishOutcome {
  let summary: DemoSummary
  try {
    summary = JSON.parse(
      readFileSync(join(runDir, "summary.json"), "utf8"),
    ) as DemoSummary
  } catch {
    return { published: false, reason: "the run has no readable summary.json" }
  }
  const planned = planDemos(catalogue, summary, options)
  if ("skip" in planned) return { published: false, reason: planned.skip }
  let entries = readEntries(dir)
  const plan = options.automatic
    ? keepPassing(planned, entries)
    : { ...planned, kept: [] as string[] }
  if (plan.copies.length === 0) {
    return {
      published: false,
      reason: `this run failed; the passing videos in latest/ stay (${plan.kept.join(", ")})`,
    }
  }
  const missing = plan.copies.find(
    (c) =>
      relative(runDir, resolve(runDir, c.from)).startsWith("..") ||
      !existsSync(resolve(runDir, c.from)),
  )
  if (missing) {
    return { published: false, reason: `${missing.from} is missing` }
  }
  mkdirSync(dir, { recursive: true })
  if (plan.fullTour && catalogue.tour) {
    const tourFiles = new Set([
      ...catalogue.tour.demos.areas.map((a) => areaDemoName(catalogue, a.key)),
      catalogue.tour.demos.fullTour.file,
    ])
    for (const entry of entries.filter((e) => tourFiles.has(e.file))) {
      rmSync(join(dir, entry.file), { force: true })
    }
    entries = entries.filter((e) => !tourFiles.has(e.file))
  }
  for (const copy of plan.copies) {
    const target = join(dir, copy.entry.file)
    const partial = `${target}.part`
    copyFileSync(resolve(runDir, copy.from), partial)
    renameSync(partial, target)
    entries = [...entries.filter((e) => e.file !== copy.entry.file), copy.entry]
  }
  writeFileSync(
    join(dir, DEMOS_MANIFEST),
    `${JSON.stringify({ updatedAt: now.toISOString(), entries }, null, 2)}\n`,
  )
  writeFileSync(join(dir, "README.md"), demosReadme(catalogue, entries, now))
  return {
    published: true,
    dir,
    files: plan.copies.map((c) => c.entry.file),
    ...(plan.kept.length > 0 ? { kept: plan.kept } : {}),
  }
}

/**
 * A run id as the project makes it, or null. Never a path, whatever the
 * catalogue's pattern: ".", or a value with a separator, "..", or a NUL is refused
 * before the pattern runs, and the pattern runs without its g / y flags (so
 * it keeps no state between calls).
 */
export function parseRunIdArg(
  catalogue: DemoCatalogue,
  raw: string | undefined,
): string | null {
  const value = raw?.trim() ?? ""
  if (
    value === "" ||
    value === "." ||
    /[\\/\0]/.test(value) ||
    value.includes("..") ||
    basename(value) !== value
  ) {
    return null
  }
  const pattern = new RegExp(
    catalogue.runIdPattern.source,
    catalogue.runIdPattern.flags.replace(/[gy]/g, ""),
  )
  return pattern.test(value) ? value : null
}

/**
 * The catalogue's functions bound to it, under the names a project's own
 * demos module exports (and what the demos command needs).
 */
export interface DemoPublisher {
  readonly catalogue: DemoCatalogue
  readonly dir: string
  readonly stagingSkip: string
  areaDemoName(key: string): string
  planDemos(summary: DemoSummary, options?: PublishOptions): DemoPlan
  demosReadme(entries: DemoEntry[], updatedAt: Date): string
  keepPassing: typeof keepPassing
  areaVerdict: typeof areaVerdict
  publishDemos(
    runDir: string,
    dir?: string,
    now?: Date,
    options?: PublishOptions,
  ): PublishOutcome
  parseRunIdArg(raw: string | undefined): string | null
  runDirOf(runId: string): string
}

/** Binds a catalogue's functions to it (see DemoPublisher). */
export function demoPublisher(catalogue: DemoCatalogue): DemoPublisher {
  return {
    catalogue,
    dir: catalogue.dir,
    stagingSkip: stagingSkip(catalogue),
    areaDemoName: (key) => areaDemoName(catalogue, key),
    planDemos: (summary, options) => planDemos(catalogue, summary, options),
    demosReadme: (entries, updatedAt) =>
      demosReadme(catalogue, entries, updatedAt),
    keepPassing,
    areaVerdict,
    publishDemos: (runDir, dir, now, options) =>
      publishDemos(catalogue, runDir, dir, now, options),
    parseRunIdArg: (raw) => parseRunIdArg(catalogue, raw),
    runDirOf: (runId) => catalogue.runDir(runId),
  }
}
