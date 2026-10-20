// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module"
import { join, relative } from "node:path"

// The child command of a stage: one `playwright test` run of the module's
// projects, never with retries (a re-sent mail duplicates records, a re-run
// sign-in feeds the target's lockout counter). It runs Playwright's own
// command-line entry with the current Node (no npx in between: npx outlives
// a stopped pipeline, adds a signal hop, and cannot be spawned without a
// shell on Windows); npx is the fallback when the entry cannot be resolved.

/**
 * Playwright's arguments for one stage: `test` with the given config and
 * projects, headed when asked. Never adds retries.
 */
export function stageCommand(
  config: string,
  projects: readonly string[],
  headed: boolean,
): string[] {
  return [
    "test",
    `--config=${config}`,
    ...projects.map((project) => `--project=${project}`),
    ...(headed ? ["--headed"] : []),
  ]
}

/** How a stage's Playwright is started: the command and its leading arguments. */
export interface StageLauncher {
  command: string
  /** Put before stageCommand's arguments. */
  args: string[]
  /** For the log: what runs the stage. */
  description: string
  /** Set when the stage cannot be started at all: why (it then fails). */
  problem?: string
}

/** `@playwright/test/cli` as the project at `cwd` resolves it, or null. */
export function resolvePlaywrightCli(cwd: string): string | null {
  try {
    return createRequire(join(cwd, "package.json")).resolve(
      "@playwright/test/cli",
    )
  } catch {
    return null
  }
}

/**
 * How to start Playwright for a project at `cwd`: the current Node
 * (`execPath`) with the project's own `@playwright/test/cli`, or, when that
 * cannot be resolved, `npx --no-install playwright` (which never installs
 * anything). The npx fallback is POSIX only: on Windows npx is a `.cmd`
 * file that needs a shell, which flowreel never uses for arguments, so the
 * launcher says what is missing instead (`problem`). Never throws.
 */
export function playwrightLauncher(
  cwd: string,
  execPath: string = process.execPath,
  resolveCli: (cwd: string) => string | null = resolvePlaywrightCli,
  platform: NodeJS.Platform = process.platform,
): StageLauncher {
  const cli = resolveCli(cwd)
  if (cli) {
    return {
      command: execPath,
      args: [cli],
      description: `node ${relative(cwd, cli) || cli}`,
    }
  }
  if (platform === "win32") {
    return {
      command: "npx",
      args: [],
      description:
        "none (@playwright/test/cli could not be resolved from the project)",
      problem:
        "@playwright/test/cli could not be resolved from the project; install @playwright/test there (on Windows flowreel does not fall back to npx)",
    }
  }
  return {
    command: "npx",
    args: ["--no-install", "playwright"],
    description:
      "npx --no-install playwright (@playwright/test/cli could not be resolved from the project)",
  }
}
