// SPDX-License-Identifier: Apache-2.0
import { readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { expect, test } from "@playwright/test"

import {
  ALLOWED_FIELDS,
  SKILL_DIR,
  generate,
  portable,
  validate,
} from "../../scripts/sync-agent-skill.mjs"

// The portable Agent Skill (skills/flowreel/): its SKILL.md follows the
// Agent Skills specification (agentskills.io), and its references/ and
// scripts/ are exactly what scripts/sync-agent-skill.mjs generates from
// the plugin, so the two never drift.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const SKILL = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8")

/** A SKILL.md with these frontmatter lines and a short body. */
const skillMd = (...lines: string[]) =>
  ["---", ...lines, "---", "", "# x", ""].join("\n")
const ok = ["name: flowreel", "description: Does a thing. Use when asked."]

test.describe("the portable skill", () => {
  test("SKILL.md follows the specification", () => {
    expect(validate(SKILL_DIR)).toEqual([])
  })

  test("references/ and scripts/ are exactly what the plugin generates", () => {
    const generated = generate()
    for (const [path, text] of generated) {
      expect(readFileSync(join(SKILL_DIR, path), "utf8"), path).toBe(text)
    }
    const onDisk = ["references", "scripts"].flatMap((sub) =>
      readdirSync(join(SKILL_DIR, sub)).map((file) => `${sub}/${file}`),
    )
    expect(onDisk.sort()).toEqual([...generated.keys()].sort())
  })

  test("nothing Claude Code specific is left in the generated files", () => {
    for (const [path, text] of generate()) {
      if (path.endsWith(".sh")) continue
      expect(text, path).not.toContain("CLAUDE_PLUGIN_ROOT")
      expect(text, path).not.toContain("$ARGUMENTS")
      expect(text, path).not.toMatch(/\]\(reference\//)
    }
  })

  test("every skill-relative path a generated file names exists", () => {
    for (const [path, text] of generate()) {
      for (const [, named] of text.matchAll(
        /(?<![\w/])((?:references|scripts)\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+)/g,
      )) {
        expect(
          statSync(join(SKILL_DIR, named), { throwIfNoEntry: false }),
          `${path} names ${named}`,
        ).toBeTruthy()
      }
    }
  })

  test("the prerequisite check is the plugin's own, and executable", () => {
    const copy = join(SKILL_DIR, "scripts", "check-prereqs.sh")
    expect(readFileSync(copy, "utf8")).toBe(
      readFileSync(join(ROOT, "plugin/scripts/check-prereqs.sh"), "utf8"),
    )
    expect(statSync(copy).mode & 0o111).not.toBe(0)
  })

  test("every plugin workflow has a generated counterpart", () => {
    for (const skill of readdirSync(join(ROOT, "plugin/skills"))) {
      expect(generate().has(`references/${skill}.md`), skill).toBe(true)
    }
  })
})

test.describe("the specification checks", () => {
  const dir = join("/x", "flowreel")

  test("a conforming SKILL.md passes, with every optional field", () => {
    expect(validate(dir, skillMd(...ok))).toEqual([])
    expect(
      validate(
        dir,
        skillMd(
          ...ok,
          "license: Apache-2.0",
          "compatibility: Needs Node.js",
          "metadata:",
          "  author: Example Org",
          '  version: "1.0"',
          "allowed-tools: Read Bash(git:*)",
        ),
      ),
    ).toEqual([])
    expect([...ALLOWED_FIELDS].sort()).toEqual([
      "allowed-tools",
      "compatibility",
      "description",
      "license",
      "metadata",
      "name",
    ])
  })

  test("Claude Code's own fields are refused, as skills-ref refuses them", () => {
    expect(
      validate(
        dir,
        skillMd(...ok, "argument-hint: x", "disable-model-invocation: true"),
      ),
    ).toEqual([
      "fields the specification does not allow: argument-hint, disable-model-invocation",
    ])
  })

  for (const [name, why] of [
    ["Flowreel", "uppercase"],
    ["-flowreel", "a leading hyphen"],
    ["flowreel-", "a trailing hyphen"],
    ["flow--reel", "consecutive hyphens"],
    ["flow_reel", "an underscore"],
  ]) {
    test(`a name with ${why} is refused`, () => {
      expect(
        validate(join("/x", name), skillMd(`name: ${name}`, ok[1])).join(),
      ).toContain("may only hold")
    })
  }

  test("name: required, at most 64 characters, equal to its directory", () => {
    expect(validate(dir, skillMd(ok[1]))).toContain("name is required")
    const long = "a".repeat(65)
    expect(
      validate(join("/x", long), skillMd(`name: ${long}`, ok[1])),
    ).toContain("name is longer than 64 characters")
    expect(validate(join("/x", "other"), skillMd(...ok))).toContain(
      'name "flowreel" must match its directory "other"',
    )
  })

  test("description: required, at most 1024 characters", () => {
    expect(validate(dir, skillMd(ok[0]))).toContain("description is required")
    expect(
      validate(dir, skillMd(ok[0], `description: ${"d".repeat(1025)}`)),
    ).toContain("description is longer than 1024 characters")
    expect(
      validate(dir, skillMd(ok[0], `description: ${"d".repeat(1024)}`)),
    ).toEqual([])
  })

  test("compatibility: 1 to 500 characters", () => {
    expect(
      validate(dir, skillMd(...ok, `compatibility: ${"c".repeat(501)}`)),
    ).toContain("compatibility must be 1 to 500 characters")
    expect(validate(dir, skillMd(...ok, "compatibility: "))).toContain(
      "compatibility must be 1 to 500 characters",
    )
  })

  test("metadata must be a map", () => {
    expect(validate(dir, skillMd(...ok, "metadata: flat"))).toContain(
      "metadata must be a map of strings",
    )
  })

  test("no frontmatter, an unreadable line, over 500 lines, a missing file", () => {
    expect(validate(dir, "# no frontmatter\n")).toEqual([
      "SKILL.md must start with a YAML frontmatter block",
    ])
    expect(validate(dir, skillMd(...ok, "- a list item"))[0]).toContain(
      "unreadable frontmatter line",
    )
    expect(
      validate(dir, skillMd(...ok) + "line\n".repeat(500)).join(),
    ).toContain("keep it under 500")
    expect(
      validate(dir, skillMd(...ok) + "See references/missing.md.\n"),
    ).toContain("SKILL.md names references/missing.md, which does not exist")
  })
})

test.describe("the portable rewrite", () => {
  test("plugin paths become skill-relative; arguments become prose", () => {
    expect(
      portable(
        [
          'bash "${CLAUDE_PLUGIN_ROOT}/scripts/check-prereqs.sh" --report',
          "${CLAUDE_PLUGIN_ROOT}/reference/never.md",
          "${CLAUDE_PLUGIN_ROOT}/skills/init/reference/scaffold.md",
          "[reference/scaffold.md](reference/scaffold.md) and `reference/x.md`",
          "Arguments: `$ARGUMENTS` ($ARGUMENTS)",
          "from `${CLAUDE_PLUGIN_ROOT}/templates/`",
        ].join("\n"),
        "t",
      ).split("\n"),
    ).toEqual([
      "bash scripts/check-prereqs.sh --report",
      "references/never.md",
      "references/scaffold.md",
      "[references/scaffold.md](references/scaffold.md) and `references/x.md`",
      "Arguments: the user's arguments (the user's arguments)",
      'from the templates (SKILL.md, "Templates", says where they come from)',
    ])
  })

  test("an unknown plugin path is refused, not passed through", () => {
    expect(() => portable("${CLAUDE_PLUGIN_ROOT}/hooks/x", "src.md")).toThrow(
      "src.md: a ${CLAUDE_PLUGIN_ROOT} path has no portable form",
    )
  })

  test("the plugin's own skills are not portable as they stand", () => {
    // Why the portable skill is separate: their Claude Code fields
    // (argument-hint, disable-model-invocation) drive the plugin's
    // /flowreel:* commands, and the specification refuses them.
    for (const skill of readdirSync(join(ROOT, "plugin/skills"))) {
      const problems = validate(join(ROOT, "plugin/skills", skill))
      expect(problems.join(), skill).toContain(
        "fields the specification does not allow: argument-hint",
      )
    }
  })
})

test("SKILL.md says where the templates come from, pinned to the runtime version", () => {
  expect(SKILL).toContain(
    "git clone --depth 1 --branch v<version> https://github.com/Confidee/flowreel.git",
  )
})
