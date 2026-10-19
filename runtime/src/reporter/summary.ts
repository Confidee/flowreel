// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"

import type {
  FullResult,
  Location,
  Reporter,
  TestCase,
  TestError,
  TestResult,
} from "@playwright/test/reporter"

import {
  runLifecycle,
  settleWithin,
  waitForRestores,
} from "../app/lifecycle.js"
import {
  type FlowreelConfig,
  resultsDir as configResultsDir,
} from "../config/define.js"
import {
  composeBudgetMs,
  composeSkipReason,
  stageDeadlineAt,
} from "../core/deadline.js"
import { envValue } from "../core/env.js"
import { isPassive, markPassive } from "../core/passive.js"
import {
  UNDO_JSON,
  type UndoSummary,
  fileUndoStore,
  summarizeUndo,
} from "../core/undo.js"
import type { PublishOptions, PublishOutcome } from "../demos/catalogue.js"
import type { VideoPace } from "../narration/narration.js"
import { VIDEO_LOG_ATTACHMENT, parseVideoLog } from "../video/recorder.js"
import type {
  RecordedStep,
  VideoOutcome,
  VideoRequest,
} from "../video/run-video.js"
import type {
  TourFeatureRecord,
  TourVideoOutcome,
  TourVideoRequest,
} from "../video/tour-video.js"
import { withMediaSignal } from "../video/stop.js"
import { type NarrationOutcome, narrationLine } from "../voice/narrator.js"

import { installStageGuard } from "./guard.js"

import {
  type ModuleDescriptor,
  type RoundTripModule,
  type TourModule,
  type Verdict,
  modulesByKind,
  planStepIds,
} from "./module.js"
import {
  FAILED_STATUSES,
  type FeatureRow,
  NO_FEATURE_REASON,
  type TourVideoSummary,
  cell,
  duration,
  featureStatus,
  featureTable,
  parseFeatureAnnotation,
  stepFailureLocation,
  stepOutcome,
  tourVerdict,
} from "./status.js"

// The records the reporter hands the video composers are the composers' own
// types (../video/run-video.ts VideoRequest, ../video/tour-video.ts
// TourVideoRequest): one contract for the same data.

/** A test as recorded for a video: its page video, video log and steps. */
type RecordedTest = NonNullable<VideoRequest["flow"]>

type PaceRecord = Pick<VideoPace, "pace" | "slowFactor">

/** The run's console prefix when the project names none: "[flowreel]". */
export const DEFAULT_LOG_PREFIX = "flowreel"

/** The video outcome when a stop signal ended the composition. */
const COMPOSITION_STOPPED = "video composition stopped (interrupted)"

/** How long the sign-out safety net waits for restores and sign-ins. */
const SIGN_OUT_WAIT_MS = 20_000

/**
 * The summary reporter's options: the project's modules, where a run's
 * evidence goes, and its configuration, video composers and demos
 * publisher, as functions (Playwright constructs a reporter from a path with
 * JSON options, so a project binds them in a subclass).
 */
export interface SummaryReporterOptions {
  /**
   * The project's modules: exactly one "round-trip" (the release gate) and
   * at most one "tour" (the feature tour); `kind` picks each one's verdict
   * rule.
   */
  modules: readonly ModuleDescriptor[]
  /**
   * The project's flowreel configuration: where results go (<results>/
   * <RUN_ID>/, the report in its report/ folder) and the console prefix
   * ("[<logPrefix>] …", default "flowreel"). Required unless `resultsDir`
   * is given.
   */
  config?: Pick<FlowreelConfig, "results" | "logPrefix">
  /** Other projects whose tests are tabulated (e.g. a preflight). */
  tabulatedProjects?: string[]
  /** Paths in the summary are shown relative to this. */
  repoRoot: string
  /** The run's evidence folder; default <config.results>/<RUN_ID>. */
  resultsDir?(runId: string): string
  /** The run's HTML report folder; default <run folder>/report. */
  reportDir?(runId: string): string
  /** A preflight's JSON file name in the run folder, embedded when present. */
  preflightFile?: string
  /** Where a runner error without a location points in summary.lines. */
  setupLocation: string
  /**
   * The run id; default FLOWREEL_RUN_ID (or the project's registered alias).
   * "unknown-run" when unset.
   */
  runId?(): string | undefined
  /**
   * The configured target; may throw when the configuration is invalid.
   * Default: the environment's target (`envTarget`).
   */
  configuredTarget?(): string
  /**
   * The target from the environment alone (the fallback); default
   * FLOWREEL_TARGET (or the project's registered alias).
   */
  envTarget?(): string | undefined
  /** The redacted configuration for summary.json; may throw. */
  describeConfig(): unknown
  /** The pace and narration decision of a module's videos. */
  videoPace(module: string): VideoPace
  /** Composes the round-trip video; never throws. */
  produceVideo(req: VideoRequest): Promise<VideoOutcome>
  /** Composes the tour videos; never throws. Needed with a tour module. */
  produceTourVideos?(req: TourVideoRequest): Promise<TourVideoOutcome>
  /** Publishes a demo-pace run's videos (called with automatic: true). */
  publishDemos?(runDir: string, options: PublishOptions): PublishOutcome
  copy?: {
    /** summary.md's title: "# <title> <RUN_ID>: <verdict>". */
    title?: string
  }
  /** The commit; default `git rev-parse --short HEAD` in repoRoot. */
  gitSha?(): string
  /** Console output (default console.log). */
  log?(line: string): void
}

/** The step and fact annotations flows record. */
export const FACT_ANNOTATION = "qa"
export const COULD_NOT_CHECK_ANNOTATION = "could-not-check"
export const SKIP_ANNOTATION = "skip"

interface Fact {
  step: string
  key: string
  value: unknown
}

interface StepSummary {
  id: string
  status: "passed" | "failed" | "skipped" | "not run"
  durationMs: number | null
  file: string | null
  line: number | null
  error: string | null
  facts: Record<string, unknown>
}

interface TestSummary {
  project: string
  title: string
  file: string
  line: number
  status: string
  durationMs: number
  error: string | null
  skipReason: string | null
  steps: StepSummary[]
  attachments: { name: string; path: string }[]
}

type VideoSummary =
  | { produced: true; path: string; file: string; durationSec: number }
  | { produced: false; reason: string }

// eslint-disable-next-line no-control-regex -- strips ANSI colour codes
const ANSI = /\u001b\[[0-9;]*m/g

function clean(message: string | undefined): string {
  return (message ?? "").replace(ANSI, "").trim()
}

function firstLine(message: string): string {
  return message.split("\n").find((l) => l.trim() !== "") ?? message
}

function errorText(error: TestError | undefined): string | null {
  if (!error) return null
  return clean(error.message ?? error.value).slice(0, 4000) || "error"
}

function annotationsOf(test: TestCase, result: TestResult) {
  const fromResult = (result as { annotations?: TestCase["annotations"] })
    .annotations
  return fromResult && fromResult.length > 0 ? fromResult : test.annotations
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

function gitShaIn(cwd: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return "unknown"
  }
}

/** What the video needs from one test. */
function recording(result: TestResult): RecordedTest {
  const log = result.attachments.find((a) => a.name === VIDEO_LOG_ATTACHMENT)
  let raw: string | null = log?.body?.toString("utf8") ?? null
  if (raw === null && log?.path) {
    try {
      raw = readFileSync(log.path, "utf8")
    } catch {
      raw = null
    }
  }
  const steps: RecordedStep[] = result.steps
    .filter((s) => s.category === "test.step")
    .map((s) => {
      const { failed, open, durationMs } = stepOutcome(s, result)
      return {
        id: s.title,
        startMs: s.startTime.getTime(),
        durationMs,
        failed,
        // Narration says only its category.
        error: failed
          ? (errorText(s.error) ?? (open ? errorText(result.error) : null))
          : null,
      }
    })
  return {
    status: result.status,
    videoPath:
      result.attachments.find((a) => a.name === "video" && a.path)?.path ??
      null,
    log: parseVideoLog(raw),
    steps,
  }
}

function videoLine(video: VideoSummary): string {
  return video.produced
    ? `video: ${video.path} (${video.durationSec.toFixed(1)}s)`
    : `video: not produced (${video.reason})`
}

function undoJson(undo: UndoSummary) {
  return {
    total: undo.total,
    restored: undo.restored,
    failed: undo.failed,
    pending: undo.pending,
    file: undo.total > 0 ? "undo.md" : null,
    manual: undo.manual.map((e) => ({
      feature: e.feature,
      what: e.what,
      status: e.status,
      error: e.error,
      manual: e.manual,
    })),
  }
}

/**
 * The summary reporter. Writes <results>/<RUN_ID>/summary.{md,json,lines}:
 *
 * - summary.md: for people (verdict, per-step table, latencies, links);
 * - summary.json: for tools (and the demos);
 * - summary.lines: `<file>:<line>: error: [<step id>] <message>` per failed
 *   step, also printed at the end for an editor's problem matcher.
 *
 * Verdict: FAIL if anything failed; N/A if the round-trip test skipped with
 * an "N/A:" reason (or did not run); PASS only when it passed. A tour run
 * (no round trip) takes the tour's verdict (tourVerdict). The reporter
 * reports; it never decides an assertion.
 *
 * After the summary is written it composes the run video (the round trip's,
 * or the tour's per-area and full videos) through the project's composers
 * and rewrites the summary with its link, or with "video: not produced
 * (<reason>)". The verdict is fixed before the video starts and nothing the
 * video does can change it.
 *
 * A stop signal Playwright's runner no longer handles (from onBegin on,
 * after its teardown: while the other reporters finish, or during
 * composition) ends the composition, or skips it: every tool it started is
 * stopped and the summary is rewritten with
 * "video: not produced (video composition stopped (interrupted))". With a
 * pipeline deadline (FLOWREEL_DEADLINE_AT) less than the compose budget
 * away (60 s, FLOWREEL_COMPOSE_BUDGET_SEC), composition is skipped.
 *
 * Before anything else, onEnd makes sure the personas were signed out: when
 * the global teardown did not do it (a second Ctrl-C or a kill cut the
 * teardown short), it waits up to 20 s for pending restores in the run's
 * undo ledger, then runs the sign-out the global setup registered, and says
 * so loudly. The constructor installs the stage guard (installStageGuard)
 * first, so SIGTERM and a vanished pipeline stop the run as Ctrl-C would.
 *
 * summary.json also records the pace the videos were composed at (pace,
 * slowFactor) and the narration ("narration: <voice> (n lines, m
 * synthesized, k cached)" or "not produced (<reason>)"). After a demo-pace
 * run that produced a video, the project's demos publisher is called with
 * { automatic: true } (development runs only, never a FAIL over a PASS).
 *
 * A project uses it by subclassing (Playwright constructs reporters from a
 * path with JSON options, so the functions are bound in the subclass):
 *
 * ```ts
 * export default class extends SummaryReporter {
 *   constructor() { super(projectReporterOptions()) }
 * }
 * ```
 */
export class SummaryReporter implements Reporter {
  private startedAt = new Date()
  private readonly tests = new Map<string, TestSummary>()
  private readonly facts: Fact[] = []
  private readonly couldNotCheck: string[] = []
  private readonly errors: { message: string; location?: Location }[] = []
  private otherFailures = 0
  private ranFlow = false
  private roundTripRecording: RecordedTest | null = null
  private readonly tourFeatures: (TourFeatureRecord & {
    file: string
    line: number
  })[] = []
  private readonly target: string
  private readonly tabulated: Set<string>
  /** Aborted by a stop signal Playwright's runner no longer handles. */
  private readonly stop = new AbortController()
  /** When this reporter first acted on a stop signal (epoch ms). */
  private stoppedAt: number | null = null
  private stopListeners: [NodeJS.Signals, () => void][] = []
  private readonly roundTrip: RoundTripModule
  private readonly tour: TourModule | undefined

  constructor(private readonly options: SummaryReporterOptions) {
    // First: the web server's start and the sign-ins are covered too.
    installStageGuard(process.env, { logPrefix: options.config?.logPrefix })
    const { roundTrip, tour } = modulesByKind(options.modules)
    if (!options.config && !options.resultsDir) {
      throw new Error("SummaryReporter: give `config` or `resultsDir`.")
    }
    this.roundTrip = roundTrip
    this.tour = tour
    this.target = (() => {
      try {
        if (options.configuredTarget) return options.configuredTarget()
      } catch {
        // The environment's target is the fallback.
      }
      return this.envTarget() ?? "local"
    })()
    this.tabulated = new Set([
      ...(options.tabulatedProjects ?? []),
      roundTrip.project,
    ])
  }

  private rel(path: string): string {
    return relative(this.options.repoRoot, path)
  }

  private isFlowProject(project: string): boolean {
    return this.tabulated.has(project) || !!this.tour?.isProject(project)
  }

  private get prefix(): string {
    return `[${this.options.config?.logPrefix ?? DEFAULT_LOG_PREFIX}]`
  }

  private runId(): string {
    return (
      (this.options.runId
        ? this.options.runId()
        : envValue(process.env, "RUN_ID")) ?? "unknown-run"
    )
  }

  private envTarget(): string | undefined {
    return this.options.envTarget
      ? this.options.envTarget()
      : envValue(process.env, "TARGET")
  }

  private resultsDir(runId: string): string {
    if (this.options.resultsDir) return this.options.resultsDir(runId)
    // The constructor checked that one of the two is given.
    return configResultsDir(this.options.config!, runId)
  }

  private reportDir(runId: string): string {
    return this.options.reportDir
      ? this.options.reportDir(runId)
      : join(this.resultsDir(runId), "report")
  }

  private log(line: string): void {
    if (this.options.log) this.options.log(line)
    else console.log(line)
  }

  printsToStdio(): boolean {
    return false
  }

  onBegin(): void {
    this.startedAt = new Date()
    // From here on: after Playwright's teardown its Ctrl-C handling is gone,
    // and the other reporters' onEnd run before this one's.
    this.listenForStops()
  }

  async onExit(): Promise<void> {
    this.stopListening()
  }

  /**
   * Whether a SIGINT is Playwright's runner's to handle right now (a
   * listener other than flowreel's passive ones exists). Protected for
   * tests: a test worker always has a SIGINT listener of its own.
   */
  protected signalOwnedElsewhere(): boolean {
    return process.listeners("SIGINT").some((l) => !isPassive(l))
  }

  /**
   * Listens for stop signals the runner no longer handles (after its
   * teardown): the first ends the video composition (and the sign-out
   * net's wait); a second Ctrl-C a second or more later exits with 130,
   * the escape a Ctrl-C would otherwise be. Idempotent.
   */
  private listenForStops(): void {
    if (this.stopListeners.length > 0) return
    const signals: NodeJS.Signals[] =
      process.platform === "win32"
        ? ["SIGINT", "SIGTERM", "SIGBREAK"]
        : ["SIGINT", "SIGTERM"]
    for (const signal of signals) {
      const listener = markPassive(() => {
        if (this.signalOwnedElsewhere()) return
        const now = Date.now()
        if (
          signal !== "SIGTERM" &&
          this.stoppedAt !== null &&
          now - this.stoppedAt >= 1000
        ) {
          this.log(`${this.prefix} second Ctrl-C: stopping now.`)
          process.exit(130)
          return
        }
        this.stoppedAt ??= now
        this.stop.abort()
      })
      process.on(signal, listener)
      this.stopListeners.push([signal, listener])
    }
  }

  private stopListening(): void {
    for (const [signal, listener] of this.stopListeners.splice(0)) {
      process.off(signal, listener)
    }
  }

  onError(error: TestError): void {
    this.errors.push({
      message: errorText(error) ?? "error",
      location: error.location,
    })
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const project = test.parent.project()?.name ?? ""
    if (!this.isFlowProject(project)) {
      // Any other project: counted toward the verdict, not tabulated, and on
      // its own it leaves no evidence folder.
      if (FAILED_STATUSES.has(result.status)) this.otherFailures += 1
      return
    }
    this.ranFlow = true
    const annotations = annotationsOf(test, result)
    const stepFacts: Fact[] = []
    for (const a of annotations) {
      if (a.type === FACT_ANNOTATION && a.description) {
        try {
          stepFacts.push(JSON.parse(a.description) as Fact)
        } catch {
          // Not ours; ignore.
        }
      } else if (a.type === COULD_NOT_CHECK_ANNOTATION && a.description) {
        this.couldNotCheck.push(a.description)
      }
    }
    this.facts.push(...stepFacts)
    const skip = annotations.find((a) => a.type === SKIP_ANNOTATION)
    const roundTrip = this.roundTrip
    if (project === roundTrip.project) {
      this.roundTripRecording = recording(result)
    }
    const tour = this.tour
    const area = tour ? tour.areaOfProject(project) : null
    if (tour && area) {
      this.recordFeature(
        tour,
        test,
        result,
        area,
        annotations,
        skip?.description ?? null,
      )
    }

    const steps = result.steps
      .filter((s) => s.category === "test.step")
      .map((s): StepSummary => {
        const { failed, open, durationMs } = stepOutcome(s, result)
        const where = s.error ? stepFailureLocation(s) : s.location
        return {
          id: s.title,
          status: failed ? "failed" : "passed",
          durationMs,
          file: where ? this.rel(where.file) : null,
          line: where?.line ?? null,
          error:
            errorText(s.error) ??
            (failed && open
              ? (errorText(result.error) ??
                `did not finish (test ${result.status})`)
              : null),
          facts: Object.fromEntries(
            stepFacts
              .filter((f) => f.step === s.title)
              .map((f) => [f.key, f.value]),
          ),
        }
      })

    if (project === roundTrip.project) {
      // Every plan step appears in the table, run or not.
      const seen = new Set(steps.map((s) => s.id))
      for (const id of this.planStepIds()) {
        if (seen.has(id)) continue
        steps.push({
          id,
          status: result.status === "skipped" ? "skipped" : "not run",
          durationMs: null,
          file: null,
          line: null,
          error: null,
          facts: {},
        })
      }
    }

    this.tests.set(test.id, {
      project,
      title: test.title,
      file: this.rel(test.location.file),
      line: test.location.line,
      status: result.status,
      durationMs: result.duration,
      error: errorText(result.error),
      skipReason: skip?.description ?? null,
      steps,
      attachments: result.attachments
        .filter((a) => a.path)
        .map((a) => ({ name: a.name, path: a.path! })),
    })
  }

  /** Step ids from the plan's table (the plan is the source of truth). */
  private planStepIds(): string[] {
    const module = this.roundTrip
    if (!module.planFile) return []
    try {
      return planStepIds(module, readFileSync(module.planFile, "utf8"))
    } catch {
      return []
    }
  }

  private recordFeature(
    tour: TourModule,
    test: TestCase,
    result: TestResult,
    area: string,
    annotations: TestCase["annotations"],
    skipReason: string | null,
  ): void {
    const parsed = tour.parseFeatureTitle(test.title)
    const annotation = parseFeatureAnnotation(
      annotations.find((a) => a.type === tour.featureAnnotation)?.description,
    )
    // Step titles "<id>.<n> <sentence>" are the video captions.
    for (const step of result.steps.filter((s) => s.category === "test.step")) {
      const parsedStep = tour.parseStepTitle(step.title)
      if (!parsedStep || (parsed && parsedStep.feature !== parsed.id)) {
        this.couldNotCheck.push(
          `${test.title}: step "${step.title}" is not titled "${parsed?.id ?? "<id>"}.<n> <sentence>" (its caption shows the raw title).`,
        )
      }
    }
    const status = featureStatus(
      result.status,
      skipReason,
      annotation,
      this.target,
      tour.devOnlyPrefix,
    )
    const rec = recording(result)
    const ran =
      status === "passed" || status === "failed" || status === "view-only"
    this.tourFeatures.push({
      id: parsed?.id ?? test.title,
      title: parsed?.slug ?? test.title,
      area,
      policy: annotation?.policy ?? null,
      mode: annotation?.mode ?? "full",
      status,
      reason:
        status === "dev-only"
          ? (skipReason ?? "").slice(tour.devOnlyPrefix.length)
          : status === "N/A"
            ? skipReason
            : status === "failed" && !annotation
              ? NO_FEATURE_REASON
              : null,
      durationMs: ran ? result.duration : null,
      recording:
        ran &&
        rec?.videoPath &&
        rec.log &&
        typeof rec.log.videoStartedAt === "number"
          ? { videoPath: rec.videoPath, log: rec.log, steps: rec.steps }
          : null,
      file: this.rel(test.location.file),
      line: test.location.line,
    })
  }

  private verdict(result: FullResult): { verdict: Verdict; reason: string } {
    const tests = [...this.tests.values()]
    const failed = tests.filter((t) => FAILED_STATUSES.has(t.status))
    if (
      result.status !== "passed" ||
      failed.length > 0 ||
      this.errors.length > 0 ||
      this.otherFailures > 0
    ) {
      const what =
        failed.map((t) => `${t.project}: ${t.title}`).join(", ") ||
        (this.errors.length > 0
          ? "setup / runner error"
          : `run ${result.status}`)
      return { verdict: "FAIL", reason: `Failed: ${what}.` }
    }
    // A tour feature that passed without recording its policy is a FAIL
    // whatever else ran (featureStatus).
    const unchecked = this.tourFeatures.filter((f) => f.status === "failed")
    if (unchecked.length > 0) {
      return {
        verdict: "FAIL",
        reason: `Failed: ${unchecked.map((f) => `${f.id} (${NO_FEATURE_REASON})`).join(", ")}.`,
      }
    }
    const roundTrip = this.roundTrip
    const gate = tests.find((t) => t.project === roundTrip.project)
    if (!gate && this.tourFeatures.length > 0) {
      return tourVerdict(this.tourFeatures)
    }
    if (!gate) {
      const tour = this.tour
      return {
        verdict: "N/A",
        reason: tests.some((t) => !!tour?.isProject(t.project))
          ? "No tour feature ran."
          : roundTrip.verdictCopy.notInRun,
      }
    }
    if (gate.status === "skipped") {
      return {
        verdict: "N/A",
        reason: (gate.skipReason ?? roundTrip.verdictCopy.skipped).replace(
          /^N\/A:\s*/,
          "",
        ),
      }
    }
    return { verdict: "PASS", reason: roundTrip.verdictCopy.passed }
  }

  private failureLines(): string[] {
    const lines: string[] = []
    for (const t of this.tests.values()) {
      if (!FAILED_STATUSES.has(t.status)) continue
      const failedSteps = t.steps.filter((s) => s.status === "failed")
      for (const s of failedSteps) {
        lines.push(
          `${s.file ?? t.file}:${s.line ?? t.line}: error: [${s.id}] ${firstLine(s.error ?? "failed")}`,
        )
      }
      if (failedSteps.length === 0) {
        lines.push(
          `${t.file}:${t.line}: error: [${t.project}] ${firstLine(t.error ?? t.status)}`,
        )
      }
    }
    for (const e of this.errors) {
      const where = e.location
        ? `${this.rel(e.location.file)}:${e.location.line}`
        : this.options.setupLocation
      lines.push(`${where}: error: [setup] ${firstLine(e.message)}`)
    }
    return lines
  }

  private redactedConfig(): unknown {
    try {
      return this.options.describeConfig()
    } catch (error) {
      return { unavailable: (error as Error).message }
    }
  }

  async onEnd(
    result: FullResult,
  ): Promise<{ status?: FullResult["status"] } | undefined> {
    // Playwright's own Ctrl-C handling is gone by now: a stop signal during
    // onEnd ends the video composition instead of killing the process
    // (listening since onBegin; here too for a run that never began).
    this.listenForStops()
    try {
      await this.signOutIfNeeded(this.stop.signal)
      return await this.report(result, this.stop.signal)
    } finally {
      this.stopListening()
    }
  }

  /**
   * The sign-out safety net: when the global teardown did not sign the
   * personas out (the run was stopped and its teardown cut short), waits
   * for sign-ins still in flight and for pending restores (up to 20 s each;
   * restores use the sessions), then signs out, loudly. Never throws.
   */
  private async signOutIfNeeded(signal: AbortSignal): Promise<void> {
    const state = runLifecycle()
    if (state.signedOut || !state.signOut) return
    const prefix = this.prefix
    const shareWarning = `sign the personas out on ${this.target} (or wait for the session idle timeout) before sharing anything but summary.md.`
    if (state.signOutRun) {
      // The teardown started signing out and was cut short.
      if (await settleWithin(state.signOutRun, SIGN_OUT_WAIT_MS)) return
      this.log(
        `${prefix} WARNING: the global teardown's sign-out did not finish: ${shareWarning}`,
      )
      return
    }
    this.log(
      `${prefix} WARNING: the global teardown did not sign the personas out (the run was stopped before it could): signing them out now.`,
    )
    if (state.setup) await settleWithin(state.setup, SIGN_OUT_WAIT_MS)
    const runId = this.runId()
    const left = await waitForRestores(
      this.resultsDir(runId),
      runId,
      SIGN_OUT_WAIT_MS,
      signal,
    )
    if (left > 0) {
      this.log(
        `${prefix} ${left} shared-config restore(s) still pending; signing out anyway (undo.md lists them).`,
      )
    }
    const run = state.signOut()
    state.signOutRun = run
    try {
      await run
      state.signedOut = true
    } catch (error) {
      this.log(
        `${prefix} WARNING: the sign-out failed (${error instanceof Error ? error.message : String(error)}): ${shareWarning}`,
      )
    }
  }

  /**
   * Runs one video composition unless it is stopped or skipped: resolves
   * with `skipped(reason)` at once when the stop signal aborted (or when the
   * pipeline's deadline leaves less than the compose budget), or as soon as
   * it aborts during the work, whose tools then stop (withMediaSignal).
   */
  private compose<T>(
    signal: AbortSignal,
    work: () => Promise<T>,
    skipped: (reason: string) => T,
  ): Promise<T> {
    const reason = signal.aborted
      ? COMPOSITION_STOPPED
      : composeSkipReason(
          stageDeadlineAt(process.env),
          Date.now(),
          composeBudgetMs(process.env),
        )
    if (reason) return Promise.resolve(skipped(reason))
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => resolve(skipped(COMPOSITION_STOPPED))
      signal.addEventListener("abort", onAbort, { once: true })
      withMediaSignal(signal, work).then(
        (value) => {
          signal.removeEventListener("abort", onAbort)
          resolve(value)
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort)
          reject(error)
        },
      )
    })
  }

  private async report(
    result: FullResult,
    signal: AbortSignal,
  ): Promise<{ status?: FullResult["status"] } | undefined> {
    // `--list`, empty runs and runs without a tabulated test leave no
    // evidence folder behind.
    if (!this.ranFlow && this.errors.length === 0) return undefined
    const opts = this.options
    const prefix = this.prefix
    const rel = (path: string) => this.rel(path)
    const runId = this.runId()
    const dir = this.resultsDir(runId)
    mkdirSync(dir, { recursive: true })
    const finishedAt = new Date()
    const { verdict, reason } = this.verdict(result)
    const tests = [...this.tests.values()]
    const latencies = Object.fromEntries(
      this.facts
        .filter((f) => f.key.startsWith("latency."))
        .map((f) => [f.key.slice("latency.".length), f.value]),
    )
    const preflightPath = opts.preflightFile
      ? join(dir, opts.preflightFile)
      : null
    const lines = this.failureLines()
    const attachments = tests.flatMap((t) =>
      t.attachments.map((a) => ({
        test: `${t.project}: ${t.title}`,
        name: a.name,
        path: relative(dir, a.path),
      })),
    )
    const config = this.redactedConfig()
    const target =
      (config as { target?: string }).target ?? this.envTarget() ?? "?"
    const isTour = this.tourFeatures.length > 0
    const moduleName =
      isTour && this.tour ? this.tour.name : this.roundTrip.name
    const module = (config as { module?: string }).module ?? moduleName
    // The pace the videos are composed at, recorded here.
    const paced = opts.videoPace(moduleName)
    // Read back what the flows wrote ahead; a pending entry at the end is as
    // unresolved as a FAILED one.
    const undo = summarizeUndo(
      existsSync(join(dir, UNDO_JSON))
        ? fileUndoStore(dir, runId).read()
        : null,
    )
    const features: FeatureRow[] = this.tourFeatures.map((f) => ({
      id: f.id,
      title: f.title,
      area: f.area,
      policy: f.policy,
      status: f.status,
      reason: f.reason,
      durationMs: f.durationMs,
      videoAtSec: null,
      file: f.file,
      line: f.line,
    }))

    const summary = {
      runId,
      target,
      module,
      verdict,
      verdictReason: reason,
      runStatus: result.status,
      startedAt: this.startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      gitSha: opts.gitSha ? opts.gitSha() : gitShaIn(opts.repoRoot),
      config,
      preflight:
        preflightPath && existsSync(preflightPath)
          ? readJson(preflightPath)
          : null,
      tests,
      latenciesMs: latencies,
      couldNotCheck: this.couldNotCheck,
      errors: this.errors.map((e) => e.message),
      attachments,
      htmlReport: rel(join(this.reportDir(runId), "index.html")),
      resultsDir: rel(dir),
      video: {
        produced: false,
        reason: "composition did not finish",
      } as VideoSummary,
      /** The tour's per-feature table (empty for the round trip). */
      features,
      /** Shared-config changes and whether each was put back. */
      undo: undoJson(undo),
      /** Per-area MP4s and the full tour MP4 (tour runs only). */
      tourVideo: null as TourVideoSummary | null,
      /** Video pace ("demo" | "qa") and its slow factor. */
      pace: { pace: paced.pace, slowFactor: paced.slowFactor },
      /** The narration of the videos, or why there is none. */
      narration: (paced.narration.on
        ? { produced: false, reason: "composition did not finish" }
        : {
            produced: false,
            reason: paced.narration.reason,
          }) as NarrationOutcome,
      /** What was copied to the demos folder's latest/. */
      demos: null as PublishOutcome | null,
    }

    const write = () => {
      writeFileSync(
        join(dir, "summary.json"),
        `${JSON.stringify(summary, null, 2)}\n`,
      )
      writeFileSync(
        join(dir, "summary.lines"),
        lines.length > 0 ? `${lines.join("\n")}\n` : "",
      )
      writeFileSync(join(dir, "summary.md"), this.markdown(summary))
    }
    // Written before the video, so a killed or hung composition still leaves
    // the full summary (with "composition did not finish").
    write()
    const gate = tests.find((t) => t.project === this.roundTrip.project)
    /** A composition that did not run: its narration says why too. */
    const notComposed = (why: string) => {
      if (paced.narration.on)
        summary.narration = { produced: false, reason: why }
      return { produced: false as const, reason: why }
    }
    if (isTour) {
      const produceTour = opts.produceTourVideos
      const outcome: TourVideoOutcome = produceTour
        ? await this.compose(
            signal,
            () =>
              produceTour({
                runId,
                target,
                pace: paced.pace,
                dir,
                startedAt: this.startedAt,
                verdict,
                features: this.tourFeatures,
                signal,
              }),
            notComposed,
          )
        : { produced: false, reason: "no tour video composer configured" }
      summary.tourVideo = tourVideoSummary(dir, outcome, rel)
      if (outcome.narration) summary.narration = outcome.narration
      if (outcome.pace) summary.pace = outcome.pace
      if (outcome.produced) {
        for (const row of summary.features) {
          row.videoAtSec = outcome.featureStarts[row.id] ?? null
        }
        summary.video = {
          produced: true,
          path: rel(outcome.tour.path),
          file: relative(dir, outcome.tour.path),
          durationSec: outcome.tour.durationSec,
        }
      } else {
        summary.video = { produced: false, reason: outcome.reason }
      }
      write()
    }
    if (!isTour) {
      const outcome: VideoOutcome = await this.compose(
        signal,
        () =>
          opts.produceVideo({
            module: this.roundTrip.name,
            runId,
            target,
            dir,
            startedAt: this.startedAt,
            verdict,
            verdictReason: reason,
            flow: this.roundTripRecording,
            table: (gate?.steps ?? []).map((step) => ({
              id: step.id,
              status: step.status,
              durationMs: step.durationMs,
            })),
            latenciesMs: latencies,
            signal,
          }),
        notComposed,
      )
      summary.video = videoSummary(dir, outcome, rel)
      if (outcome.narration) summary.narration = outcome.narration
      if (outcome.pace) summary.pace = outcome.pace
    }
    write()
    // A demo-pace run's videos become the latest demos (the publisher
    // decides which runs qualify for automatic publishing).
    if (
      opts.publishDemos &&
      summary.pace.pace === "demo" &&
      summary.video.produced
    ) {
      try {
        summary.demos = opts.publishDemos(dir, { automatic: true })
      } catch (error) {
        summary.demos = {
          published: false,
          reason: error instanceof Error ? error.message : String(error),
        }
      }
      write()
    }

    if (undo.manual.length > 0) {
      this.log(
        `${prefix} UNDO FAILED: ${undo.manual.length} shared-config change(s) were not put back — manual action needed: ${rel(join(dir, "undo.md"))}`,
      )
    }
    for (const line of lines) this.log(line)
    this.log(
      `${prefix} ${verdict}: ${reason} Summary: ${rel(join(dir, "summary.md"))}`,
    )
    this.log(`${prefix} ${videoLine(summary.video)}`)
    this.log(
      `${prefix} pace: ${summary.pace.pace} (slow factor ${summary.pace.slowFactor}); ${narrationLine(summary.narration)}`,
    )
    if (summary.demos) {
      this.log(
        summary.demos.published
          ? `${prefix} demos: ${summary.demos.files.join(", ")} -> ${rel(summary.demos.dir)}/${summary.demos.kept ? ` (kept the passing ${summary.demos.kept.join(", ")})` : ""}`
          : `${prefix} demos: not updated (${summary.demos.reason})`,
      )
    }
    if (summary.tourVideo?.produced) {
      for (const a of summary.tourVideo.areas) {
        this.log(
          `${prefix} area ${a.area} video: ${a.path} (${a.durationSec.toFixed(1)}s)`,
        )
      }
    }
    // A failed restore never changes a verdict, but the run must not exit 0
    // (a pipeline turns this into its undo exit code).
    if (undo.manual.length > 0 && result.status === "passed") {
      return { status: "failed" }
    }
    // A FAIL the runner did not see (a tour feature that skipped feature())
    // must not exit 0 either.
    if (verdict === "FAIL" && result.status === "passed") {
      return { status: "failed" }
    }
    return undefined
  }

  private markdown(s: {
    runId: string
    target: string
    verdict: Verdict
    verdictReason: string
    startedAt: string
    finishedAt: string
    gitSha: string
    config: unknown
    tests: TestSummary[]
    latenciesMs: Record<string, unknown>
    couldNotCheck: string[]
    errors: string[]
    attachments: { test: string; name: string; path: string }[]
    htmlReport: string
    video: VideoSummary
    features: FeatureRow[]
    undo: ReturnType<typeof undoJson>
    tourVideo: TourVideoSummary | null
    pace: PaceRecord
    narration: NarrationOutcome
  }): string {
    const title = this.options.copy?.title ?? "flowreel run"
    const out: string[] = [`# ${title} ${s.runId}: ${s.verdict}`, ""]
    // An unrestored change is listed before anything else.
    if (s.undo.manual.length > 0) {
      out.push(
        "## UNDO FAILED: manual action needed",
        "",
        `${s.undo.manual.length} change(s) to shared configuration were not put back. Full instructions: [undo.md](undo.md).`,
        "",
        ...s.undo.manual.map(
          (e) =>
            `- **${cell(e.what)}** (${e.feature}, ${e.status}): ${cell(e.manual)}`,
        ),
        "",
      )
    }
    out.push(
      `**Verdict:** ${s.verdict}. ${s.verdictReason}`,
      "",
      "| | |",
      "|---|---|",
      `| Target | ${cell(s.target)} |`,
      `| Git SHA | ${cell(s.gitSha)} |`,
      `| Started | ${s.startedAt} |`,
      `| Finished | ${s.finishedAt} |`,
      `| Video | ${
        s.video.produced
          ? `[${s.video.file}](${encodeURI(s.video.file)}) (${s.video.durationSec.toFixed(1)}s)`
          : cell(`video: not produced (${s.video.reason})`)
      } |`,
      `| Pace | ${s.pace.pace} (slow factor ${s.pace.slowFactor}) |`,
      `| Narration | ${cell(narrationLine(s.narration).replace(/^narration: /, ""))} |`,
      "",
    )
    if (s.features.length > 0) {
      out.push(...featureTable(s.features, s.tourVideo), "")
      if (s.undo.total > 0 && s.undo.manual.length === 0) {
        out.push(
          `**Undo:** ${s.undo.total} shared-config change(s), all restored ([undo.md](undo.md)).`,
          "",
        )
      }
    }
    for (const t of s.tests) {
      out.push(
        `## ${t.project}: ${t.title} (${t.status}, ${duration(t.durationMs)})`,
        "",
      )
      if (t.skipReason) out.push(`Skipped: ${t.skipReason}`, "")
      if (t.steps.length > 0) {
        out.push("| Step | Status | Duration | Facts |", "|---|---|---|---|")
        for (const step of t.steps) {
          const facts = Object.entries(step.facts)
            .map(([k, v]) => `${k}=${cell(v)}`)
            .join("; ")
          out.push(
            `| ${cell(step.id)} | ${step.status} | ${duration(step.durationMs)} | ${facts || ""} |`,
          )
        }
        out.push("")
      }
      const errors = t.steps.filter((step) => step.error)
      for (const step of errors) {
        out.push(
          `**${step.id}** failed:`,
          "",
          "```",
          step.error ?? "",
          "```",
          "",
        )
      }
      if (errors.length === 0 && t.error) {
        out.push("**Error:**", "", "```", t.error, "```", "")
      }
    }
    if (s.errors.length > 0) {
      out.push(
        "## Runner errors",
        "",
        ...s.errors.map((e) => `- ${cell(e)}`),
        "",
      )
    }
    const latencies = Object.entries(s.latenciesMs)
    out.push("## Hop latencies", "")
    out.push(
      ...(latencies.length > 0
        ? latencies.map(([k, v]) => `- ${k}: ${duration(Number(v))}`)
        : ["- none recorded"]),
      "",
    )
    out.push("## Could not check", "")
    out.push(
      ...(s.couldNotCheck.length > 0
        ? s.couldNotCheck.map((c) => `- ${c}`)
        : ["- nothing"]),
      "",
    )
    out.push("## Evidence", "", `- HTML report: \`${s.htmlReport}\``)
    for (const a of s.attachments) {
      out.push(`- ${a.test}, ${a.name}: [${a.path}](${encodeURI(a.path)})`)
    }
    out.push(
      "",
      "Open a trace with `npx playwright show-trace <path>`.",
      "",
      "## Configuration (redacted)",
      "",
      "```json",
      JSON.stringify(s.config, null, 2),
      "```",
      "",
    )
    return out.join("\n")
  }
}

function videoSummary(
  dir: string,
  outcome: VideoOutcome,
  rel: (path: string) => string,
): VideoSummary {
  // Not produced: the outcome as it came (its narration and pace included).
  if (!outcome.produced) return outcome
  return {
    produced: true,
    path: rel(outcome.path),
    file: relative(dir, outcome.path),
    durationSec: outcome.durationSec,
  }
}

function tourVideoSummary(
  dir: string,
  outcome: TourVideoOutcome,
  rel: (path: string) => string,
): TourVideoSummary {
  if (!outcome.produced) return outcome
  const entry = (path: string, durationSec: number) => ({
    path: rel(path),
    file: relative(dir, path),
    durationSec,
  })
  return {
    produced: true,
    tour: entry(outcome.tour.path, outcome.tour.durationSec),
    areas: outcome.areas.map((a) => ({
      area: a.area,
      ...entry(a.path, a.durationSec),
    })),
  }
}
