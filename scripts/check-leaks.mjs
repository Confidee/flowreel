#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

// The leak tripwire (docs/design/architecture.md, principle 3 "Brand-neutral
// core", and docs/design/decisions.md, decision 14): nothing in this
// repository may carry the specifics of a project that uses flowreel. Those
// belong in that project's adapter, which lives in that project.
//
//   node scripts/check-leaks.mjs     exit 0 when clean, 1 with one
//                                    "file:line: what" per hit, 2 when the
//                                    project patterns cannot be read
//
// Run by `npm test` in runtime/ before the unit tests, by CI, and imported
// by runtime/test/tripwire.spec.ts, so the engine lives in one place.
//
// It scans the WHOLE repository: every file except .git/, installed
// packages, build output and run results (SKIP_DIRS) and binary files.
// That includes this script and the tripwire spec.
//
// Two kinds of pattern:
// - BUILT_IN, published here: the publisher's name, outside the exact
//   publisher tokens allowlisted below.
// - Project patterns, never published: a consuming project supplies the
//   names, hosts, colours and variables that must stay out of this
//   repository, so the list itself does not disclose them. Give them as a
//   JSON array, either in a file named by FLOWREEL_LEAK_PATTERNS_FILE or
//   inline in FLOWREEL_LEAK_PATTERNS (for a CI secret). Each entry is a
//   regular-expression source string or { "pattern": "...", "flags": "i" }
//   (flags from "imsu"; any other key, such as "note", is ignored). A hit
//   is reported as "a project pattern (#n)", never with the pattern or the
//   matched text, so a public CI log reveals neither.
//
// Allowlisted, and nothing else:
// - the publisher's identity, as exact tokens that are removed from a line
//   before the patterns are tested (so a line that also names anything else
//   is still caught):
//   - the npm scope `@confidee/flowreel` and the repository slug
//     `Confidee/flowreel` (in URLs and `/plugin marketplace add`), anywhere;
//   - the copyright holder "Confidee GmbH", in the files that state copyright
//     or ownership only (COPYRIGHT_FILES);
//   - the security and conduct contact address, in SECURITY.md and
//     CODE_OF_CONDUCT.md only (CONTACT_FILES);
// - the publisher's name, and only that (project patterns still apply):
//   in README.md's "## Who uses it" section, and in this script and the
//   tripwire spec, which test the publisher tokens.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

/** The repository root: everything is scanned relative to it. */
export const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
)

const PUBLISHER_NAME = "the publisher's name"

/** The published patterns. Everything project-specific is supplied. */
export const BUILT_IN = [{ name: PUBLISHER_NAME, pattern: /confidee/i }]

/** Scanned roots, relative to the repository root: all of it. */
export const ROOTS = ["."]

/** Version control, installed packages, build output, caches, run results. */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "test-results",
  "playwright-report",
  "flowreel-results",
  "flowreel-demos",
  ".flowreel",
  "coverage",
])

/**
 * The publisher's own identity, which is not a leak. These exact tokens are
 * removed from a line before the patterns are tested.
 */
const PUBLISHER_EVERYWHERE = [
  /@confidee\/flowreel(?![\w-])/gi,
  /@confidee%2fflowreel(?![\w-])/gi,
  // The public repository, as a URL path or an owner/repository slug. The
  // case is exact: the GitHub organization is spelled "Confidee".
  /\bConfidee\/flowreel(?![\w-])/g,
]
const COPYRIGHT_HOLDER = /\bConfidee GmbH\b/g
const COPYRIGHT_FILES = new Set([
  "NOTICE",
  "runtime/NOTICE",
  "README.md",
  ".claude-plugin/marketplace.json",
])
const CONTACT_ADDRESS = /\bsupport@confidee\.com\b/g
const CONTACT_FILES = new Set(["SECURITY.md", "CODE_OF_CONDUCT.md"])

function withoutPublisher(file, line) {
  let out = line
  for (const token of PUBLISHER_EVERYWHERE) out = out.replace(token, "")
  if (COPYRIGHT_FILES.has(file)) out = out.replace(COPYRIGHT_HOLDER, "")
  if (CONTACT_FILES.has(file)) out = out.replace(CONTACT_ADDRESS, "")
  return out
}

/**
 * Files that test the publisher tokens: the publisher's name is allowed in
 * them, every project pattern still applies.
 */
const FILE_ALLOW = new Map([
  ["scripts/check-leaks.mjs", new Set([PUBLISHER_NAME])],
  ["runtime/test/tripwire.spec.ts", new Set([PUBLISHER_NAME])],
])

/** README.md's "## Who uses it" section may name the publisher, nothing else. */
const SECTION_ALLOW = [
  {
    file: "README.md",
    heading: "## Who uses it",
    names: new Set([PUBLISHER_NAME]),
  },
]

/** Raised when the project patterns are missing, unreadable or invalid. */
export class PatternsError extends Error {}

const ALLOWED_FLAGS = /^[imsu]*$/

/**
 * The project patterns from `env`: FLOWREEL_LEAK_PATTERNS (inline JSON)
 * and FLOWREEL_LEAK_PATTERNS_FILE (a JSON file, relative to the current
 * directory). Neither set (or both empty) means none. Throws PatternsError
 * on anything it cannot use: a tripwire that silently drops its patterns
 * would pass everything.
 */
export function projectPatterns(env = process.env) {
  const sources = []
  const inline = env.FLOWREEL_LEAK_PATTERNS?.trim()
  if (inline) sources.push(["FLOWREEL_LEAK_PATTERNS", inline])
  const file = env.FLOWREEL_LEAK_PATTERNS_FILE?.trim()
  if (file) {
    let text
    try {
      text = readFileSync(resolve(file), "utf8")
    } catch (error) {
      throw new PatternsError(
        `FLOWREEL_LEAK_PATTERNS_FILE cannot be read (${error.code ?? "error"})`,
      )
    }
    sources.push(["FLOWREEL_LEAK_PATTERNS_FILE", text])
  }

  const out = []
  for (const [origin, text] of sources) {
    let list
    try {
      list = JSON.parse(text)
    } catch {
      throw new PatternsError(`${origin} is not valid JSON`)
    }
    if (!Array.isArray(list)) {
      throw new PatternsError(`${origin} must be a JSON array`)
    }
    list.forEach((entry, i) => {
      const where = `${origin} entry ${i + 1}`
      const source = typeof entry === "string" ? entry : entry?.pattern
      const flags = typeof entry === "string" ? "" : (entry?.flags ?? "")
      if (typeof source !== "string" || source === "") {
        throw new PatternsError(`${where} has no pattern`)
      }
      if (typeof flags !== "string" || !ALLOWED_FLAGS.test(flags)) {
        throw new PatternsError(`${where}: flags must be from "imsu"`)
      }
      let pattern
      try {
        pattern = new RegExp(source, flags)
      } catch {
        throw new PatternsError(`${where} is not a valid regular expression`)
      }
      out.push({ name: `a project pattern (#${out.length + 1})`, pattern })
    })
  }
  return out
}

/** The built-in patterns plus the project patterns from `env`. */
export function activePatterns(env = process.env) {
  return [...BUILT_IN, ...projectPatterns(env)]
}

const posix = (path) => path.split(sep).join("/")

/** A file with a NUL byte in its first 8 KiB is binary and is not read. */
function isBinary(path) {
  const head = readFileSync(path).subarray(0, 8192)
  return head.includes(0)
}

function walk(path) {
  if (!existsSync(path)) return []
  const stat = statSync(path)
  if (stat.isFile()) return isBinary(path) ? [] : [path]
  if (!stat.isDirectory()) return []
  const out = []
  for (const name of readdirSync(path).sort()) {
    if (SKIP_DIRS.has(name)) continue
    out.push(...walk(join(path, name)))
  }
  return out
}

/** Every file the tripwire reads, relative to `root` (posix separators). */
export function scannedFiles(root = PACKAGE_ROOT) {
  return [
    ...new Set(
      ROOTS.flatMap((entry) => walk(resolve(root, entry))).map((path) =>
        posix(relative(root, path)),
      ),
    ),
  ].sort()
}

/** The pattern names allowed on each line of `file` (1-based line numbers). */
function allowedOn(file, lines) {
  const allowed = new Map()
  const whole = FILE_ALLOW.get(file)
  if (whole) lines.forEach((_line, i) => allowed.set(i + 1, whole))
  for (const rule of SECTION_ALLOW.filter((r) => r.file === file)) {
    let inside = false
    lines.forEach((line, i) => {
      if (/^#{1,6} /.test(line)) inside = line.trim() === rule.heading
      if (inside) allowed.set(i + 1, rule.names)
    })
  }
  return allowed
}

/** "file:line: <what>" for every hit in `text`. */
export function violations(file, text, patterns = BUILT_IN) {
  const lines = text.split("\n")
  const allowed = allowedOn(file, lines)
  const hits = []
  lines.forEach((raw, i) => {
    const line = withoutPublisher(file, raw)
    for (const { name, pattern } of patterns) {
      if (allowed.get(i + 1)?.has(name)) continue
      if (pattern.test(line)) hits.push(`${file}:${i + 1}: ${name}`)
    }
  })
  return hits
}

/**
 * Scans the repository with the built-in patterns and the project patterns
 * from `env`; returns the files read, how many patterns were applied and
 * every hit.
 */
export function checkLeaks(root = PACKAGE_ROOT, env = process.env) {
  const patterns = activePatterns(env)
  const files = scannedFiles(root)
  const hits = files.flatMap((file) =>
    violations(file, readFileSync(resolve(root, file), "utf8"), patterns),
  )
  return { files, patterns: patterns.length, hits }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (invokedDirectly) {
  let result
  try {
    result = checkLeaks()
  } catch (error) {
    if (!(error instanceof PatternsError)) throw error
    console.error(`check-leaks: ${error.message}`)
    process.exit(2)
  }
  const { files, patterns, hits } = result
  const extra = patterns - BUILT_IN.length
  if (hits.length > 0) {
    console.error(
      `check-leaks: ${hits.length} project-specific reference(s) in the brand-neutral repository:`,
    )
    for (const hit of hits) console.error(`  ${hit}`)
    console.error(
      "Move them into the consuming project's adapter (see scripts/check-leaks.mjs for what is allowlisted).",
    )
    process.exit(1)
  }
  console.log(
    `check-leaks: ${files.length} files clean (${extra} project pattern(s) supplied)`,
  )
}
