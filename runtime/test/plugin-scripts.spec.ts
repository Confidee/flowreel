// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { expect, test } from "@playwright/test"

// The plugin's shell scripts run on the user's machine (the SessionStart
// hook, /flowreel:doctor). #29: a quote inside a single-quoted printf made
// check-prereqs.sh a syntax error in 0.4.0, exit 2 in both modes, and no
// test ran it. These parse every script and run the prerequisite check for
// real, under the shell on PATH and macOS's system bash 3.2 when present.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const CHECK = join(ROOT, "plugin/scripts/check-prereqs.sh")

/** Every *.sh under plugin/, recursively. */
function shellScripts(dir = join(ROOT, "plugin")): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return shellScripts(path)
    return name.endsWith(".sh") ? [path] : []
  })
}

/** The bash on PATH, and macOS's /bin/bash (3.2) when it exists. */
const SHELLS = ["bash", ...(existsSync("/bin/bash") ? ["/bin/bash"] : [])]

test("every plugin shell script parses (bash -n)", () => {
  const scripts = shellScripts()
  expect(scripts.length).toBeGreaterThanOrEqual(2)
  for (const shell of SHELLS) {
    for (const script of scripts) {
      const run = spawnSync(shell, ["-n", script], { encoding: "utf8" })
      expect(run.stderr, `${shell} -n ${script}`).toBe("")
      expect(run.status, `${shell} -n ${script}`).toBe(0)
    }
  }
})

test.describe("check-prereqs.sh runs to the end and exits 0", () => {
  test.setTimeout(60_000)
  let project: string

  test.beforeAll(() => {
    // A flowreel project whose adapter predates 0.4.0: report mode prints
    // the `advice` line, the one #29 broke.
    project = mkdtempSync(join(tmpdir(), "flowreel-prereqs-"))
    mkdirSync(join(project, "e2e", "flowreel"), { recursive: true })
    writeFileSync(
      join(project, "e2e", "flowreel", "adapter.ts"),
      "const context = await api.newContext({ baseURL })\n",
    )
    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({ type: "module" }),
    )
  })
  test.afterAll(() => {
    rmSync(project, { recursive: true, force: true })
  })

  const run = (shell: string, args: string[]) =>
    spawnSync(shell, [CHECK, ...args], {
      encoding: "utf8",
      cwd: project,
      // FLOWREEL_PREREQS=off would silence session mode: never inherit it.
      env: {
        ...process.env,
        FLOWREEL_PREREQS: undefined,
        CLAUDE_PROJECT_DIR: project,
      },
      timeout: 50_000,
    })

  for (const shell of SHELLS) {
    test(`--report under ${shell}: the advice line and the summary line`, () => {
      const out = run(shell, ["--report"])
      expect(out.stderr).not.toContain("syntax error")
      expect(out.status).toBe(0)
      const lines = out.stdout.trimEnd().split("\n")
      // Whole, not garbled: a quote pair inside a single-quoted string
      // parses but drops text, which bash -n cannot see.
      const advice = lines.find((l) => l.startsWith("flowreel: advice "))
      expect(advice).toContain(
        "so its requests rely on the Playwright default and its errors may pass a call log on.",
      )
      expect(advice).toMatch(/this never affects a verdict\.$/)
      expect(lines.at(-1)).toMatch(/^flowreel: \d of 3 required items missing/)
    })

    test(`session mode under ${shell}: runs to its last line, exit 0`, () => {
      const out = run(shell, [])
      expect(out.stderr).not.toContain("syntax error")
      expect(out.status).toBe(0)
      // The project has no node_modules, so @playwright/test is always
      // missing: session mode must reach its closing pointer to the doctor.
      const lines = out.stdout.trimEnd().split("\n")
      expect(
        lines.some((l) => /^flowreel: missing {4}@playwright\/test /.test(l)),
      ).toBe(true)
      expect(lines.at(-1)).toMatch(
        /^flowreel: \/flowreel:doctor explains each item/,
      )
    })
  }
})
