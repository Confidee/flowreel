// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process"

// DbIsolation: a fresh database per development run, so a run never shares
// (or pollutes) the database other test suites use. flowreel creates one
// before the development stage, points the stage's server at it through the
// env create() returns, and drops it afterwards (unless the operator asked
// to keep it).

/**
 * A fresh database per development run, implemented by the project (often
 * over its own clone script with {@link commandDbIsolation}) and passed as
 * PipelineSpec.db.isolation for the modules that need it.
 *
 * The pipeline runner calls create(key) once before the development stage
 * and passes the env it returns to that stage only (stageEnv's `extra`),
 * then drop(key) after the stage (or on a second Ctrl-C) unless the
 * operator passed --keep-db, in which case it prints how to drop the copy
 * by hand. create throws when no database could be made: the development
 * stage is then not run and is recorded FAIL with that message. drop never
 * throws; it returns false when the copy could not be dropped. The runner
 * retries neither.
 */
export interface DbIsolation {
  /** Creates the copy named by `key`; returns the env that selects it. Throws on failure. */
  create(key: string): Record<string, string>
  /** Drops it; true when dropped. Never throws. */
  drop(key: string): boolean
}

/** "<prefix>" + 6 hex: a database copy key. */
export function cloneKey(
  prefix: string,
  random: () => number = Math.random,
): string {
  return `${prefix}${Math.floor(random() * 0x1000000)
    .toString(16)
    .padStart(6, "0")}`
}

/** Blocks the process for `ms` (a drop also runs from a SIGINT handler). */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** How {@link commandDbIsolation} runs the project's clone script. */
export interface CommandDbIsolationOptions {
  /** The executable: `<command> <key>` creates, `<command> <key> drop` drops. */
  command: string
  cwd: string
  /** The env from the create command's stdout; throws when it has none. */
  parse(stdout: string): Record<string, string>
  /**
   * Waits before each drop attempt (ms): the server the stage started may
   * still hold connections when the child exits. Default [0, 3000, 10000].
   */
  dropWaits?: readonly number[]
  log?: (line: string) => void
  /** Injectable for tests. */
  run?: (args: string[]) => {
    status: number | null
    stdout: string
    stderr: string
    error?: Error
  }
  sleep?: (ms: number) => void
}

/** A DbIsolation over a project script (create prints `export NAME=value` lines, say). */
export function commandDbIsolation(
  options: CommandDbIsolationOptions,
): DbIsolation {
  const run =
    options.run ??
    ((args: string[]) => {
      const result = spawnSync(options.command, args, {
        cwd: options.cwd,
        encoding: "utf8",
      })
      return {
        status: result.status,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        error: result.error,
      }
    })
  const log = options.log ?? ((line) => console.log(line))
  const sleep = options.sleep ?? sleepSync
  return {
    create(key) {
      const result = run([key])
      if (result.status !== 0) {
        throw new Error(
          `${options.command} ${key} failed: ${(result.stderr ? result.stderr : (result.error?.message ?? "")).trim().split("\n").slice(-2).join(" ")}`,
        )
      }
      return options.parse(result.stdout)
    },
    drop(key) {
      const waits = options.dropWaits ?? [0, 3_000, 10_000]
      for (const [i, wait] of waits.entries()) {
        if (wait) sleep(wait)
        if (run([key, "drop"]).status === 0) {
          log(`dropped the development DB clone ${key}`)
          return true
        }
        if (i < waits.length - 1) {
          log(`the DB clone ${key} is still in use; retrying the drop`)
        }
      }
      log(
        `WARNING: could not drop the DB clone ${key} (run: ${options.command} ${key} drop)`,
      )
      return false
    },
  }
}
