// SPDX-License-Identifier: Apache-2.0

import { relative } from "node:path"

// `demos <RUN_ID>`: publishes a demo-pace run's videos into the project's
// demos folder (`latest/`) under their fixed names and rewrites its README.
// The project's demo catalogue does the publishing; this is the command
// around it: argument check, the one-line outcome and the exit code
// (0 published, 1 nothing published, 64 usage).

export type DemosPublishOutcome =
  | { published: true; files: string[]; dir: string }
  | { published: false; reason: string }

export interface DemosCliOptions {
  /** A RUN_ID argument, validated; null when it is not one. */
  parseRunIdArg(raw: string | undefined): string | null
  /** Publishes one run's videos. */
  publish(runId: string): DemosPublishOutcome
  /** Paths in the outcome line are shown relative to this. */
  rootDir: string
  /** The usage line printed on a bad invocation. */
  usage: string
  /** Default console.log / console.error. */
  log?: (line: string) => void
  error?: (line: string) => void
}

/** Runs the command; returns the exit code (never calls process.exit). */
export function demosCli(argv: string[], options: DemosCliOptions): number {
  const log = options.log ?? ((line: string) => console.log(line))
  const error = options.error ?? ((line: string) => console.error(line))
  const runId = options.parseRunIdArg(argv[0])
  if (!runId || argv.length !== 1) {
    error(options.usage)
    return 64
  }
  const outcome = options.publish(runId)
  if (!outcome.published) {
    error(`[demos] ${runId}: nothing published (${outcome.reason})`)
    return 1
  }
  log(
    `[demos] ${runId}: ${outcome.files.join(", ")} -> ${relative(options.rootDir, outcome.dir)}/ (README.md updated)`,
  )
  return 0
}
