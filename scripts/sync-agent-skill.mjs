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

/** How a generated file names the skill's own script: from the project. */
const SKILL_SCRIPT = "<this skill's folder>/scripts/check-prereqs.sh"

const HEADER = (source) =>
  `<!-- Generated from ${source} in the flowreel repository (by its sync-agent-skill.mjs). Edit the source there, then run \`npm run sync:agent-skill\`. -->\n\n`

/** Removes a leading YAML frontmatter block. */
function body(text) {
  const m = /^---\n[\s\S]*?\n---\n+/.exec(text)
  return m ? text.slice(m[0].length) : text
}

/** One plain `key: value` line of a plugin file's frontmatter, if present. */
function pluginField(text, key) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text)
  const line = m?.[1].split("\n").find((l) => l.startsWith(`${key}:`))
  return line?.slice(key.length + 1).trim()
}

/**
 * What the plugin's frontmatter enforced and the specification has no
 * field for, said in words at the top of the generated file: a workflow
 * the plugin never starts on its own, and an agent's tool limits.
 */
function boundaries(text) {
  const notes = []
  if (pluginField(text, "disable-model-invocation") === "true") {
    notes.push(
      "> In the plugin this workflow starts only when the user asks for it (`disable-model-invocation`). Here too: start it only on the user's request in this conversation.",
    )
  }
  const tools = pluginField(text, "tools")
  if (tools) {
    notes.push(
      `> Tools: ${tools} only. In the plugin the agent gets no others; outside it nothing enforces that, so when you do this work yourself, keep to them.`,
    )
  }
  return notes.length > 0 ? `${notes.join("\n>\n")}\n\n` : ""
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
    // The check runs FROM the project (it checks the folder it runs in),
    // so it is named by the skill's folder, never relative to the cwd.
    .replaceAll(
      '"${CLAUDE_PLUGIN_ROOT}/scripts/check-prereqs.sh"',
      SKILL_SCRIPT,
    )
    .replaceAll("${CLAUDE_PLUGIN_ROOT}/scripts/check-prereqs.sh", SKILL_SCRIPT)
    .replaceAll(
      "The project is `$CLAUDE_PROJECT_DIR`.",
      "The project is the folder it runs in (or `$CLAUDE_PROJECT_DIR` when set).",
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
  return generateFrom(root)
}

/**
 * generate() over another repository folder (tests). Two sources that
 * would land on one target are refused, never silently overwritten.
 */
export function generateFrom(rootDir) {
  const plugin = join(rootDir, "plugin")
  const files = new Map()
  const sources = new Map()
  const claim = (target, source) => {
    if (sources.has(target)) {
      throw new Error(
        `${target} has two sources: ${sources.get(target)} and ${source}; rename one`,
      )
    }
    sources.set(target, source)
  }
  const add = (target, source, text) => {
    claim(target, source)
    files.set(
      target,
      HEADER(source) + boundaries(text) + portable(body(text), source),
    )
  }
  const read = (path) => readFileSync(join(rootDir, path), "utf8")
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
  claim("scripts/check-prereqs.sh", "plugin/scripts/check-prereqs.sh")
  files.set("scripts/check-prereqs.sh", read("plugin/scripts/check-prereqs.sh"))
  return files
}

/**
 * The frontmatter of SKILL.md: top-level keys, `metadata` as a string map.
 *
 * A strict subset of YAML, so this check never passes what the reference
 * validator (skills-ref, strictyaml) rejects: one `key: value` per line,
 * `metadata:` followed by `  key: value` lines, values plain, 'single'- or
 * "double"-quoted. A plain value may not start with a YAML indicator or
 * hold ": " or " #"; a key may not repeat; anything else (lists, blocks,
 * flow collections, deeper nesting) is refused. Quote a value to use them.
 */
export function parseFrontmatter(input) {
  const text = input.replace(/\r\n/g, "\n")
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (!m) throw new Error("SKILL.md must start with a YAML frontmatter block")
  const fields = {}
  let current = null
  for (const line of m[1].split("\n")) {
    if (line.trim() === "" || line.startsWith("#")) continue
    const nested = /^ {2}([A-Za-z0-9_.-]+):(?: (.*))?$/.exec(line)
    if (nested) {
      if (current !== "metadata" || typeof fields.metadata !== "object") {
        throw new Error(`only metadata may hold nested keys: ${line}`)
      }
      if (nested[1] in fields.metadata) {
        throw new Error(`metadata key ${nested[1]} appears twice`)
      }
      fields.metadata[nested[1]] = scalar(
        nested[2] ?? "",
        `metadata.${nested[1]}`,
      )
      continue
    }
    const top = /^([A-Za-z0-9_-]+):(?: (.*))?$/.exec(line)
    if (!top) {
      throw new Error(
        `frontmatter line outside the YAML subset read here: ${line}`,
      )
    }
    current = top[1]
    if (current in fields) throw new Error(`key ${current} appears twice`)
    const raw = (top[2] ?? "").trim()
    fields[current] =
      current === "metadata" && raw === "" ? {} : scalar(raw, current)
  }
  return fields
}

/** Characters a plain YAML scalar may not start with. */
const INDICATORS = /^[-?:,[\]{}#&*!|>%@`]/

/** One value of the subset: plain, 'single'- or "double"-quoted. */
function scalar(raw, where) {
  const v = raw.trim()
  if (v.startsWith('"')) {
    const q = /^"((?:[^"\\]|\\["\\])*)"$/.exec(v)
    if (!q) {
      throw new Error(
        `${where}: a "double-quoted" value that is unterminated or uses an escape other than \\" and \\\\`,
      )
    }
    return q[1].replace(/\\(["\\])/g, "$1")
  }
  if (v.startsWith("'")) {
    const q = /^'((?:[^']|'')*)'$/.exec(v)
    if (!q) throw new Error(`${where}: an unterminated 'single-quoted' value`)
    return q[1].replaceAll("''", "'")
  }
  if (
    INDICATORS.test(v) ||
    v.includes(": ") ||
    v.endsWith(":") ||
    v.includes(" #") ||
    v.includes("\t")
  ) {
    throw new Error(
      `${where}: a plain value that YAML reads differently (it starts with an indicator or holds ": " or " #"); quote it`,
    )
  }
  return v
}

/**
 * The skill-relative paths a text names (references/, scripts/, assets/),
 * with or without "./" or "<this skill's folder>/" in front, nested or
 * not; never a repository path such as plugin/scripts/x.sh, and never a
 * pattern such as references/agent-<name>.md.
 */
export function skillPaths(text) {
  const found = []
  for (const [, path] of text.matchAll(
    /(?:^|[\s(\[`"'])(?:<this skill's folder>\/|\.\/)?((?:references|scripts|assets)(?:\/[A-Za-z0-9_.-]+)+)/gm,
  )) {
    // A sentence's full stop is not part of the path.
    const clean = path.replace(/\.+$/, "")
    const last = clean.split("/").at(-1)
    if (last.includes(".") && !found.includes(clean)) found.push(clean)
  }
  return found
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
  const lines = text.replace(/\r\n/g, "\n").split("\n").length
  if (lines > MAX_SKILL_LINES)
    problems.push(
      `SKILL.md has ${lines} lines; keep it under ${MAX_SKILL_LINES}`,
    )
  for (const path of skillPaths(text)) {
    if (!existsSync(join(dir, path)))
      problems.push(`SKILL.md names ${path}, which does not exist`)
  }
  return [...new Set(problems)]
}

/** Every file under `dir`, relative to it, SKILL.md excepted. */
function filesUnder(dir, prefix = "") {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = prefix ? `${prefix}/${name}` : name
    if (statSync(join(dir, name)).isDirectory()) {
      return filesUnder(join(dir, name), path)
    }
    return path === "SKILL.md" ? [] : [path]
  })
}

/**
 * What differs between the generated `files` and the skill folder `dir`:
 * a missing or stale file, any other file anywhere in the folder, and a
 * script that is not executable. Empty when they match.
 */
export function checkDisk(files, dir) {
  const problems = []
  for (const [path, text] of files) {
    const target = join(dir, path)
    if (!existsSync(target)) problems.push(`${path} is missing`)
    else {
      if (readFileSync(target, "utf8") !== text)
        problems.push(`${path} is stale`)
      if (path.endsWith(".sh") && (statSync(target).mode & 0o111) === 0) {
        problems.push(`${path} is not executable`)
      }
    }
  }
  for (const path of filesUnder(dir)) {
    if (!files.has(path)) {
      problems.push(
        `${path} is not generated from plugin/ (remove it or add a source)`,
      )
    }
  }
  return problems
}

function main() {
  const check = process.argv.includes("--check")
  const files = generate()
  const problems = []
  if (check) {
    problems.push(...checkDisk(files, SKILL_DIR))
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
