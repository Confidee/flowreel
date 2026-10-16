// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"

import type { TargetName } from "../config/targets.js"
import { type Env, envNames } from "../core/env.js"
import {
  UNDO_JSON,
  type UndoEntry,
  type UndoSummary,
  fileUndoStore,
  summarizeUndo,
} from "../core/undo.js"

import { stageCommand } from "./command.js"
import { type DbIsolation, cloneKey } from "./db.js"
import {
  EXIT,
  type PipelineVerdict,
  type StageName,
  type StageResult,
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
  parsePipelineArgs,
} from "./options.js"

// The development -> staging pipeline, run on the operator's machine (or CI):
// stage 1 "development" (a local test server, test seams), stage 2
// "staging" ONLY after a development PASS. Each stage is its own
// `npx playwright test` child with its own RUN_ID and a clean env (only
// staging gets the secrets), its output streamed with a [development] /
// [staging] prefix, and never retried. A module may ask for a fresh
// database per development run (DbIsolation), dropped afterwards unless
// --keep-db. The decisions are the pure functions in decisions.ts; this
// file runs them and writes <results>/<PIPELINE_ID>/pipeline.{md,json}
// plus, through the project's report hooks, the combined video (which
// never changes the verdict).

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

export interface PipelineDocument<M extends string = string> {
  pipelineId: string
  module: M
  verdict: PipelineVerdict
  verdictReason: string
  exitCode: number
  options: Omit<PipelineOptions<M>, "module" | "help">
  startedAt: string
  finishedAt: string
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

/** How the runner touches the outside world (injectable for tests). */
export interface PipelineIo {
  /** Runs one stage's child; resolves with its exit code (null = signal). */
  runChild: (
    args: string[],
    env: Record<string, string>,
    cwd: string,
    prefix: string,
  ) => Promise<number | null>
  log: (line: string) => void
  now: () => Date
  /** Registers the Ctrl-C handler. */
  onInterrupt: (handler: () => void) => void
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

/** The real thing: npx children, console, SIGINT, process.exit. */
export function processIo(
  logPrefix = "pipeline",
  /** Injectable for tests. */
  spawnChild: typeof spawn = spawn,
): PipelineIo {
  return {
    runChild: (args, env, cwd, prefix) =>
      new Promise<number | null>((done) => {
        const child = spawnChild("npx", args, {
          cwd,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        })
        prefixed(child.stdout, prefix, (t) => process.stdout.write(t))
        prefixed(child.stderr, prefix, (t) => process.stderr.write(t))
        child.on("error", (error) => {
          process.stderr.write(`${prefix} could not start: ${error.message}\n`)
          done(null)
        })
        child.on("close", (code) => done(code))
      }),
    log: (line) => console.log(`[${logPrefix}] ${line}`),
    now: () => new Date(),
    onInterrupt: (handler) => {
      process.on("SIGINT", handler)
    },
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

/**
 * Runs the pipeline for `argv` and returns the exit code (0/1/2/3/4, 64
 * for bad arguments). Never throws for a stage failure; a crash of the
 * runner itself rejects.
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
  try {
    options = parsePipelineArgs(argv, spec)
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
  let interrupted = false
  /** The database copy while it exists and is to be dropped (not --keep-db). */
  let liveClone: string | null = null
  const drop = (key: string) => {
    if (spec.db?.isolation.drop(key) && liveClone === key) liveClone = null
  }

  // Ctrl-C reaches the running child too (same process group); the
  // pipeline then records what happened instead of dying mid-write, and
  // never starts another stage. A second Ctrl-C drops the database copy
  // (unless --keep-db) and exits.
  io.onInterrupt(() => {
    if (interrupted) {
      // The finally that drops the copy never runs after exit: drop it now.
      if (liveClone) drop(liveClone)
      io.exit(EXIT.interrupted)
    }
    interrupted = true
    log("interrupted: finishing the current stage's report, no next stage")
  })

  const envFor = (
    stage: StageName,
    runId: string,
    extra?: Record<string, string>,
  ) => stageEnv(stage, runId, io.env, options, spec, extra, spec.defaultModule)

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

  const runStage = async (
    stage: StageName,
    extraEnv: Record<string, string> = {},
  ): Promise<StageRecord<S>> => {
    const info = spec.stageInfo[stage]
    const runId = spec.makeRunId(info.target)
    const dir = spec.resultsDir(runId)
    const started = io.now()
    log(`${stage}: ${runId} (${preferredEnvName("TARGET")}=${info.target})`)
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
    const summary = readSummary<S>(dir)
    const ledger = readUndoLedger(dir, runId)
    const result = stageVerdictFrom(
      stage,
      summary,
      exitCode,
      ledger?.manual.length ?? 0,
    )
    log(`${stage}: ${stageLabel(result)}`)
    if ((result.undoFailed ?? 0) > 0) {
      log(
        `${stage}: UNDO FAILED, ${result.undoFailed} shared-config change(s) not put back: ${rel(join(dir, "undo.md"))}`,
      )
    }
    return {
      stage,
      result,
      ...info,
      runId,
      dir,
      summary,
      ledger,
      startedAt: started.toISOString(),
      durationMs: io.now().getTime() - started.getTime(),
      exitCode,
    }
  }

  const pipelineId = spec.makePipelineId()
  const dir = spec.resultsDir(pipelineId)
  mkdirSync(dir, { recursive: true })
  const startedAt = io.now()
  log(`${pipelineId} (${options.module})`)

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

  const devDecision = developmentDecision(options)
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
      const reason = error instanceof Error ? error.message : String(error)
      log(`development: FAIL (${reason})`)
      development = notRun("development", {
        stage: "development",
        verdict: "FAIL",
        reason,
      })
    } finally {
      if (clone && !options.keepDb) drop(clone.key)
      else if (clone)
        log(
          `kept the development DB clone ${clone.key} (--keep-db; ${spec.db.dropCommand ? `drop: ${spec.db.dropCommand(clone.key)}` : "drop it when done"})`,
        )
    }
  } else {
    development = await runStage("development")
  }
  const stgDecision = stagingDecision(
    options,
    development.result,
    configProblem,
    interrupted,
  )
  const staging = stgDecision.run
    ? await runStage("staging")
    : notRun("staging", stgDecision.result)
  if (!stgDecision.run) log(`staging: ${stageLabel(stgDecision.result)}`)

  const records = [development, staging]
  const outcome = pipelineOutcome(records.map((r) => r.result))
  const request: PipelineRequest<M, S> = {
    module: options.module,
    pipelineId,
    dir,
    startedAt,
    verdict: outcome.verdict,
    reason: outcome.reason,
    stages: records,
  }
  const flags = {
    local: options.local,
    stagingOnly: options.stagingOnly,
    headed: options.headed,
    video: options.video,
    areas: options.areas,
    pace: options.pace,
    keepDb: options.keepDb,
    narration: options.narration,
  }
  const doc: PipelineDocument<M> = {
    pipelineId,
    module: options.module,
    verdict: outcome.verdict,
    verdictReason: outcome.reason,
    exitCode: outcome.exitCode,
    options: flags,
    startedAt: startedAt.toISOString(),
    finishedAt: io.now().toISOString(),
    resultsDir: rel(dir),
    stages: records.map((record) => stageJson(record, rel)),
    ...(spec.report.extras?.(request) ?? {}),
    video: { produced: false, reason: "composition did not finish" },
    narration: { produced: false, reason: "composition did not finish" },
  }
  // Each file on its own: a disk error or an unexpected summary shape is
  // logged, never a crash that would turn the stages' verdict into exit 1.
  const write = () => {
    const files: [string, () => string][] = [
      ["pipeline.json", () => `${JSON.stringify(doc, null, 2)}\n`],
      ["pipeline.md", () => spec.report.markdown(doc, request, dir)],
    ]
    for (const [name, content] of files) {
      try {
        writeFileSync(join(dir, name), content())
      } catch (error) {
        log(
          `could not write ${name}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
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
  const video: ComposedVideo = spec.report.compose
    ? await spec.report.compose(request, videoEnv)
    : { produced: false, reason: "no video composer configured" }
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
