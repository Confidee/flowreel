#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

// Builds the portable Agent Skill (skills/flowreel/) from the Claude Code
// plugin, and checks it against the Agent Skills specification.
//
//   node scripts/sync-agent-skill.mjs           write references/ and scripts/
//   node scripts/sync-agent-skill.mjs --check   change nothing; exit 1 when the
//                                               generated files are stale or
//                                               SKILL.md breaks the spec
//
// skills/flowreel/SKILL.md is written by hand. Everything under its
// references/ and scripts/ is generated from plugin/ (the workflows, the
// shared references, the agents' instructions and the prerequisite check),
// so the plugin stays the one source and the two cannot drift. Generated
// files are rewritten only where a path or wording is Claude Code specific
// (${CLAUDE_PLUGIN_ROOT}, $ARGUMENTS); every path becomes relative to the
// skill root, as the specification asks.
//
// Specification targeted: https://agentskills.io/specification as of
// agentskills/agentskills commit 69ef37e9424c (main, 2026-08-09; the
// specification file last changed in 217be548739f, 2026-08-04). The checks
// below are those of its reference validator (skills-ref 0.1.0, `validate`)
// plus the specification's own limits: a SKILL.md under 500 lines and
// every file it names present.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const plugin = join(root, "plugin")
export const SKILL_DIR = join(root, "skills", "flowreel")

/** Frontmatter fields the specification allows; anything else is refused. */
export const ALLOWED_FIELDS = [
  "allowed-tools",
  "compatibility",
  "description",
  "license",
  "metadata",
  "name",
]
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/
const MAX_SKILL_LINES = 500

const HEADER = (source) =>
  `<!-- Generated from ${source} in the flowreel repository (by its sync-agent-skill.mjs). Edit the source there, then run \`npm run sync:agent-skill\`. -->\n\n`

/** Removes a leading YAML frontmatter block. */
function body(text) {
  const m = /^---\n[\s\S]*?\n---\n+/.exec(text)
  return m ? text.slice(m[0].length) : text
}

/**
 * Rewrites what only makes sense inside the Claude Code plugin. Every
 * path becomes relative to the skill root. Throws when a plugin path is
 * left over, so a new kind of reference cannot slip through unconverted.
 */
export function portable(text, source) {
  let out = text
    // Inside code spans first: what replaces them is prose.
    .replaceAll("`$ARGUMENTS`", "the user's arguments")
    .replaceAll(
      "`${CLAUDE_PLUGIN_ROOT}/templates/`",
      'the templates (SKILL.md, "Templates", says where they come from)',
    )
    .replaceAll(
      '"${CLAUDE_PLUGIN_ROOT}/scripts/check-prereqs.sh"',
      "scripts/check-prereqs.sh",
    )
    .replaceAll(
      "${CLAUDE_PLUGIN_ROOT}/scripts/check-prereqs.sh",
      "scripts/check-prereqs.sh",
    )
    .replace(
      /\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/[a-z-]+\/reference\//g,
      "references/",
    )
    .replaceAll("${CLAUDE_PLUGIN_ROOT}/reference/", "references/")
    .replaceAll(
      "${CLAUDE_PLUGIN_ROOT}/templates/",
      'the templates (SKILL.md, "Templates", says where they come from)',
    )
    // A skill's own reference folder, linked relatively inside the plugin.
    .replace(/(\]\(|\[|`)reference\//g, "$1references/")
    .replaceAll("$ARGUMENTS", "the user's arguments")
    // A maintainer script of the repository, not part of the skill.
    .replaceAll(
      "`scripts/check-templates.sh`",
      "the flowreel repository's `plugin/scripts/check-templates.sh`",
    )
  if (out.includes("CLAUDE_PLUGIN_ROOT")) {
    throw new Error(
      `${source}: a \${CLAUDE_PLUGIN_ROOT} path has no portable form; add a rule to portable()`,
    )
  }
  return out
}

/** Every generated file: path relative to the skill root -> contents. */
export function generate() {
  const files = new Map()
  const add = (target, source, text) =>
    files.set(target, HEADER(source) + portable(body(text), source))
  const read = (path) => readFileSync(join(root, path), "utf8")
  for (const skill of readdirSync(join(plugin, "skills")).sort()) {
    const source = `plugin/skills/${skill}/SKILL.md`
    add(`references/${skill}.md`, source, read(source))
    const refs = join(plugin, "skills", skill, "reference")
    if (existsSync(refs)) {
      for (const file of readdirSync(refs).sort()) {
        const src = `plugin/skills/${skill}/reference/${file}`
        add(`references/${file}`, src, read(src))
      }
    }
  }
  for (const file of readdirSync(join(plugin, "reference")).sort()) {
    const src = `plugin/reference/${file}`
    add(`references/${file}`, src, read(src))
  }
  for (const file of readdirSync(join(plugin, "agents")).sort()) {
    const src = `plugin/agents/${file}`
    add(`references/agent-${file}`, src, read(src))
  }
  // The script runs as is: it already uses $CLAUDE_PROJECT_DIR or the
  // working directory, never the plugin's own path.
  files.set("scripts/check-prereqs.sh", read("plugin/scripts/check-prereqs.sh"))
  return files
}

/** The frontmatter of SKILL.md: top-level keys, `metadata` as a string map. */
export function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (!m) throw new Error("SKILL.md must start with a YAML frontmatter block")
  const fields = {}
  let current = null
  for (const line of m[1].split("\n")) {
    if (line.trim() === "") continue
    const nested = /^ {2}([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line)
    if (nested && current === "metadata") {
      fields.metadata[nested[1]] = unquote(nested[2])
      continue
    }
    const top = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!top) throw new Error(`unreadable frontmatter line: ${line}`)
    current = top[1]
    fields[current] =
      top[1] === "metadata" && top[2] === "" ? {} : unquote(top[2])
  }
  return fields
}

function unquote(value) {
  const v = value.trim()
  if (/^".*"$/.test(v) || /^'.*'$/.test(v)) return v.slice(1, -1)
  return v
}

/** Spec violations of a skill directory; empty when it conforms. */
export function validate(
  dir,
  text = readFileSync(join(dir, "SKILL.md"), "utf8"),
) {
  const problems = []
  let fields
  try {
    fields = parseFrontmatter(text)
  } catch (error) {
    return [error.message]
  }
  const unknown = Object.keys(fields).filter((k) => !ALLOWED_FIELDS.includes(k))
  if (unknown.length > 0)
    problems.push(
      `fields the specification does not allow: ${unknown.join(", ")}`,
    )
  const name = fields.name ?? ""
  if (!name) problems.push("name is required")
  else {
    if (name.length > 64) problems.push("name is longer than 64 characters")
    if (!NAME.test(name))
      problems.push(
        "name may only hold a-z, 0-9 and single hyphens, not at either end",
      )
    if (name !== basename(dir))
      problems.push(
        `name "${name}" must match its directory "${basename(dir)}"`,
      )
  }
  const description = fields.description ?? ""
  if (!description) problems.push("description is required")
  else if (description.length > 1024)
    problems.push("description is longer than 1024 characters")
  if (
    "compatibility" in fields &&
    (fields.compatibility.length < 1 || fields.compatibility.length > 500)
  ) {
    problems.push("compatibility must be 1 to 500 characters")
  }
  if (
    "metadata" in fields &&
    (typeof fields.metadata !== "object" || fields.metadata === null)
  ) {
    problems.push("metadata must be a map of strings")
  }
  const lines = text.split("\n").length
  if (lines > MAX_SKILL_LINES)
    problems.push(
      `SKILL.md has ${lines} lines; keep it under ${MAX_SKILL_LINES}`,
    )
  for (const [, path] of text.matchAll(
    /(?<![\w/])((?:references|scripts|assets)\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+)/g,
  )) {
    if (!existsSync(join(dir, path)))
      problems.push(`SKILL.md names ${path}, which does not exist`)
  }
  return [...new Set(problems)]
}

/** Files under references/ and scripts/ on disk, relative to the skill root. */
function onDisk() {
  const found = []
  for (const sub of ["references", "scripts"]) {
    const dir = join(SKILL_DIR, sub)
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir)) {
      if (statSync(join(dir, file)).isFile()) found.push(`${sub}/${file}`)
    }
  }
  return found
}

function main() {
  const check = process.argv.includes("--check")
  const files = generate()
  const problems = []
  if (check) {
    for (const [path, text] of files) {
      const target = join(SKILL_DIR, path)
      if (!existsSync(target)) problems.push(`${path} is missing`)
      else if (readFileSync(target, "utf8") !== text)
        problems.push(`${path} is stale`)
    }
    for (const path of onDisk()) {
      if (!files.has(path))
        problems.push(
          `${path} is not generated from plugin/ (remove it or add a source)`,
        )
    }
  } else {
    for (const sub of ["references", "scripts"])
      rmSync(join(SKILL_DIR, sub), { recursive: true, force: true })
    for (const [path, text] of files) {
      const target = join(SKILL_DIR, path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, text)
      if (path.endsWith(".sh")) chmodSync(target, 0o755)
    }
  }
  problems.push(...validate(SKILL_DIR).map((p) => `SKILL.md: ${p}`))
  if (problems.length > 0) {
    console.error(
      `sync-agent-skill: ${problems.length} problem(s)${check ? "; run npm run sync:agent-skill" : ""}:`,
    )
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }
  console.log(
    `sync-agent-skill: skills/flowreel ${check ? "is current" : "written"} (${files.size} generated files) and follows the specification.`,
  )
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main()
