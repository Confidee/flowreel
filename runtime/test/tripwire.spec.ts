// SPDX-License-Identifier: Apache-2.0

import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { expect, test } from "@playwright/test"

import {
  BUILT_IN,
  PatternsError,
  activePatterns,
  checkLeaks,
  projectPatterns,
  scannedFiles,
  violations,
} from "../../scripts/check-leaks.mjs"

// The brand-neutral tripwire (docs/design/architecture.md, principle 3):
// nothing in this repository may carry the specifics of a project that uses
// flowreel. The engine and the allowlist live in scripts/check-leaks.mjs at
// the repository root (which `npm test` also runs on its own). The only
// published pattern is the publisher's name; a project supplies its own
// patterns at run time, so every sample below is synthetic. Also: every
// runtime source file carries the SPDX license header.

const here = dirname(fileURLToPath(import.meta.url))
const RUNTIME_SRC = resolve(here, "../src")

// Synthetic project patterns, shaped like the ones a project supplies.
const SAMPLE_PATTERNS = projectPatterns({
  FLOWREEL_LEAK_PATTERNS: JSON.stringify([
    { pattern: "\\bwidgetry\\b", flags: "i", note: "a module name" },
    "\\bWG-\\d",
    { pattern: "#(?:a1b2c3|0d0e0f)\\b", flags: "i" },
    "ACME_QA_",
    { pattern: "staging\\.app\\.example-product\\.test", flags: "i" },
  ]),
})
const SAMPLE = [...BUILT_IN, ...SAMPLE_PATTERNS]

function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...tsFiles(path))
    else if (path.endsWith(".ts")) out.push(path)
  }
  return out
}

test("the tripwire catches what it is meant to catch", () => {
  const sample = [
    "const host = 'staging.app.example-product.test'",
    "// see Widgetry",
    "subject: '[WG-12] x'",
    "color: #A1B2C3;",
    "env.ACME_QA_VIDEO",
    "made by CONFIDEE",
    "ok line: widgetryish, WG-x, #a1b2c3d, ACME_QB_",
  ].join("\n")
  expect(violations("x.ts", sample, SAMPLE)).toEqual([
    "x.ts:1: a project pattern (#5)",
    "x.ts:2: a project pattern (#1)",
    "x.ts:3: a project pattern (#2)",
    "x.ts:4: a project pattern (#3)",
    "x.ts:5: a project pattern (#4)",
    "x.ts:6: the publisher's name",
  ])
  // Without project patterns only the publisher's name is checked.
  expect(violations("x.ts", sample)).toEqual(["x.ts:6: the publisher's name"])
})

test("project patterns come from the environment, and a bad source fails loudly", () => {
  expect(projectPatterns({})).toEqual([])
  expect(
    projectPatterns({
      FLOWREEL_LEAK_PATTERNS: " ",
      FLOWREEL_LEAK_PATTERNS_FILE: "",
    }),
  ).toEqual([])

  const dir = mkdtempSync(join(tmpdir(), "flowreel-leaks-"))
  try {
    const file = join(dir, "patterns.json")
    writeFileSync(file, JSON.stringify([{ pattern: "widgetry", flags: "i" }]))
    const both = activePatterns({
      FLOWREEL_LEAK_PATTERNS: JSON.stringify(["ACME_QA_"]),
      FLOWREEL_LEAK_PATTERNS_FILE: file,
    })
    expect(both.map((p) => p.name)).toEqual([
      "the publisher's name",
      "a project pattern (#1)",
      "a project pattern (#2)",
    ])
    expect(both[2]!.pattern.test("WIDGETRY")).toBe(true)

    for (const [env, message] of [
      [
        { FLOWREEL_LEAK_PATTERNS_FILE: join(dir, "missing.json") },
        /cannot be read/,
      ],
      [{ FLOWREEL_LEAK_PATTERNS: "{nope" }, /not valid JSON/],
      [{ FLOWREEL_LEAK_PATTERNS: '{"pattern":"x"}' }, /must be a JSON array/],
      [{ FLOWREEL_LEAK_PATTERNS: "[{}]" }, /entry 1 has no pattern/],
      [
        { FLOWREEL_LEAK_PATTERNS: '[{"pattern":"x","flags":"g"}]' },
        /flags must be/,
      ],
      [
        { FLOWREEL_LEAK_PATTERNS: '["(unclosed"]' },
        /not a valid regular expression/,
      ],
    ] as const) {
      expect(() => projectPatterns(env)).toThrow(PatternsError)
      expect(() => projectPatterns(env)).toThrow(message)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a hit names the pattern's number, never the pattern or the matched text", () => {
  const [hit] = violations("docs/x.md", "uses widgetry", SAMPLE)
  expect(hit).toBe("docs/x.md:1: a project pattern (#1)")
  expect(hit).not.toContain("widgetry")
})

test('the README\'s "Who uses it" section may name the publisher, nothing else', () => {
  const readme = [
    "# flowreel",
    "Built for Confidee.",
    "## Who uses it",
    "Extracted from Confidee.",
    "It gates the Widgetry module.",
    "## License",
    "Confidee again.",
  ].join("\n")
  expect(violations("README.md", readme, SAMPLE)).toEqual([
    "README.md:2: the publisher's name",
    "README.md:5: a project pattern (#1)",
    "README.md:7: the publisher's name",
  ])
  // The same section anywhere else is not allowlisted.
  expect(violations("docs/x.md", "## Who uses it\nConfidee.")).toEqual([
    "docs/x.md:2: the publisher's name",
  ])
})

test("the tripwire's own files are scanned: the publisher's name only is allowed", () => {
  for (const self of [
    "scripts/check-leaks.mjs",
    "runtime/test/tripwire.spec.ts",
  ]) {
    expect(violations(self, "Confidee and confidee", SAMPLE)).toEqual([])
    expect(violations(self, "see widgetry", SAMPLE)).toEqual([
      `${self}:1: a project pattern (#1)`,
    ])
  }
  expect(violations("scripts/check-leaks.d.mts", "Confidee")).toEqual([
    "scripts/check-leaks.d.mts:1: the publisher's name",
  ])
})

test("the publisher's demo names the publisher, in those two files only", () => {
  for (const demo of ["assets/demo/README.md", "assets/demo/run/summary.md"]) {
    expect(violations(demo, "# Confidee demo app: PASS", SAMPLE)).toEqual([])
    expect(violations(demo, "see widgetry", SAMPLE)).toEqual([
      `${demo}:1: a project pattern (#1)`,
    ])
  }
  expect(violations("assets/demo/other.md", "Confidee demo app")).toEqual([
    "assets/demo/other.md:1: the publisher's name",
  ])
})

test("the whole repository is scanned and brand-neutral", () => {
  const files = scannedFiles()
  expect(files.length).toBeGreaterThan(100)
  for (const must of [
    "runtime/package.json",
    "runtime/README.md",
    "runtime/LICENSE",
    "runtime/NOTICE",
    "runtime/test/tripwire.spec.ts",
    "scripts/check-leaks.mjs",
    "scripts/check-leaks.d.mts",
    "plugin/.claude-plugin/plugin.json",
    ".claude-plugin/marketplace.json",
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
    "docs/README.md",
    "docs/design/architecture.md",
    "docs/design/decisions.md",
    "examples/minimal/README.md",
    "README.md",
    "RELEASING.md",
    "CHANGELOG.md",
    "SECURITY.md",
    "CODE_OF_CONDUCT.md",
  ]) {
    expect(files).toContain(must)
  }
  expect(
    files.filter((file) => /(^|\/)(node_modules|dist|\.git)\//.test(file)),
  ).toEqual([])
  // With the project patterns from the environment, when they are supplied.
  expect(checkLeaks().hits).toEqual([])
})

test("every runtime source file starts with the SPDX license header", () => {
  const missing = tsFiles(RUNTIME_SRC)
    .filter((path) => path.endsWith(".ts"))
    .filter(
      (path) =>
        !readFileSync(path, "utf8").startsWith(
          "// SPDX-License-Identifier: Apache-2.0\n",
        ),
    )
    .map((path) => relative(RUNTIME_SRC, path))
  expect(missing).toEqual([])
})

test("the publisher's identity is allowed, and nothing around it", () => {
  // The npm scope is allowed in every scanned file.
  expect(violations("docs/x.md", "npm i -D @confidee/flowreel")).toEqual([])
  // The copyright holder only in the files that state copyright.
  expect(violations("NOTICE", "Copyright 2026 Confidee GmbH")).toEqual([])
  expect(violations("docs/x.md", "Copyright 2026 Confidee GmbH")).toEqual([
    "docs/x.md:1: the publisher's name",
  ])
  // A line that also names something else is still caught.
  expect(
    violations("docs/x.md", "@confidee/flowreel, made by CONFIDEE"),
  ).toEqual(["docs/x.md:1: the publisher's name"])
  expect(
    violations(
      "docs/x.md",
      "@confidee/flowreel on staging.app.example-product.test",
      SAMPLE,
    ),
  ).toEqual(["docs/x.md:1: a project pattern (#5)"])
  expect(
    violations("NOTICE", "Confidee GmbH, see Confidee/other-repo"),
  ).toEqual(["NOTICE:1: the publisher's name"])
})

test("the repository slug is allowed anywhere, exactly", () => {
  expect(
    violations(
      "docs/x.md",
      "/plugin marketplace add Confidee/flowreel and https://github.com/Confidee/flowreel/issues",
    ),
  ).toEqual([])
  // Another repository of the same organization is not the slug.
  expect(
    violations("docs/x.md", "https://github.com/Confidee/flowreel-internal"),
  ).toEqual(["docs/x.md:1: the publisher's name"])
  expect(violations("docs/x.md", "npm i @confidee/flowreel-extra")).toEqual([
    "docs/x.md:1: the publisher's name",
  ])
  expect(violations("docs/x.md", "github.com/Confidee/other")).toEqual([
    "docs/x.md:1: the publisher's name",
  ])
})

test("the contact address is allowed only in SECURITY.md and CODE_OF_CONDUCT.md", () => {
  expect(violations("SECURITY.md", "Email support@confidee.com.")).toEqual([])
  expect(
    violations("CODE_OF_CONDUCT.md", "Email support@confidee.com."),
  ).toEqual([])
  expect(violations("README.md", "Email support@confidee.com.")).toEqual([
    "README.md:1: the publisher's name",
  ])
  expect(
    violations("SECURITY.md", "Email not-the-contact@confidee.com."),
  ).toEqual(["SECURITY.md:1: the publisher's name"])
})
