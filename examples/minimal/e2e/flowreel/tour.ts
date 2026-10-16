// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { requireStorageState } from "@confidee/flowreel/app"
import { resultsDir } from "@confidee/flowreel/config"
import { envName, envValue, fileUndoStore } from "@confidee/flowreel/core"
import type {
  RoundTripModule,
  SummaryReporterOptions,
} from "@confidee/flowreel/reporter"
import { currentRunId } from "@confidee/flowreel/run"
import {
  InboundMailBudget,
  type TourFixtureOptions,
  defineTourManifest,
  fileBudgetStore,
  parseCatalogue,
  parsePace,
  tourModuleFrom,
} from "@confidee/flowreel/tour"
import {
  type TourVideoConfig,
  type VideoKit,
  createVideoKit,
  defineBrand,
  defineCardCopy,
  defineNarrationCopy,
  produceTourVideos,
  produceVideo,
  svgDataUri,
  videoPaceFor,
} from "@confidee/flowreel/video"

import config, {
  EXAMPLE_DIR,
  PERSONAS,
  type PersonaKey,
  TOUR_MODULE,
} from "../../flowreel.config"

import { NotesApi, describeRun, loadRun, notesApp } from "./adapter"

// The Notes feature tour as data: its manifest (one area, three features,
// their staging policies read from the plan), the reporter's modules, the
// video kit (brand, card copy, narration) and the options of flowreel's
// generic tour fixtures.

const FLOWREEL_DIR = join(EXAMPLE_DIR, "e2e", "flowreel")

/** Area A's plan: the human contract, whose catalogue table the tour reads. */
export const PLAN_FILE = join(FLOWREEL_DIR, "plans", "tour-a.md")

/**
 * The tour: area A ("Notes", project tour-a) behind the tour-setup project.
 * Each feature's slug and staging policy come from the plan's catalogue
 * table, so feature() refuses a flow whose policy differs from the plan.
 */
export const NOTES_TOUR = defineTourManifest({
  areas: [{ letter: "A", slug: "notes", title: "Notes" }],
  setupProject: "tour-setup",
  catalogue: parseCatalogue(readFileSync(PLAN_FILE, "utf8"), {
    letters: "A",
    file: "e2e/flowreel/plans/tour-a.md",
  }),
})

/** How the videos name each persona ("as admin"). */
export const PERSONA_LABELS: Record<PersonaKey, string> = {
  editor: "editor",
  admin: "admin",
}

/** The persona the recorded page starts as (the storageState option). */
export const INITIAL_PERSONA: PersonaKey = "editor"

/** The run's pace: FLOWREEL_PACE=demo (default, readable) or qa (fast). */
export const runPace = () =>
  parsePace(envValue(process.env, "PACE"), envName(process.env, "PACE"))

// ---------------------------------------------------------------------------
// The generic tour fixtures' options
// ---------------------------------------------------------------------------

let run: ReturnType<typeof loadRun> | undefined
/** The run's settings, read once per process. */
export const currentRun = () => (run ??= loadRun())

export const TOUR_FIXTURES: TourFixtureOptions<PersonaKey, NotesApi> = {
  personas: PERSONAS,
  baseURL: () => currentRun().baseURL,
  runId: () => currentRunId(),
  pace: runPace,
  stateFor: (persona) => requireStorageState(persona),
  client: (context, persona) => new NotesApi(context, persona),
  // <results>/<RUN_ID>/undo.json + undo.md, written before every change.
  undoStore: (runId) => fileUndoStore(resultsDir(config, runId), runId),
  // The example sends no mail; the budget is part of the fixture contract.
  inboundBudget: (runId) =>
    new InboundMailBudget(
      fileBudgetStore(join(resultsDir(config, runId), "inbound-mail.json")),
      currentRun().target,
    ),
  featureKey: (info) =>
    NOTES_TOUR.parseFeatureTitle(info.title)?.id ?? info.title,
  app: notesApp,
  keepalive: { logPrefix: config.logPrefix },
}

// ---------------------------------------------------------------------------
// The videos
// ---------------------------------------------------------------------------

const BRAND_DIR = join(FLOWREEL_DIR, "brand")

export const NOTES_BRAND = defineBrand({
  name: "Notes",
  colors: { primary: "#0f766e", accent: "#14b8a6", shadow: "#042f2e" },
  logos: () => ({
    onBrand: svgDataUri(join(BRAND_DIR, "logo-white.svg")),
    onLight: svgDataUri(join(BRAND_DIR, "logo.svg")),
  }),
})

export const NOTES_CARD_COPY = defineCardCopy({
  standby: { heading: "Recorded browser", line: "Notes feature tour" },
  tour: {
    title: "Notes feature tour",
    frameLabel: "Notes tour",
    areaKicker: "Notes feature tour · area",
  },
})

export const NOTES_NARRATION_COPY = defineNarrationCopy({
  tour: {
    intro: (target, count) =>
      `This is the Notes feature tour on ${target}: ${count} features, each one recorded as a colleague would use it.`,
  },
})

/** Curated lines: e2e/flowreel/narration/tour-a.json. */
export const NARRATION_DIR = join(FLOWREEL_DIR, "narration")

/** The video kit: brand, copy, narration lines and the voice clip cache. */
export function notesVideoKit(): VideoKit {
  return createVideoKit({
    brand: NOTES_BRAND,
    copy: NOTES_CARD_COPY,
    narrationCopy: NOTES_NARRATION_COPY,
    narrationDir: NARRATION_DIR,
    voice: {
      cacheDir: join(EXAMPLE_DIR, ".flowreel", "cache", "voice"),
      log: (line) => console.log(`[${config.logPrefix}] ${line}`),
    },
  })
}

export const NOTES_TOUR_VIDEO: TourVideoConfig = {
  module: TOUR_MODULE,
  areas: NOTES_TOUR.areas,
  initialPersona: PERSONA_LABELS[INITIAL_PERSONA],
}

// ---------------------------------------------------------------------------
// The reporter
// ---------------------------------------------------------------------------

/**
 * The reporter takes exactly one round-trip module (a release-gate flow in
 * one project). This example has only the tour, so its gate names a
 * project the config does not define: it never runs, and the run's verdict
 * is the tour's. A known 0.x limitation: remove this once the reporter
 * accepts a tour without a round trip.
 */
export const NOTES_GATE: RoundTripModule = {
  kind: "round-trip",
  name: "notes-gate",
  project: "gate",
  verdictCopy: {
    passed: "The gate flow passed.",
    notInRun: "The gate flow was not part of this run.",
    skipped: "gate flow skipped",
  },
}

/** The tour as the reporter reads it: from the same manifest feature() uses. */
export const NOTES_TOUR_MODULE = tourModuleFrom(NOTES_TOUR, {
  name: TOUR_MODULE,
})

export function reporterOptions(): SummaryReporterOptions {
  let kit: VideoKit | undefined
  const videoKit = () => (kit ??= notesVideoKit())
  return {
    modules: [NOTES_GATE, NOTES_TOUR_MODULE],
    config,
    repoRoot: EXAMPLE_DIR,
    setupLocation: "e2e/flowreel/global-setup.ts:1",
    configuredTarget: () => currentRun().target,
    describeConfig: () => describeRun(currentRun()),
    videoPace: () => videoPaceFor("tour", process.env),
    produceVideo: (req) => produceVideo(req, videoKit()),
    produceTourVideos: (req) =>
      produceTourVideos(req, videoKit(), NOTES_TOUR_VIDEO),
    copy: { title: "Notes example" },
  }
}
