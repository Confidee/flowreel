// SPDX-License-Identifier: Apache-2.0

import { stageDeadlineAt } from "../core/deadline.js"
import { type Env, envValue } from "../core/env.js"
import { markPassive } from "../core/passive.js"

// The stage guard: what keeps one Playwright run (a pipeline stage, or a
// plain `playwright test`) stoppable the way Ctrl-C stops it. Playwright's
// runner stops gracefully on SIGINT only: the browser closes (so the
// running test's video and trace are saved), the global teardown signs the
// personas out and the reporter writes its summary. Anything else kills it
// on the spot. The guard turns the other ways a run is told to stop into
// that SIGINT:
//
//   SIGTERM (a CI's stop signal, `kill`) and, on Windows, Ctrl-Break;
//   the pipeline that started this stage disappearing (FLOWREEL_PIPELINE_PID
//     no longer exists: it was killed outright), checked every second;
//   a hangup, only when the pipeline runs in a terminal
//     (FLOWREEL_HUP=graceful; otherwise SIGHUP keeps its default, so
//     `nohup` still works);
//   on Windows, where the pipeline cannot signal a stage, the pipeline's
//     deadline (FLOWREEL_DEADLINE_AT).
//
// And it keeps a stage whose output pipe is gone (the pipeline died) from
// crashing on its next write: EPIPE / EIO on stdout and stderr are ignored.
//
// When no SIGINT listener is installed (before Playwright's runner starts,
// or after its teardown) the stop exits with 130, as a Ctrl-C would.
//
// Only the first stop request is turned into a SIGINT. Playwright cuts its
// teardown short on a second SIGINT a second or more after the first, and
// that would cost the sign-out: so once the run is stopping (the guard
// stopped it, or a SIGINT reached it from the terminal or the pipeline), a
// later SIGTERM, a vanished pipeline or a hangup is only logged. The guard
// sees a SIGINT through a listener it keeps only while another SIGINT
// listener exists, so it never changes what a Ctrl-C does on its own.

/** What the guard uses of the process (injectable for tests). */
export interface GuardProcess {
  readonly pid: number
  on(event: string, listener: (...args: unknown[]) => void): unknown
  off(event: string, listener: (...args: unknown[]) => void): unknown
  emit(event: string, ...args: unknown[]): boolean
  listenerCount(event: string): number
  exit(code: number): void
  kill(pid: number, signal?: string | number): unknown
  stdout: GuardStream
  stderr: GuardStream
}

interface GuardStream {
  on(event: "error", listener: (error: Error) => void): unknown
  off(event: "error", listener: (error: Error) => void): unknown
}

/** A timer handle (Node's, or a test's). */
interface TimerHandle {
  unref?(): unknown
}

/** Options and seams of {@link installStageGuard}. */
export interface StageGuardOptions {
  /** The log prefix, shown as "[<logPrefix>]" (default "flowreel"). */
  logPrefix?: string
  /** Default: process. */
  proc?: GuardProcess
  /** Default: process.platform. */
  platform?: NodeJS.Platform
  /** How often the pipeline's pid is checked (default 1000 ms). */
  pollMs?: number
  /** Default: Date.now. */
  now?: () => number
  /** Default: setInterval / clearInterval. */
  setInterval?: (fn: () => void, ms: number) => TimerHandle
  clearInterval?: (timer: TimerHandle) => void
  /** Default: setTimeout / clearTimeout. */
  setTimeout?: (fn: () => void, ms: number) => TimerHandle
  clearTimeout?: (timer: TimerHandle) => void
  /** Where the guard's own lines go (default console.error). */
  warn?: (line: string) => void
}

/** An installed guard. */
export interface StageGuard {
  /** The pipeline pid being watched, or null. */
  readonly pipelinePid: number | null
  /** Removes every listener and timer (for tests; a run never needs it). */
  uninstall(): void
}

/** Output errors that mean the reader is gone. */
const GONE = new Set(["EPIPE", "EIO", "ERR_STREAM_DESTROYED"])

/** setTimeout's longest delay. */
const MAX_TIMER_MS = 2_147_483_647

const KEY = Symbol.for("flowreel.stageGuard")

/** Installed guards, per process object (a global: one per process). */
function registry(): WeakMap<object, StageGuard> {
  const holder = globalThis as { [KEY]?: WeakMap<object, StageGuard> }
  holder[KEY] ??= new WeakMap()
  return holder[KEY]
}

/**
 * Installs the stage guard on this process (see the comment above):
 * SIGTERM (and Ctrl-Break on Windows) become a Ctrl-C, output to a closed
 * pipe is ignored, and, when the environment names one, a vanished pipeline
 * (FLOWREEL_PIPELINE_PID), a terminal hangup (FLOWREEL_HUP=graceful) and,
 * on Windows, the pipeline's deadline (FLOWREEL_DEADLINE_AT) stop the run
 * as a Ctrl-C would.
 *
 * Idempotent: a second call returns the guard already installed on the
 * process. The SummaryReporter installs it first thing in its constructor,
 * so the web server's start and the sign-ins are covered too. Never throws,
 * and never adds a SIGINT listener (that would stop Ctrl-C from ending a
 * run that has none).
 */
export function installStageGuard(
  env: Env = process.env,
  options: StageGuardOptions = {},
): StageGuard {
  const proc = options.proc ?? (process as unknown as GuardProcess)
  const installed = registry().get(proc)
  if (installed) return installed

  const prefix = `[${options.logPrefix ?? "flowreel"}]`
  const warn = options.warn ?? ((line: string) => console.error(line))
  const windows = (options.platform ?? process.platform) === "win32"
  const every = options.setInterval ?? setInterval
  const stopEvery =
    options.clearInterval ??
    ((timer: TimerHandle) =>
      clearInterval(timer as ReturnType<typeof setInterval>))
  const after = options.setTimeout ?? setTimeout
  const stopAfter =
    options.clearTimeout ??
    ((timer: TimerHandle) =>
      clearTimeout(timer as ReturnType<typeof setTimeout>))
  const now = options.now ?? Date.now

  const cleanups: (() => void)[] = []
  const listen = (event: string, listener: (...args: unknown[]) => void) => {
    proc.on(event, listener)
    cleanups.push(() => proc.off(event, listener))
  }

  // Whether the run is already stopping: a SIGINT reached it (seen by a
  // listener kept only beside another one) or the guard stopped it.
  let stopping = false
  let observing = false
  const observe = markPassive(() => {
    stopping = true
  })
  const startObserving = () => {
    if (observing) return
    observing = true
    proc.on("SIGINT", observe)
  }
  listen("newListener", (event, listener) => {
    if (event === "SIGINT" && listener !== observe) startObserving()
  })
  listen("removeListener", (event, listener) => {
    if (event !== "SIGINT" || listener === observe || !observing) return
    if (proc.listenerCount("SIGINT") <= 1) {
      observing = false
      proc.off("SIGINT", observe)
    }
  })
  if (proc.listenerCount("SIGINT") > 0) startObserving()
  cleanups.push(() => {
    observing = false
    proc.off("SIGINT", observe)
  })

  /** Stops the run as Ctrl-C would, once; `already` is said after that. */
  const stop = (already: string) => {
    if (stopping) {
      warn(`${prefix} ${already}`)
      return
    }
    stopping = true
    if (proc.listenerCount("SIGINT") > 0) proc.emit("SIGINT", "SIGINT")
    else proc.exit(130)
  }
  const onSignal = (signal: string) => () =>
    stop(
      `${signal} after the stop request: still finishing this run's report; a kill may follow.`,
    )

  // (a) SIGTERM and Ctrl-Break: a Ctrl-C.
  listen("SIGTERM", onSignal("SIGTERM"))
  if (windows) listen("SIGBREAK", onSignal("SIGBREAK"))

  // (b) A reader that is gone is not a crash.
  const ignoreGone = (error: Error) => {
    if (GONE.has((error as NodeJS.ErrnoException).code ?? "")) return
    throw error
  }
  for (const stream of [proc.stdout, proc.stderr]) {
    stream.on("error", ignoreGone)
    cleanups.push(() => stream.off("error", ignoreGone))
  }

  // (c) The pipeline that started this stage is gone.
  const raw = envValue(env, "PIPELINE_PID")
  const pid = raw && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : null
  const pipelinePid = pid !== null && pid > 0 && pid !== proc.pid ? pid : null
  if (pipelinePid !== null) {
    const timer = every(() => {
      try {
        proc.kill(pipelinePid, 0)
      } catch (error) {
        // EPERM: it exists, it is just not ours to signal.
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return
        stopEvery(timer)
        if (!stopping) {
          warn(
            `${prefix} the pipeline (pid ${pipelinePid}) is gone: stopping this run as Ctrl-C would.`,
          )
        }
        stop(
          `the pipeline (pid ${pipelinePid}) is gone; this run is already stopping.`,
        )
      }
    }, options.pollMs ?? 1000)
    timer.unref?.()
    cleanups.push(() => stopEvery(timer))
  }

  // (d) A terminal's hangup, only when the pipeline runs in one.
  if (envValue(env, "HUP") === "graceful") listen("SIGHUP", onSignal("SIGHUP"))

  // (e) Windows: the pipeline cannot signal this stage; its deadline can.
  // A deadline already past when the guard is installed is left alone (the
  // pipeline starts no stage after its deadline; a run started by hand gets
  // its normal report). One that arrives before Playwright's runner listens
  // for Ctrl-C waits until it does, so the run still writes its summary.
  const deadline = windows ? stageDeadlineAt(env) : null
  const left = deadline === null ? 0 : deadline - now()
  if (deadline !== null && left <= 0) {
    warn(
      `${prefix} the pipeline's deadline passed before this run started: it is not stopped for it.`,
    )
  } else if (deadline !== null && left <= MAX_TIMER_MS) {
    let timer: TimerHandle | null = null
    const fire = () => {
      if (!stopping && proc.listenerCount("SIGINT") === 0) {
        // Not listening yet: try again shortly.
        timer = after(fire, 250)
        timer.unref?.()
        return
      }
      if (!stopping) {
        warn(`${prefix} deadline reached: stopping this run as Ctrl-C would.`)
      }
      stop("deadline reached; this run is already stopping.")
    }
    timer = after(fire, left)
    timer.unref?.()
    cleanups.push(() => {
      if (timer) stopAfter(timer)
    })
  }

  const guard: StageGuard = {
    pipelinePid,
    uninstall: () => {
      for (const cleanup of cleanups.splice(0)) cleanup()
      registry().delete(proc)
    },
  }
  registry().set(proc, guard)
  return guard
}
