// SPDX-License-Identifier: Apache-2.0

// The development -> staging gate, pure and unit-tested.
//
//   development  the local target (a fresh test server, test seams)
//   staging      the staging target; runs ONLY after a development PASS
//                (or with --staging-only)
//
// Exit codes reflect only the stages that ran: 0 every stage that ran
// passed; 1 any FAIL; 2 development passed but staging is not configured;
// 3 a stage that ran was N/A (nothing verified); 4 a shared-config change
// could not be put back (the undo ledger: manual action needed; it outranks
// every other code). 130 = stopped (Ctrl-C, a CI's stop signal or the
// --deadline) before every stage that would have run did, or aborted by a
// second Ctrl-C. 64 = bad arguments.

export type StageName = "development" | "staging"
export const STAGES: StageName[] = ["development", "staging"]

/** A stage that ran has its run verdict; the rest say why they did not. */
export type StageVerdict =
  "PASS" | "FAIL" | "N/A" | "not run" | "not configured" | "skipped"

export type PipelineVerdict = "PASS" | "FAIL" | "N/A" | "INCOMPLETE"

export interface StageResult {
  stage: StageName
  verdict: StageVerdict
  reason: string
  /** Shared-config changes the stage could not put back. */
  undoFailed?: number
}

export const EXIT = {
  pass: 0,
  fail: 1,
  notConfigured: 2,
  notApplicable: 3,
  undoFailed: 4,
  usage: 64,
  interrupted: 130,
} as const

/**
 * Why the pipeline stopped starting stages: a stop signal (Ctrl-C, a CI's
 * SIGTERM) or the --deadline.
 */
export type StopCause = "interrupted" | "deadline"

/** The reason a stage records when the pipeline stopped before it. */
export const STOP_REASONS: Readonly<Record<StopCause, string>> = {
  interrupted: "not run (interrupted)",
  deadline: "not run (deadline reached)",
}

/**
 * The reason the running stage records when a second Ctrl-C aborted the
 * pipeline without waiting for the stage's report.
 */
export const ABORTED_REASON = "aborted by a second Ctrl-C"

/** `true` (the earlier boolean form) reads as "interrupted". */
function stopCause(stopped: boolean | StopCause): StopCause | null {
  if (stopped === true) return "interrupted"
  return stopped === false ? null : stopped
}

/**
 * Whether development runs at all: not with --staging-only, and not once
 * the pipeline was stopped (a signal or the deadline before it started).
 */
export function developmentDecision(
  options: {
    stagingOnly: boolean
  },
  stopped: boolean | StopCause = false,
): { run: true } | { run: false; result: StageResult } {
  const cause = stopCause(stopped)
  if (cause && !options.stagingOnly) {
    return {
      run: false,
      result: {
        stage: "development",
        verdict: "not run",
        reason: STOP_REASONS[cause],
      },
    }
  }
  if (!options.stagingOnly) return { run: true }
  return {
    run: false,
    result: {
      stage: "development",
      verdict: "skipped",
      reason: "skipped (--staging-only)",
    },
  }
}

/**
 * The gate: staging runs only after a development PASS. `configProblem` is
 * the staging config error (null = configured); it is only looked at once
 * staging would otherwise run. `stopped` (a stop signal, `true` or
 * "interrupted", or "deadline") means no further stage starts.
 */
export function stagingDecision(
  options: { local: boolean; stagingOnly: boolean },
  development: StageResult,
  configProblem: string | null,
  stopped: boolean | StopCause = false,
): { run: true } | { run: false; result: StageResult } {
  const skip = (verdict: StageVerdict, reason: string) => ({
    run: false as const,
    result: { stage: "staging" as const, verdict, reason },
  })
  if (options.local) return skip("skipped", "skipped (--local)")
  const cause = stopCause(stopped)
  if (cause) return skip("not run", STOP_REASONS[cause])
  if (!options.stagingOnly && development.verdict !== "PASS") {
    return skip("not run", `not run (development ${development.verdict})`)
  }
  if (configProblem) return skip("not configured", configProblem)
  return { run: true }
}

/**
 * The staging config problem as the pipeline records it: the missing keys
 * when that is the error (requireKeys names keys, never values), else the
 * error's first line.
 */
export function configProblemOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const missing = /Missing required \S+ config: ([^.]+)\./.exec(message)
  if (missing) return `missing ${missing[1].trim()}`
  return (message.split("\n")[0] ?? message).slice(0, 300)
}

/**
 * How a stage reads in the log and pipeline.md: the reason alone when it
 * already starts with the verdict ("skipped (--local)", "not run
 * (interrupted)"), else "<verdict> (<reason>)", or the bare verdict.
 */
export function stageLabel(result: Pick<StageResult, "verdict" | "reason">) {
  const reason = result.reason.trim()
  if (!reason || reason === result.verdict) return result.verdict
  return reason.startsWith(result.verdict)
    ? reason
    : `${result.verdict} (${reason})`
}

/**
 * The pipeline's verdict, reason and exit code from the stages' results.
 *
 * Exit codes count only the stages that ran: 0 every one passed, 1 any
 * FAIL, 2 development passed but staging is not configured, 3 a stage that
 * ran was N/A, 130 a stop (Ctrl-C, a CI's stop signal, the --deadline)
 * before a stage that would have run, or a second Ctrl-C that aborted the
 * running stage; 4 (a shared-config change was not put back: manual action
 * needed) outranks them all, and the reason then starts with "UNDO
 * FAILED". Pure.
 */
export function pipelineOutcome(stages: StageResult[]): {
  verdict: PipelineVerdict
  reason: string
  exitCode: number
} {
  const outcome = verdictOutcome(stages)
  // A change that was not put back outranks every verdict.
  const undo = stages.filter((s) => (s.undoFailed ?? 0) > 0)
  if (undo.length === 0) return outcome
  return {
    verdict: outcome.verdict,
    reason: `UNDO FAILED, manual action needed (${undo
      .map((s) => `${s.stage}: ${s.undoFailed} change(s), see its undo.md`)
      .join("; ")}). ${outcome.reason}`,
    exitCode: EXIT.undoFailed,
  }
}

/** How a stopped stage reads in the pipeline's reason, or null. */
function stopWording(stage: StageResult): string | null {
  if (stage.verdict !== "not run") return null
  if (stage.reason === STOP_REASONS.interrupted) return "interrupted before"
  if (stage.reason === STOP_REASONS.deadline) return "deadline reached before"
  if (stage.reason === ABORTED_REASON) return `${ABORTED_REASON} during`
  return null
}

function verdictOutcome(stages: StageResult[]): {
  verdict: PipelineVerdict
  reason: string
  exitCode: number
} {
  const ran = stages.filter((s) =>
    (["PASS", "FAIL", "N/A"] as StageVerdict[]).includes(s.verdict),
  )
  const named = (list: StageResult[]) => list.map((s) => s.stage).join(", ")
  const failed = ran.filter((s) => s.verdict === "FAIL")
  if (failed.length > 0) {
    return {
      verdict: "FAIL",
      reason: `${named(failed)} failed.`,
      exitCode: EXIT.fail,
    }
  }
  const na = ran.filter((s) => s.verdict === "N/A")
  if (na.length > 0) {
    return {
      verdict: "N/A",
      reason: `${named(na)} N/A: nothing was verified there.`,
      exitCode: EXIT.notApplicable,
    }
  }
  // Stopped before (or, by a second Ctrl-C, during) a stage that would
  // have run: never a PASS.
  const stopped = stages
    .map((s) => ({ stage: s.stage, what: stopWording(s) }))
    .find((s) => s.what !== null)
  if (stopped) {
    const what = `${stopped.what} ${stopped.stage}`
    return {
      verdict: "INCOMPLETE",
      reason:
        ran.length > 0
          ? `${named(ran)} passed; ${what}.`
          : `${what[0].toUpperCase()}${what.slice(1)}.`,
      exitCode: EXIT.interrupted,
    }
  }
  const notConfigured = stages.find((s) => s.verdict === "not configured")
  if (notConfigured) {
    return {
      verdict: "INCOMPLETE",
      reason:
        ran.length > 0
          ? `${named(ran)} passed; staging not configured (${notConfigured.reason}).`
          : `Staging not configured (${notConfigured.reason}).`,
      exitCode: EXIT.notConfigured,
    }
  }
  if (ran.length === 0) {
    // Not reachable from the CLI (some stage always runs or is not
    // configured), but never call nothing a PASS.
    return {
      verdict: "N/A",
      reason: "No stage ran.",
      exitCode: EXIT.notApplicable,
    }
  }
  return {
    verdict: "PASS",
    reason: `${named(ran)} passed.`,
    exitCode: EXIT.pass,
  }
}

/**
 * A finished stage's verdict from its summary.json and the child's exit
 * code. No summary (the run died before the reporter wrote one) is a FAIL,
 * and so is a PASS summary from a child that exited non-zero.
 *
 * Unrestored shared-config changes come from the summary's `undo` block;
 * when the summary is missing or has none (the child crashed, was killed,
 * or the reporter threw before writing it), from `ledgerManual`: the count
 * of entries in the run's own write-ahead undo ledger still `pending` or
 * `FAILED`. That file is written BEFORE each change exactly for this case,
 * so a dead run still exits 4.
 */
export function stageVerdictFrom(
  stage: StageName,
  summary: {
    verdict?: unknown
    verdictReason?: unknown
    undo?: { manual?: unknown }
  } | null,
  exitCode: number | null,
  ledgerManual = 0,
): StageResult {
  const undoFailed = Array.isArray(summary?.undo?.manual)
    ? summary.undo.manual.length
    : ledgerManual
  const result = stageVerdictOnly(stage, summary, exitCode, undoFailed > 0)
  return undoFailed > 0 ? { ...result, undoFailed } : result
}

function stageVerdictOnly(
  stage: StageName,
  summary: { verdict?: unknown; verdictReason?: unknown } | null,
  exitCode: number | null,
  undoFailed: boolean,
): StageResult {
  const verdict = summary?.verdict
  if (verdict !== "PASS" && verdict !== "FAIL" && verdict !== "N/A") {
    return {
      stage,
      verdict: "FAIL",
      reason: `no summary written (playwright exited ${exitCode ?? "by signal"})`,
    }
  }
  const reason =
    typeof summary?.verdictReason === "string" ? summary.verdictReason : ""
  // A failed restore exits the run non-zero without touching the verdict.
  if (verdict === "PASS" && exitCode !== 0 && !(undoFailed && exitCode === 1)) {
    return {
      stage,
      verdict: "FAIL",
      reason: `playwright exited ${exitCode ?? "by signal"} after a PASS summary`,
    }
  }
  return { stage, verdict, reason }
}
