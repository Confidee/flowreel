// SPDX-License-Identifier: Apache-2.0

import { agreedEnvValue } from "../config/source.js"
import type { Env } from "../core/env.js"
import { ConfigError } from "../core/errors.js"

import type { Policy } from "./policy.js"

// TourManifest: a module's feature tour as data. Areas are single capital
// letters ("A" … "I"), each with its own Playwright project
// ("<projectPrefix><letter>") behind one setup project; feature ids are the
// area letter plus a number ("A4"), test titles "<id> <slug>" and step
// titles "<id>.<n> <sentence>". The catalogue holds every feature's slug
// and owner-approved staging policy.

/** One tour area: a capital letter, its spec slug and its title. */
export interface TourArea {
  /** One capital letter. */
  letter: string
  /** The area's spec file slug. */
  slug: string
  title: string
}

/** A catalogue feature: its title slug and owner-approved staging policy. */
export interface CatalogueEntry {
  slug: string
  policy: Policy
}

/**
 * What a project declares for defineTourManifest(): its areas, setup project
 * and feature catalogue.
 */
export interface TourManifestInput {
  areas: readonly TourArea[]
  /** The project every area depends on (setup that signs nothing in). */
  setupProject: string
  /** Area projects are "<projectPrefix><lower-case letter>" (default "tour-"). */
  projectPrefix?: string
  /** Every feature: id -> slug + policy. */
  catalogue: Readonly<Record<string, CatalogueEntry>>
}

/**
 * A module's feature tour as data (see the file comment), built by
 * defineTourManifest(). feature(), the reporter and the pipeline's --area flag
 * all read the same manifest, so titles, projects and letters agree.
 */
export interface TourManifest {
  readonly areas: readonly TourArea[]
  readonly setupProject: string
  readonly catalogue: Readonly<Record<string, CatalogueEntry>>
  /** The area letters as a regex character class body ("A-I" style list). */
  readonly letters: string
  projectOfArea: (letter: string) => string
  areaOfProject: (project: string) => TourArea | null
  isTourProject: (project: string) => boolean
  /** "--area A,c" -> ["A", "C"] (sorted, unique); throws on an unknown letter. */
  parseAreas: (raw: string) => string[]
  /** "A4 list-search" -> { id: "A4", slug: "list-search" }; null otherwise. */
  parseFeatureTitle: (title: string) => { id: string; slug: string } | null
  /** "A4.1 Search finds …" -> the id, step number and sentence. */
  parseStepTitle: (
    title: string,
  ) => { feature: string; n: number; sentence: string } | null
  /** "A4" -> its area; null for an id outside every area. */
  areaOfFeature: (id: string) => TourArea | null
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")

/** "A-I" for a contiguous run of letters, else "A, C, E". */
function letterRange(letters: string[]): string {
  const codes = letters.map((l) => l.charCodeAt(0))
  const contiguous = codes.every((c, i) => i === 0 || c === codes[i - 1] + 1)
  return contiguous && letters.length > 1
    ? `${letters[0]}-${letters[letters.length - 1]}`
    : letters.join(", ")
}

/** Checks a manifest and builds its helpers. Throws a ConfigError. */
export function defineTourManifest(input: TourManifestInput): TourManifest {
  const letters = input.areas.map((a) => a.letter)
  if (letters.length === 0) throw new ConfigError("A tour needs areas.")
  for (const letter of letters) {
    if (!/^[A-Z]$/.test(letter)) {
      throw new ConfigError(`Tour area "${letter}" is not one capital letter.`)
    }
  }
  if (new Set(letters).size !== letters.length) {
    throw new ConfigError(`Tour areas repeat a letter (${letters.join(", ")}).`)
  }
  const sorted = [...letters].sort()
  const prefix = input.projectPrefix ?? "tour-"
  const cls = sorted.join("")
  const lower = cls.toLowerCase()
  const featureRe = new RegExp(`^([${cls}]\\d{1,2})\\s+(\\S.*)$`)
  const stepRe = new RegExp(`^([${cls}]\\d{1,2})\\.(\\d{1,2})\\s+(\\S.*)$`)
  const projectRe = new RegExp(`^${escape(prefix)}([${lower}])$`)
  for (const id of Object.keys(input.catalogue)) {
    if (!new RegExp(`^[${cls}]\\d{1,2}$`).test(id)) {
      throw new ConfigError(
        `Catalogue id "${id}" is not an area letter plus a number.`,
      )
    }
  }
  const areaOf = (letter: string) =>
    input.areas.find((a) => a.letter === letter) ?? null
  const range = letterRange(sorted)
  const example = `${sorted[0]},${sorted[2] ?? sorted[1] ?? sorted[0]}`

  const manifest: TourManifest = {
    areas: input.areas,
    setupProject: input.setupProject,
    catalogue: input.catalogue,
    letters: cls,
    projectOfArea: (letter) => `${prefix}${letter.toLowerCase()}`,
    areaOfProject: (project) => {
      const m = projectRe.exec(project)
      return m ? areaOf(m[1].toUpperCase()) : null
    },
    isTourProject: (project) =>
      project === input.setupProject ||
      manifest.areaOfProject(project) !== null,
    parseAreas: (raw) => {
      const given = raw
        .split(",")
        .map((part) => part.trim().toUpperCase())
        .filter(Boolean)
      if (given.length === 0) {
        throw new ConfigError(
          `--area needs one or more letters ${range} (e.g. ${example}).`,
        )
      }
      const bad = given.filter((l) => !letters.includes(l))
      if (bad.length > 0) {
        throw new ConfigError(
          `Unknown area ${bad.join(", ")}; the tour has areas ${letters.join(", ")}.`,
        )
      }
      return [...new Set(given)].sort()
    },
    parseFeatureTitle: (title) => {
      const m = featureRe.exec(title.trim())
      return m ? { id: m[1], slug: m[2] } : null
    },
    parseStepTitle: (title) => {
      const m = stepRe.exec(title.trim())
      return m ? { feature: m[1], n: Number(m[2]), sentence: m[3] } : null
    },
    areaOfFeature: (id) => (/^[A-Z]/.test(id) ? areaOf(id[0]) : null),
  }
  return manifest
}

/**
 * The module a Playwright run belongs to: FLOWREEL_MODULE (or its alias)
 * when it names a module, else `tourModule` when any selected project
 * (`--project x`, `--project=x`) is a tour project, else `fallback`. The
 * Playwright config calls it in the runner process and exports the answer,
 * so workers and the reporter inherit it. Two names of MODULE set to
 * different modules are refused (agreedEnvValue).
 */
export function detectModule<M extends string>(
  argv: string[],
  env: Env,
  options: {
    modules: readonly M[]
    tourModule: M
    fallback: M
    isTourProject: (project: string) => boolean
  },
): M {
  const explicit = agreedEnvValue(env, "MODULE")?.trim()
  if (explicit && (options.modules as readonly string[]).includes(explicit)) {
    return explicit as M
  }
  const projects: string[] = []
  argv.forEach((arg, i) => {
    if (arg.startsWith("--project=")) projects.push(arg.slice(10))
    else if (arg === "--project" && argv[i + 1]) projects.push(argv[i + 1])
  })
  return projects.some(options.isTourProject)
    ? options.tourModule
    : options.fallback
}
