// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawn } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join, relative } from "node:path"

import type { TargetName } from "../config/targets.js"
import { composeBudgetMs, composeSkipReason } from "../core/deadline.js"
import { type Env, envNames, envVar } from "../core/env.js"
import { withMediaSignal } from "../video/stop.js"
import {
  UNDO_JSON,
  type UndoEntry,
  type UndoSummary,
  fileUndoStore,
  summarizeUndo,
} from "../core/undo.js"

import {
  type StageLauncher,
  playwrightLauncher,
  stageCommand,
} from "./command.js"
import { type DbIsolation, cloneKey } from "./db.js"
import {
  ABORTED_REASON,
  EXIT,
  type PipelineVerdict,
  STAGES,
  STOP_REASONS,
  type StageName,
  type StageResult,
  type StopCause,
  developmentDecision,
  pipelineOutcome,
  stageLabel,
  stageVerdictFrom,
  stagingDecision,
} from "./decisions.js"
import { type StageEnvSpec, preferredEnvName, stageEnv } from "./env.js"
import {
  type PipelineArgsSpec,
  type PipelineOptions,
  UsageError,
  deadlineAt,
  parseDeadline,
  parsePipelineArgs,
} from "./options.js"

// The development -> staging pipeline, run on the operator's machine (or CI):
// stage 1 "development" (a local test server, test seams), stage 2
// "staging" ONLY after a development PASS. Each stage is its own
// `playwright test` child with its own RUN_ID and a clean env (only
// staging gets the secrets), its output streamed with a [development] /
// [staging] prefix, and never retried. A module may ask for a fresh
// database per development run (DbIsolation), dropped afterwards unless
// --keep-db. The decisions are the pure functions in decisions.ts; this
// file runs them and writes <results>/<PIPELINE_ID>/pipeline.{md,json}
// plus, through the project's report hooks, the combined video (which
// never changes the verdict). pipeline.json is written ahead (status
// "running") and rewritten as the run goes, so a pipeline that is killed
// still leaves one.
//
// Stopping. The first stop request (Ctrl-C, a CI's SIGTERM, Ctrl-Break on
// Windows, or the --deadline) asks the running stage to stop the way a
// first Ctrl-C stops Playwright (on POSIX the pipeline sends it SIGINT, the
// one signal Playwright's runner stops gracefully on; on Windows the
// console's Ctrl-C already reached it): the browser closes, so the test's
// video and trace are saved, the personas are signed out, and the stage
// writes its summary. No further stage starts and no combined video is
// made. The same signal again within 200 ms is a duplicate (a terminal and
// npm both deliver it). Only a second Ctrl-C (SIGINT or SIGBREAK) at least
// 200 ms after the first stop forces: the final pipeline files are written,
// the stage gets 3 s to close and is then killed, the database copy is
// dropped and the pipeline exits 130. A SIGTERM after the first stop never
// forces (a CI sends SIGINT then SIGTERM, and the stage's report is worth
// the wait); the CI's own kill may follow.

export interface StageInfo {
  title: string
  detail: string
  target: TargetName
}

/** The parts of a stage's summary.json the pipeline reads. */
export interface StageSummaryShape {
  verdict?: unknown
  verdictReason?: unknown
  undo?: { manual?: unknown; total?: unknown }
  video?: unknown
}

/**
 * The run's own write-ahead undo ledger (<dir>/undo.json), or null when the
 * run changed no shared configuration. Read independently of summary.json:
 * a child that died before its reporter ran leaves only this.
 *
 * A ledger that exists but cannot be read fails closed: it reads as one
 * change needing manual action (exit 4), never as "nothing to restore".
 */
export function readUndoLedger(dir: string, runId: string): UndoSummary | null {
  const path = join(dir, UNDO_JSON)
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { entries?: unknown }
    if (!Array.isArray(raw?.entries)) throw new Error("no entries list")
    return summarizeUndo(fileUndoStore(dir, runId).read())
  } catch (error) {
    const entry: UndoEntry = {
      id: "unreadable-ledger",
      seq: 0,
      feature: "(undo ledger)",
      what: `${UNDO_JSON} could not be read`,
      before: null,
      manual: `Open ${path} and the run's undo.md, and check every change they list by hand.`,
      status: "FAILED",
      error: (error instanceof Error ? error.message : String(error)).split(
        "\n",
      )[0],
      recordedAt: new Date().toISOString(),
      restoredAt: null,
    }
    return { total: 1, restored: 0, failed: 1, pending: 0, manual: [entry] }
  }
}

export interface StageRecord<S = StageSummaryShape> extends StageInfo {
  stage: StageName
  result: StageResult
  runId: string | null
  dir: string | null
  summary: S | null
  /** The run's undo ledger, read on its own (a dead run leaves only this). */
  ledger: UndoSummary | null
  startedAt: string | null
  durationMs: number | null
  exitCode: number | null
}

/** What the report hooks get: the whole pipeline run. */
export interface PipelineRequest<
  M extends string = string,
  S = StageSummaryShape,
> {
  module: M
  pipelineId: string
  dir: string
  startedAt: Date
  verdict: PipelineVerdict
  reason: string
  stages: StageRecord<S>[]
}

export type NarrationSummary =
  | { produced: true; [key: string]: unknown }
  | { produced: false; reason: string; [key: string]: unknown }

export type ComposedVideo =
  | {
      produced: true
      path: string
      durationSec: number
      narration?: NarrationSummary
    }
  | { produced: false; reason: string; narration?: NarrationSummary }

export type PipelineVideoSummary =
  | { produced: true; path: string; file: string; durationSec: number }
  | { produced: false; reason: string }

export interface StageJson {
  stage: StageName
  target: TargetName
  verdict: StageResult["verdict"]
  reason: string
  runId: string | null
  resultsDir: string | null
  summary: string | null
  summaryJson: string | null
  video: string | null
  videoNote: string | null
  undoChanges: number
  undoFailed: number
  undoFile: string | null
  startedAt: string | null
  durationMs: number | null
  exitCode: number | null
}

/**
 * Where the pipeline is: "running" (written ahead, before the first stage,
 * and as each stage starts and ends), "stopping" (a stop request or the
 * deadline arrived; the running stage is finishing its report),
 * "finished" (the final document) or "aborted" (a second Ctrl-C stopped it
 * without waiting). Anything but "finished" means the pipeline did not
 * finish: the stage folders hold what the stages wrote.
 */
export type PipelineStatus = "running" | "stopping" | "finished" | "aborted"

export interface PipelineDocument<M extends string = string> {
  pipelineId: string
  module: M
  status: PipelineStatus
  /** What stopped the pipeline early ("SIGTERM", "the deadline (--deadline 25m)"), or null. */
  stoppedBy: string | null
  verdict: PipelineVerdict
  verdictReason: string
  exitCode: number
  options: Omit<PipelineOptions<M>, "module" | "help">
  startedAt: string
  /** Null until the pipeline finished (or was aborted). */
  finishedAt: string | null
  resultsDir: string
  stages: StageJson[]
  [extra: string]: unknown
  video: PipelineVideoSummary
  narration: NarrationSummary
}

/** The project's report hooks (markdown, the combined video). */
export interface PipelineReport<M extends string, S> {
  /** Extra pipeline.json fields, written before `video` (e.g. a feature comparison). */
  extras?(request: PipelineRequest<M, S>): Record<string, unknown>
  /** pipeline.md. */
  markdown(
    doc: PipelineDocument<M>,
    request: PipelineRequest<M, S>,
    dir: string,
  ): string
  /** The combined video; never throws (a failure is a reason). */
  compose?(request: PipelineRequest<M, S>, env: Env): Promise<ComposedVideo>
  /** Extra closing log lines (e.g. what the narration did). */
  closingLines?(doc: PipelineDocument<M>): string[]
}

/**
 * Everything the pipeline runner needs from the project: its modules and
 * arguments (PipelineArgsSpec), its secrets rule (StageEnvSpec), where it
 * lives and keeps results, how to name runs, which Playwright projects a
 * stage runs, whether staging is configured, an optional per-run database
 * (DbIsolation) and the report hooks.
 *
 * Built once by the project's pipeline entry point and passed to
 * runPipeline. The runner never retries a stage, starts staging only after
 * a development PASS (or with --staging-only), and hands staging secrets to
 * the staging stage only.
 */
export interface PipelineSpec<M extends string, S = StageSummaryShape>
  extends PipelineArgsSpec<M>, StageEnvSpec {
  /** The repository root (children run there; paths are shown relative to it). */
  repoRoot: string
  /** The Playwright config each stage runs, relative to repoRoot. */
  playwrightConfig: string
  usage: string
  /** <results>/<id>. */
  resultsDir(id: string): string
  makeRunId(target: TargetName): string
  makePipelineId(): string
  stageInfo: Record<StageName, StageInfo>
  /** The Playwright projects a stage runs for these options. */
  projects(options: PipelineOptions<M>): string[]
  /**
   * The staging config problem (null = configured), loaded with the env the
   * staging stage would get. Never called for --local.
   */
  stagingConfigProblem(env: Record<string, string>): string | null
  /** A fresh database per development run for these modules. */
  db?: {
    modules: readonly M[]
    isolation: DbIsolation
    keyPrefix: string
    /** How the copy reads in the log (its database name), from create()'s env. */
    describe?(env: Record<string, string>): string | null
    /** How to drop a kept copy by hand. */
    dropCommand?(key: string): string
  }
  report: PipelineReport<M, S>
}

/**
 * A signal the pipeline treats as a stop request. SIGBREAK is Windows'
 * Ctrl-Break; SIGHUP counts only when the pipeline runs in a terminal.
 */
export type StopSignal = "SIGINT" | "SIGTERM" | "SIGBREAK" | "SIGHUP"

/** How the runner touches the outside world (injectable for tests). */
export interface PipelineIo {
  /**
   * Runs one stage's child with Playwright's arguments (stageCommand);
   * resolves with its exit code (null = signal).
   */
  runChild: (
    args: string[],
    env: Record<string, string>,
    cwd: string,
    prefix: string,
  ) => Promise<number | null>
  log: (line: string) => void
  now: () => Date
  /**
   * Registers the stop handler, called with each stop signal as it arrives
   * (SIGINT, SIGTERM, SIGBREAK on Windows, and SIGHUP when `interactive`).
   * A call without a signal means SIGINT.
   */
  onInterrupt: (handler: (signal?: StopSignal) => void) => void
  /**
   * Asks the running stage to stop the way a first Ctrl-C stops Playwright.
   * Returns whether a stage was signalled; never throws. Optional: without
   * it no stage is signalled (only a signal that reaches the stage itself,
   * such as a terminal's Ctrl-C, stops it).
   */
  interruptChild?: () => boolean
  /**
   * Resolves true once no stage is running, or false after `ms`. Optional:
   * without it a forced stop does not wait.
   */
  waitForChild?: (ms: number) => Promise<boolean>
  /** Kills the running stage outright (SIGKILL). Optional; never throws. */
  killChild?: () => void
  /** A monotonic clock in milliseconds (default performance.now). */
  clock?: () => number
  /**
   * Runs `fn` once after `ms`; returns a function that cancels it. Default:
   * a timer that does not keep the process alive.
   */
  schedule?: (ms: number, fn: () => void) => () => void
  /**
   * The pipeline's process id, handed to each stage (FLOWREEL_PIPELINE_PID)
   * so the stage stops when the pipeline is gone. Unset: not handed over.
   */
  pid?: number
  /**
   * Whether the pipeline runs in a terminal (stdin or stdout is a TTY): a
   * hangup then stops a stage gracefully (FLOWREEL_HUP=graceful).
   */
  interactive?: boolean
  exit: (code: number) => never
  /** The environment stages inherit from. */
  env: Env
}

/** Streams a child's output line by line with a stage prefix. */
function prefixed(
  stream: NodeJS.ReadableStream,
  prefix: string,
  write: (text: string) => void,
) {
  let pending = ""
  stream.setEncoding("utf8")
  stream.on("data", (chunk: string) => {
    const lines = (pending + chunk).split("\n")
    pending = lines.pop() ?? ""
    for (const line of lines) write(`${prefix} ${line}\n`)
  })
  stream.on("end", () => {
    if (pending) write(`${prefix} ${pending}\n`)
  })
}

/** What processIo touches besides spawn (injectable for tests). */
export interface ProcessIoSeams {
  /** Default: process.platform. */
  platform?: NodeJS.Platform
  /** How a stage's Playwright is started (default: playwrightLauncher). */
  launcher?: (cwd: string) => StageLauncher
  /** Default: whether stdin or stdout is a TTY. */
  interactive?: boolean
}

/** Output errors that mean the reader is gone (the terminal closed, say). */
const READER_GONE = new Set(["EPIPE", "EIO", "ERR_STREAM_DESTROYED"])

/** Ignores an output error whose reader is gone; rethrows anything else. */
function ignoreGoneReader(error: Error): void {
  if (READER_GONE.has((error as NodeJS.ErrnoException).code ?? "")) return
  throw error
}

/** setTimeout's longest delay; a later deadline is never reached in one run. */
const MAX_TIMER_MS = 2_147_483_647

/**
 * The real thing: Playwright children, the console, SIGINT / SIGTERM (and
 * SIGBREAK on Windows), process.exit.
 *
 * Each stage runs Playwright's command-line entry with the current Node
 * (playwrightLauncher; `npx --no-install playwright` only when it cannot be
 * resolved, and the log says which), in the pipeline's own process group,
 * so a terminal's Ctrl-C reaches both. On POSIX `interruptChild` sends the
 * stage SIGINT; Playwright treats repeats within a second as one, so a
 * terminal's own Ctrl-C to the stage and the pipeline's are one stop. On
 * Windows it signals nothing: a console Ctrl-C or Ctrl-Break already reaches
 * every process on the console, and a signal sent to a child there
 * terminates it. Never throws for a missing or finished child.
 */
export function processIo(
  logPrefix = "pipeline",
  /** Injectable for tests. */
  spawnChild: typeof spawn = spawn,
  seams: ProcessIoSeams = {},
): PipelineIo {
  const windows = (seams.platform ?? process.platform) === "win32"
  const interactive =
    seams.interactive ?? Boolean(process.stdin.isTTY || process.stdout.isTTY)
  const launcherFor =
    seams.launcher ?? ((cwd: string) => playwrightLauncher(cwd))
  const log = (line: string) => console.log(`[${logPrefix}] ${line}`)
  let current: { child: ChildProcess; closed: Promise<void> } | null = null
  return {
    runChild: (args, env, cwd, prefix) =>
      new Promise<number | null>((done) => {
        const launcher = launcherFor(cwd)
        log(`${prefix} playwright: ${launcher.description}`)
        if (launcher.problem) {
          process.stderr.write(
            `${prefix} could not start: ${launcher.problem}\n`,
          )
          done(null)
          return
        }
        let closed: () => void = () => undefined
        const child = spawnChild(
          launcher.command,
          [...launcher.args, ...args],
          {
            cwd,
            env,
            stdio: ["ignore", "pipe", "pipe"],
          },
        )
        const entry = {
          child,
          closed: new Promise<void>((resolveClosed) => {
            closed = resolveClosed
          }),
        }
        current = entry
        const finish = (code: number | null) => {
          if (current === entry) current = null
          closed()
          done(code)
        }
        prefixed(child.stdout, prefix, (t) => process.stdout.write(t))
        prefixed(child.stderr, prefix, (t) => process.stderr.write(t))
        child.on("error", (error) => {
          process.stderr.write(`${prefix} could not start: ${error.message}\n`)
          finish(null)
        })
        child.on("close", (code) => finish(code))
      }),
    log,
    now: () => new Date(),
    onInterrupt: (handler) => {
      const signals: StopSignal[] = windows
        ? ["SIGINT", "SIGTERM", "SIGBREAK"]
        : ["SIGINT", "SIGTERM"]
      // Only in a terminal: without one, SIGHUP keeps its default (nohup).
      if (interactive) signals.push("SIGHUP")
      for (const signal of signals) process.on(signal, () => handler(signal))
      // A closed terminal must not crash the pipeline before it has written
      // pipeline.json.
      process.stdout.on("error", ignoreGoneReader)
      process.stderr.on("error", ignoreGoneReader)
    },
    interruptChild: () => {
      if (windows || !current) return false
      try {
        return current.child.kill("SIGINT")
      } catch {
        return false
      }
    },
    waitForChild: (ms) => {
      const running = current
      if (!running) return Promise.resolve(true)
      return new Promise<boolean>((resolveWait) => {
        const timer = setTimeout(() => resolveWait(false), ms)
        void running.closed.then(() => {
          clearTimeout(timer)
          resolveWait(true)
        })
      })
    },
    killChild: () => {
      try {
        current?.child.kill("SIGKILL")
      } catch {
        // Already gone.
      }
    },
    clock: () => performance.now(),
    schedule: timerSchedule,
    pid: process.pid,
    interactive,
    exit: (code) => process.exit(code),
    env: process.env,
  }
}

function readSummary<S>(dir: string): S | null {
  try {
    return JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")) as S
  } catch {
    return null
  }
}

/** Seconds with one decimal, as the pipeline log and markdown show them. */
const fmtSeconds = (sec: number) => sec.toFixed(1)

/** The same signal again within this many milliseconds is one delivery. */
const DUPLICATE_SIGNAL_MS = 200

/** How long a forced stop waits for the stage to close before killing it. */
const FORCE_WAIT_MS = 3000

/** How a stop signal reads in pipeline.json's `stoppedBy`. */
const SIGNAL_NAMES: Readonly<Record<StopSignal, string>> = {
  SIGINT: "Ctrl-C (SIGINT)",
  SIGTERM: "SIGTERM",
  SIGBREAK: "Ctrl-Break (SIGBREAK)",
  SIGHUP: "SIGHUP (the terminal closed)",
}

/** The combined video's outcome when a stop request ended it. */
const COMBINED_STOPPED = "video composition stopped (interrupted)"

/** Whether `promise` settled within `ms`. Never rejects. */
function settleWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((done) => {
    const timer = setTimeout(() => done(false), ms)
    const settled = () => {
      clearTimeout(timer)
      done(true)
    }
    promise.then(settled, settled)
  })
}

/** A one-off timer that does not keep the process alive. */
function timerSchedule(ms: number, fn: () => void): () => void {
  if (ms > MAX_TIMER_MS) return () => undefined
  const timer = setTimeout(fn, Math.max(0, ms))
  timer.unref()
  return () => clearTimeout(timer)
}

/**
 * Runs the pipeline for `argv` and returns the exit code (0/1/2/3/4, 64
 * for bad arguments or a bad --deadline / FLOWREEL_DEADLINE, 130 stopped by
 * a signal or the deadline before a stage that would have run, or aborted
 * by a second Ctrl-C). Never throws for a stage failure; a crash of the
 * runner itself rejects.
 *
 * pipeline.json is written ahead with status "running", rewritten as each
 * stage starts and ends and on the first stop ("stopping"), and finally
 * with status "finished" (or "aborted"). Every write replaces the file
 * atomically (a temporary file, then a rename).
 */
export async function runPipeline<
  M extends string,
  S extends StageSummaryShape,
>(
  argv: string[],
  spec: PipelineSpec<M, S>,
  io: PipelineIo = processIo(),
): Promise<number> {
  let options: PipelineOptions<M>
  let deadlineSource = "--deadline"
  try {
    options = parsePipelineArgs(argv, spec)
    const fromEnv = envVar(io.env, "DEADLINE")
    if (!options.deadline && !options.help && fromEnv) {
      options.deadline = parseDeadline(fromEnv.value, fromEnv.name)
      deadlineSource = fromEnv.name
    }
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    console.error(`${error.message}\n\n${spec.usage}`)
    return EXIT.usage
  }
  if (options.help) {
    console.log(spec.usage)
    return EXIT.pass
  }
  const log = io.log
  const rel = (path: string) => relative(spec.repoRoot, path)
  const clock = io.clock ?? (() => performance.now())
  const schedule = io.schedule ?? timerSchedule
  /** The database copy while it exists and is to be dropped (not --keep-db). */
  let liveClone: string | null = null
  const drop = (key: string) => {
    if (spec.db?.isolation.drop(key) && liveClone === key) liveClone = null
  }

  const pipelineId = spec.makePipelineId()
  const dir = spec.resultsDir(pipelineId)
  mkdirSync(dir, { recursive: true })
  const startedAt = io.now()
  const flags = {
    local: options.local,
    stagingOnly: options.stagingOnly,
    headed: options.headed,
    video: options.video,
    areas: options.areas,
    pace: options.pace,
    keepDb: options.keepDb,
    narration: options.narration,
    deadline: options.deadline,
  }
  const deadline = options.deadline
  const deadlineMs = deadline ? deadlineAt(deadline, startedAt.getTime()) : null
  const deadlineLabel = deadlineSource.startsWith("--")
    ? `${deadlineSource} ${deadline?.label}`
    : `${deadlineSource}=${deadline?.label}`

  /** The first stop request (a signal or the deadline), once there is one. */
  let stop: { cause: StopCause; by: string; at: number } | null = null
  // Read through a function: TypeScript cannot see the handlers set it.
  const stopped = () => stop
  let lastSignal: { signal: StopSignal; at: number } | null = null
  /** Set by a second Ctrl-C: resolves with the exit code once settled. */
  let aborted: Promise<number> | null = null
  /** No stage is left to run: a stop request no longer changes anything. */
  let stagesDone = false
  let cancelDeadline: () => void = () => undefined
  /** The stage whose child is running. */
  let running: {
    stage: StageName
    runId: string
    dir: string
    startedAt: Date
  } | null = null
  /** The stages decided or finished so far. */
  const finished: Partial<Record<StageName, StageRecord<S>>> = {}
  /** Aborted by any stop request: ends the combined video's composition. */
  const composeStop = new AbortController()
  /** The combined video's composition while it runs. */
  let composing: Promise<unknown> | null = null

  const envFor = (
    stage: StageName,
    runId: string,
    extra?: Record<string, string>,
  ) =>
    stageEnv(stage, runId, io.env, options, spec, extra, spec.defaultModule, {
      pipelinePid: io.pid,
      gracefulHangup: io.interactive,
      deadlineAt: deadlineMs,
    })

  const notRun = (stage: StageName, result: StageResult): StageRecord<S> => ({
    stage,
    result,
    ...spec.stageInfo[stage],
    runId: null,
    dir: null,
    summary: null,
    ledger: null,
    startedAt: null,
    durationMs: null,
    exitCode: null,
  })

  /** Writes one report file atomically; a failure is logged, never thrown. */
  const writeFile = (name: string, content: () => string) => {
    const path = join(dir, name)
    const tmp = `${path}.tmp`
    try {
      writeFileSync(tmp, content())
      renameSync(tmp, path)
    } catch (error) {
      rmSync(tmp, { force: true })
      log(
        `could not write ${name}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  const json = (doc: PipelineDocument<M>) => `${JSON.stringify(doc, null, 2)}\n`
  const notFinished = (reason: string) => ({ produced: false as const, reason })

  /** A stage that has not finished, as the write-ahead document shows it. */
  const provisional = (stage: StageName): StageJson => {
    const record = finished[stage]
    if (record) return stageJson(record, rel)
    const live = running?.stage === stage ? running : null
    return stageJson(
      {
        stage,
        ...spec.stageInfo[stage],
        result: {
          stage,
          verdict: "not run",
          reason: live ? (stop ? "stopping" : "running") : "pending",
        },
        runId: live?.runId ?? null,
        dir: live?.dir ?? null,
        summary: null,
        ledger: null,
        startedAt: live ? live.startedAt.toISOString() : null,
        durationMs: null,
        exitCode: null,
      },
      rel,
    )
  }

  /** The write-ahead pipeline.json while stages still run (or stop). */
  const progress = () => {
    if (aborted || stagesDone) return
    const doc: PipelineDocument<M> = {
      pipelineId,
      module: options.module,
      status: stop ? "stopping" : "running",
      stoppedBy: stop?.by ?? null,
      verdict: "INCOMPLETE",
      verdictReason: stop
        ? `Stopping (${stop.by}): no further stage starts.`
        : running
          ? `Running ${running.stage}.`
          : "Running.",
      exitCode: EXIT.interrupted,
      options: flags,
      startedAt: startedAt.toISOString(),
      finishedAt: null,
      resultsDir: rel(dir),
      stages: STAGES.map(provisional),
      video: notFinished("the pipeline has not finished"),
      narration: notFinished("the pipeline has not finished"),
    }
    writeFile("pipeline.json", () => json(doc))
  }

  /** The first stop request: the running stage stops, no further stage starts. */
  const beginStop = (cause: StopCause, by: string, line: string) => {
    stop = { cause, by, at: clock() }
    composeStop.abort()
    if (running) io.interruptChild?.()
    log(line)
    progress()
  }

  /**
   * The final documents after a second Ctrl-C: the running stage reads as
   * aborted (a restore its ledger still lists outranks it with exit 4).
   * Returns the exit code.
   */
  const writeAborted = (): number => {
    const now = io.now()
    const development =
      finished.development ??
      liveRecord("development", now) ??
      notRun("development", {
        stage: "development",
        verdict: "not run",
        reason: `not run (${ABORTED_REASON})`,
      })
    const staging =
      finished.staging ??
      liveRecord("staging", now) ??
      notRun(
        "staging",
        (
          stagingDecision(options, development.result, null, "interrupted") as {
            run: false
            result: StageResult
          }
        ).result,
      )
    const records = [development, staging]
    let outcome = pipelineOutcome(records.map((r) => r.result))
    if (outcome.exitCode === EXIT.pass) {
      outcome = {
        verdict: "INCOMPLETE",
        reason: `${outcome.reason} The pipeline was ${ABORTED_REASON} before it finished.`,
        exitCode: EXIT.interrupted,
      }
    }
    const request: PipelineRequest<M, S> = {
      module: options.module,
      pipelineId,
      dir,
      startedAt,
      verdict: outcome.verdict,
      reason: outcome.reason,
      stages: records,
    }
    const doc: PipelineDocument<M> = {
      pipelineId,
      module: options.module,
      status: "aborted",
      stoppedBy: stop ? `${stop.by}, then a second Ctrl-C` : "a second Ctrl-C",
      verdict: outcome.verdict,
      verdictReason: outcome.reason,
      exitCode: outcome.exitCode,
      options: flags,
      startedAt: startedAt.toISOString(),
      finishedAt: now.toISOString(),
      resultsDir: rel(dir),
      stages: records.map((record) => stageJson(record, rel)),
      video: notFinished(`skipped: ${ABORTED_REASON}`),
      narration: notFinished(`skipped: ${ABORTED_REASON}`),
    }
    writeFile("pipeline.json", () => json(doc))
    writeFile("pipeline.md", () => spec.report.markdown(doc, request, dir))
    return outcome.exitCode
  }
  /** The running stage as a second Ctrl-C leaves it, or null for another stage. */
  function liveRecord(stage: StageName, now: Date): StageRecord<S> | null {
    const live = running
    if (live?.stage !== stage) return null
    const ledger = readUndoLedger(live.dir, live.runId)
    const undoFailed = ledger?.manual.length ?? 0
    return {
      stage,
      ...spec.stageInfo[stage],
      result: {
        stage,
        verdict: "not run",
        reason: ABORTED_REASON,
        ...(undoFailed > 0 ? { undoFailed } : {}),
      },
      runId: live.runId,
      dir: live.dir,
      summary: readSummary<S>(live.dir),
      ledger,
      startedAt: live.startedAt.toISOString(),
      durationMs: now.getTime() - live.startedAt.getTime(),
      exitCode: null,
    }
  }

  /**
   * A second Ctrl-C: the final documents now, then up to 3 s for the stage
   * to close before it is killed, then the database copy is dropped (unless
   * --keep-db: the finally that drops it never runs after exit) and the
   * pipeline exits.
   */
  const abortNow = () => {
    cancelDeadline()
    // Stops the combined video's tools (their children are signalled now).
    composeStop.abort()
    const live = running
    log(
      live
        ? `second Ctrl-C: stopping now, without waiting for the ${live.stage} stage's report`
        : "second Ctrl-C: stopping now",
    )
    let code = writeAborted()
    const settle = () => {
      if (liveClone) drop(liveClone)
      io.exit(code)
      return code
    }
    if (live && io.waitForChild) {
      aborted = io.waitForChild(FORCE_WAIT_MS).then((closed) => {
        if (!closed) {
          log(
            `the ${live.stage} stage did not stop within ${FORCE_WAIT_MS / 1000} s: killing it`,
          )
          io.killChild?.()
        }
        // A restore the kill left pending is exit 4.
        code = writeAborted()
        return settle()
      })
    } else if (composing) {
      // Give the stopped encode a moment to end its tools, then exit.
      aborted = settleWithin(composing, FORCE_WAIT_MS).then(settle)
    } else {
      aborted = Promise.resolve(settle())
    }
  }

  // A stop request (Ctrl-C, a CI's SIGTERM, Ctrl-Break): see the comment at
  // the top of this file.
  io.onInterrupt((signal: StopSignal = "SIGINT") => {
    if (aborted) return
    const at = clock()
    if (
      lastSignal?.signal === signal &&
      at - lastSignal.at < DUPLICATE_SIGNAL_MS
    ) {
      return
    }
    lastSignal = { signal, at }
    // Only a Ctrl-C (or Ctrl-Break) can force; SIGTERM and SIGHUP never do.
    const ctrlC = signal === "SIGINT" || signal === "SIGBREAK"
    if (!stop) {
      const what = ctrlC ? "interrupted" : signal
      beginStop(
        "interrupted",
        SIGNAL_NAMES[signal],
        `${what}: ${running ? "finishing the current stage's report, no next stage" : "no further stage"}${ctrlC ? "; press Ctrl-C again to stop now without waiting" : ""}`,
      )
      return
    }
    if (!ctrlC) {
      log(
        `${signal} after the stop request: still finishing the stage's report; a kill may follow`,
      )
      return
    }
    // A Ctrl-C that arrived with the first stop request is part of it.
    if (at - stop.at < DUPLICATE_SIGNAL_MS) return
    abortNow()
  })

  const runStage = async (
    stage: StageName,
    extraEnv: Record<string, string> = {},
  ): Promise<StageRecord<S>> => {
    // A stop that arrived while the database copy was being made.
    if (stop) {
      const reason = STOP_REASONS[stop.cause]
      return notRun(stage, { stage, verdict: "not run", reason })
    }
    const info = spec.stageInfo[stage]
    const runId = spec.makeRunId(info.target)
    const stageDir = spec.resultsDir(runId)
    const started = io.now()
    log(`${stage}: ${runId} (${preferredEnvName("TARGET")}=${info.target})`)
    running = { stage, runId, dir: stageDir, startedAt: started }
    progress()
    const exitCode = await io.runChild(
      stageCommand(
        spec.playwrightConfig,
        spec.projects(options),
        options.headed,
      ),
      envFor(stage, runId, extraEnv),
      spec.repoRoot,
      `[${stage}]`,
    )
    running = null
    const summary = readSummary<S>(stageDir)
    const ledger = readUndoLedger(stageDir, runId)
    const result = stageVerdictFrom(
      stage,
      summary,
      exitCode,
      ledger?.manual.length ?? 0,
    )
    const record: StageRecord<S> = {
      stage,
      result,
      ...info,
      runId,
      dir: stageDir,
      summary,
      ledger,
      startedAt: started.toISOString(),
      durationMs: io.now().getTime() - started.getTime(),
      exitCode,
    }
    // Recorded before anything else happens: a second Ctrl-C from here on
    // keeps this stage's verdict.
    finished[stage] = record
    log(`${stage}: ${stageLabel(result)}`)
    if ((result.undoFailed ?? 0) > 0) {
      log(
        `${stage}: UNDO FAILED, ${result.undoFailed} shared-config change(s) not put back: ${rel(join(stageDir, "undo.md"))}`,
      )
    }
    return record
  }

  log(`${pipelineId} (${options.module})`)
  // Written ahead: a pipeline killed from here on still leaves a document
  // that says it did not finish.
  progress()
  if (deadlineMs !== null && deadlineMs <= io.now().getTime()) {
    // Already past: nothing is started at all (no database copy, no stage).
    log(`deadline: ${new Date(deadlineMs).toISOString()} (${deadlineLabel})`)
    beginStop(
      "deadline",
      `the deadline (${deadlineLabel})`,
      `deadline reached (${deadlineLabel}) before the pipeline started: no stage runs`,
    )
  } else if (deadlineMs !== null) {
    log(`deadline: ${new Date(deadlineMs).toISOString()} (${deadlineLabel})`)
    cancelDeadline = schedule(
      Math.max(0, deadlineMs - io.now().getTime()),
      () => {
        if (aborted || stagesDone) return
        if (stop) {
          log(`deadline reached (${deadlineLabel}) while already stopping`)
          return
        }
        beginStop(
          "deadline",
          `the deadline (${deadlineLabel})`,
          `deadline reached (${deadlineLabel}): ${running ? `stopping ${running.stage}` : "no further stage"}`,
        )
      },
    )
  }

  // Read once, up front, so a missing secret is said before development's
  // minutes of work; never read for --local (local never reads the file).
  const configProblem = options.local
    ? null
    : spec.stagingConfigProblem(envFor("staging", "config-check"))
  if (configProblem) {
    log(
      `staging is not configured (${configProblem}); ${options.stagingOnly ? "nothing to run." : "development only."}`,
    )
  }

  const devDecision = developmentDecision(options, stopped()?.cause ?? false)
  let development: StageRecord<S>
  if (!devDecision.run) {
    development = notRun("development", devDecision.result)
  } else if (spec.db?.modules.includes(options.module)) {
    // A fresh database per run, dropped unless --keep-db.
    const isolation = spec.db.isolation
    let clone: { key: string; env: Record<string, string> } | null = null
    try {
      const key = cloneKey(spec.db.keyPrefix)
      clone = {
        key,
        env: { ...isolation.create(key), [preferredEnvName("DB_KEY")]: key },
      }
      if (!options.keepDb) liveClone = clone.key
      const described = spec.db.describe?.(clone.env)
      log(
        `development DB clone: ${clone.key}${described ? ` (${described})` : ""}`,
      )
      development = await runStage("development", clone.env)
    } catch (error) {
      running = null
      const reason = error instanceof Error ? error.message : String(error)
      log(`development: FAIL (${reason})`)
      development = notRun("development", {
        stage: "development",
        verdict: "FAIL",
        reason,
      })
    } finally {
      // Unless a second Ctrl-C already dropped it.
      if (clone && !options.keepDb) {
        if (liveClone === clone.key) drop(clone.key)
      } else if (clone)
        log(
          `kept the development DB clone ${clone.key} (--keep-db; ${spec.db.dropCommand ? `drop: ${spec.db.dropCommand(clone.key)}` : "drop it when done"})`,
        )
    }
  } else {
    development = await runStage("development")
  }
  if (aborted) return aborted
  finished.development = development
  progress()
  const stgDecision = stagingDecision(
    options,
    development.result,
    configProblem,
    stopped()?.cause ?? false,
  )
  const staging = stgDecision.run
    ? await runStage("staging")
    : notRun("staging", stgDecision.result)
  if (aborted) return aborted
  if (!stgDecision.run) log(`staging: ${stageLabel(stgDecision.result)}`)
  finished.staging = staging
  stagesDone = true
  cancelDeadline()

  const records = [development, staging]
  /**
   * A stopped run is never a pass: a PASS becomes INCOMPLETE (130) naming
   * the stop; a FAIL, N/A or an undo failure (4) stands.
   */
  const settled = (): {
    verdict: PipelineVerdict
    reason: string
    exitCode: number
  } => {
    const base = pipelineOutcome(records.map((r) => r.result))
    const stoppedNow = stopped()
    if (!stoppedNow || base.exitCode !== EXIT.pass) return base
    return {
      verdict: "INCOMPLETE",
      reason: `${base.reason} Stopped by ${stoppedNow.by} before the pipeline finished.`,
      exitCode: EXIT.interrupted,
    }
  }
  let outcome = settled()
  const request: PipelineRequest<M, S> = {
    module: options.module,
    pipelineId,
    dir,
    startedAt,
    verdict: outcome.verdict,
    reason: outcome.reason,
    stages: records,
  }
  const doc: PipelineDocument<M> = {
    pipelineId,
    module: options.module,
    status: "finished",
    stoppedBy: stopped()?.by ?? null,
    verdict: outcome.verdict,
    verdictReason: outcome.reason,
    exitCode: outcome.exitCode,
    options: flags,
    startedAt: startedAt.toISOString(),
    finishedAt: io.now().toISOString(),
    resultsDir: rel(dir),
    stages: records.map((record) => stageJson(record, rel)),
    ...(spec.report.extras?.(request) ?? {}),
    video: notFinished("composition did not finish"),
    narration: notFinished("composition did not finish"),
  }
  /**
   * The combined video's composition, ended by any stop request: its tools
   * (ffmpeg, the voice engine, the card browser) stop with it.
   */
  const stoppable = (work: () => Promise<ComposedVideo>) =>
    new Promise<ComposedVideo>((resolve, reject) => {
      const onAbort = () =>
        resolve({ produced: false, reason: COMBINED_STOPPED })
      composeStop.signal.addEventListener("abort", onAbort, { once: true })
      const task = withMediaSignal(composeStop.signal, work)
      composing = task
      task.then(
        (value) => {
          composeStop.signal.removeEventListener("abort", onAbort)
          resolve(value)
        },
        (error: unknown) => {
          composeStop.signal.removeEventListener("abort", onAbort)
          reject(error)
        },
      )
    })
  // Each file on its own: a disk error or an unexpected summary shape is
  // logged, never a crash that would turn the stages' verdict into exit 1.
  const write = () => {
    writeFile("pipeline.json", () => json(doc))
    writeFile("pipeline.md", () => spec.report.markdown(doc, request, dir))
  }
  // Written before the video, so a killed composition still leaves both.
  write()
  const videoEnv: Env = {}
  if (options.video) {
    Object.assign(videoEnv, io.env)
    if (options.narration) {
      for (const name of envNames("NARRATION")) delete videoEnv[name]
      videoEnv[preferredEnvName("NARRATION")] = options.narration
    }
  } else {
    videoEnv[preferredEnvName("VIDEO")] = "off"
  }
  // A stopped pipeline makes no combined video, and neither does one too
  // close to its deadline (the CI's kill would land in the middle of it).
  const stoppedBy = stopped()
  const skipped = stoppedBy
    ? stoppedBy.cause === "deadline"
      ? "skipped: the deadline was reached"
      : "skipped: the pipeline was interrupted"
    : composeSkipReason(deadlineMs, io.now().getTime(), composeBudgetMs(io.env))
  const compose = spec.report.compose
  const video: ComposedVideo = skipped
    ? { produced: false, reason: skipped }
    : compose
      ? await stoppable(() => compose(request, videoEnv))
      : { produced: false, reason: "no video composer configured" }
  if (aborted) return aborted
  // A stop during the composition: the verdict says so too.
  outcome = settled()
  doc.stoppedBy = stopped()?.by ?? null
  doc.verdict = request.verdict = outcome.verdict
  doc.verdictReason = request.reason = outcome.reason
  doc.exitCode = outcome.exitCode
  doc.video = video.produced
    ? {
        produced: true,
        path: rel(video.path),
        file: relative(dir, video.path),
        durationSec: video.durationSec,
      }
    : { produced: false, reason: video.reason }
  if (video.narration) doc.narration = video.narration
  write()

  log(`${outcome.verdict}: ${outcome.reason} Exit ${outcome.exitCode}.`)
  for (const s of doc.stages) {
    log(
      `  ${s.stage}: ${s.summary ? `${s.verdict}, ${s.summary}` : stageLabel(s)}`,
    )
  }
  log(`Summary: ${rel(join(dir, "pipeline.md"))}`)
  log(
    doc.video.produced
      ? `combined video: ${doc.video.path} (${fmtSeconds(doc.video.durationSec)}s)`
      : `combined video: not produced (${doc.video.reason})`,
  )
  for (const line of spec.report.closingLines?.(doc) ?? []) log(line)
  return outcome.exitCode
}

/** A stage as pipeline.json records it. */
export function stageJson<S extends StageSummaryShape>(
  record: StageRecord<S>,
  rel: (path: string) => string,
): StageJson {
  const video = record.summary?.video as
    | { produced: true; path: string }
    | { produced: false; reason: string }
    | undefined
  const undo = record.summary?.undo
  const undoChanges =
    typeof undo?.total === "number" ? undo.total : (record.ledger?.total ?? 0)
  return {
    stage: record.stage,
    target: record.target,
    verdict: record.result.verdict,
    reason: record.result.reason,
    runId: record.runId,
    resultsDir: record.dir ? rel(record.dir) : null,
    summary:
      record.dir && record.summary ? rel(join(record.dir, "summary.md")) : null,
    summaryJson:
      record.dir && record.summary
        ? rel(join(record.dir, "summary.json"))
        : null,
    video: video?.produced ? video.path : null,
    videoNote: video && !video.produced ? video.reason : null,
    undoChanges,
    undoFailed: record.result.undoFailed ?? 0,
    undoFile:
      record.dir && (record.result.undoFailed ?? 0) > 0
        ? rel(join(record.dir, "undo.md"))
        : null,
    startedAt: record.startedAt,
    durationMs: record.durationMs,
    exitCode: record.exitCode,
  }
}

/**
 * The pipeline as a command: runs it and exits the process with its code; a
 * crash of the runner itself is logged and exits 1.
 */
export function runPipelineCli<M extends string, S extends StageSummaryShape>(
  spec: PipelineSpec<M, S>,
  argv: string[] = process.argv.slice(2),
  io: PipelineIo = processIo(),
): void {
  runPipeline(argv, spec, io).then(
    (code) => io.exit(code),
    (error: unknown) => {
      console.error(
        `[pipeline] crashed: ${error instanceof Error ? error.message : String(error)}`,
      )
      io.exit(EXIT.fail)
    },
  )
}
