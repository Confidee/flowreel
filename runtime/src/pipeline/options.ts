// SPDX-License-Identifier: Apache-2.0

import type { Pace } from "../tour/policy.js"

// The pipeline command's arguments. Which modules exist, which of them are
// tours (taking --area / --pace / --keep-db) and the usage text come from
// the project's PipelineSpec; the flags themselves are flowreel's.

/**
 * The pipeline command's parsed arguments (flowreel's flags; the modules
 * are the project's), as {@link parsePipelineArgs} returns them and the
 * runner, stageEnv and the project's PipelineSpec.projects read them.
 */
export interface PipelineOptions<M extends string = string> {
  module: M
  /** --local: the development stage only. */
  local: boolean
  /** --staging-only: skip development (and so the gate). */
  stagingOnly: boolean
  /** --headed: both stages headed (a slowMo unless one is set). */
  headed: boolean
  /** --no-video turns every video off (stages and combined). */
  video: boolean
  /** Tours: --area A,C (null = every area). */
  areas: string[] | null
  /** Tours: --pace demo|qa (null = the tour's default). */
  pace: Pace | null
  /** Tours: --keep-db keeps the development stage's database copy. */
  keepDb: boolean
  /** --narration on|off (null = the default for the pace). */
  narration: "on" | "off" | null
  /**
   * --deadline (or FLOWREEL_DEADLINE): when the pipeline stops starting and
   * running stages (null = no deadline). See {@link parseDeadline}.
   */
  deadline: Deadline | null
  help: boolean
}

/**
 * A pipeline deadline: a duration from the pipeline's start, or an
 * absolute time. `label` is the value as given, for the log.
 */
export type Deadline =
  | { kind: "in"; ms: number; label: string }
  | { kind: "at"; epochMs: number; label: string }

/** Plain numbers from this value on are epoch milliseconds (2001-09-09). */
const EPOCH_MS_FROM = 1e12

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
}

/**
 * Parses a pipeline deadline: a duration from the pipeline's start (`90s`,
 * `25m`, `1.5h`, `500ms`, or plain milliseconds such as `90000`), or an
 * absolute time, as an ISO 8601 time with a zone
 * (`2026-10-19T12:30:00Z`, `…+02:00`) or epoch milliseconds (a plain number
 * of 13 digits or more). Throws a {@link UsageError} naming `source` (the
 * flag or the variable) for anything else, a zero or negative duration, or
 * an ISO time without a zone. Pure.
 */
export function parseDeadline(raw: string, source = "--deadline"): Deadline {
  const value = raw.trim()
  const label = value
  const duration = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(value)
  if (duration) {
    const amount = Number(duration[1])
    const unit = (duration[2] ?? "ms").toLowerCase()
    if (!duration[2] && amount >= EPOCH_MS_FROM) {
      return { kind: "at", epochMs: Math.round(amount), label }
    }
    const ms = Math.round(amount * UNIT_MS[unit])
    if (ms <= 0) {
      throw new UsageError(`${source} must be more than zero (got "${raw}").`)
    }
    return { kind: "in", ms, label }
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
      throw new UsageError(
        `${source} needs a zone on an ISO time (e.g. ${value}Z or ${value}+02:00).`,
      )
    }
    const epochMs = Date.parse(value)
    if (Number.isFinite(epochMs)) return { kind: "at", epochMs, label }
  }
  throw new UsageError(
    `${source} needs a duration from the start (90s, 25m, 1h, or milliseconds) or a time (an ISO time with a zone, or epoch milliseconds); got "${raw}".`,
  )
}

/** The deadline's epoch milliseconds for a pipeline that started at `startMs`. */
export function deadlineAt(deadline: Deadline, startMs: number): number {
  return deadline.kind === "in" ? startMs + deadline.ms : deadline.epochMs
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UsageError"
  }
}

/** What the argument parser needs from the project. */
export interface PipelineArgsSpec<M extends string> {
  modules: readonly M[]
  /** The module when --module is not given. */
  defaultModule: M
  /** Modules that accept --area / --pace / --keep-db. */
  tourModules: readonly M[]
  /** Parses --area; throws with the message to show. */
  parseAreas(raw: string): string[]
  /** Parses --pace; throws with the message to show. */
  parsePace(raw: string): Pace
  /** How --area is described in its "needs" error (default "letters"). */
  areaNoun?: string
  /** An --area example (default "A,C"). */
  areaExample?: string
}

/**
 * Parses the pipeline command's arguments against the project's modules.
 *
 * Throws a {@link UsageError} (the runner prints it with the usage and
 * exits 64) for an unknown flag or a stray argument, a missing or unknown
 * value, a value on a flag that takes none, --local with --staging-only,
 * or a tour-only flag (--area, --pace, --keep-db) on a module that is not
 * a tour; the project's parseAreas / parsePace word their own refusals.
 * `--deadline` is parsed by {@link parseDeadline} (FLOWREEL_DEADLINE, its
 * fallback, is read by the runner).
 * `--help` / `-h` sets `help`.
 */
export function parsePipelineArgs<M extends string>(
  argv: string[],
  spec: PipelineArgsSpec<M>,
): PipelineOptions<M> {
  const options: PipelineOptions<M> = {
    module: spec.defaultModule,
    local: false,
    stagingOnly: false,
    headed: false,
    video: true,
    areas: null,
    pace: null,
    keepDb: false,
    narration: null,
    deadline: null,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const [flag, inline] = arg.startsWith("--")
      ? (arg.split(/=(.*)/s, 2) as [string, string | undefined])
      : [arg, undefined]
    const noValue = () => {
      if (inline !== undefined) {
        throw new UsageError(`${flag} takes no value.`)
      }
    }
    switch (flag) {
      case "--module": {
        const value = inline ?? argv[++i]
        if (!value || value.startsWith("--")) {
          throw new UsageError(
            `--module needs a name (e.g. --module ${spec.defaultModule}).`,
          )
        }
        if (!(spec.modules as readonly string[]).includes(value)) {
          throw new UsageError(
            `Unknown module "${value}". Known: ${spec.modules.join(", ")}.`,
          )
        }
        options.module = value as M
        break
      }
      case "--local":
        noValue()
        options.local = true
        break
      case "--staging-only":
        noValue()
        options.stagingOnly = true
        break
      case "--headed":
        noValue()
        options.headed = true
        break
      case "--no-video":
        noValue()
        options.video = false
        break
      case "--area": {
        const value = inline ?? argv[++i]
        if (!value || value.startsWith("--")) {
          throw new UsageError(
            `--area needs ${spec.areaNoun ?? "letters"} (e.g. --area ${spec.areaExample ?? "A,C"}).`,
          )
        }
        try {
          options.areas = spec.parseAreas(value)
        } catch (error) {
          throw new UsageError((error as Error).message)
        }
        break
      }
      case "--pace": {
        const value = inline ?? argv[++i]
        if (!value || value.startsWith("--")) {
          throw new UsageError("--pace needs demo or qa.")
        }
        try {
          options.pace = spec.parsePace(value)
        } catch (error) {
          throw new UsageError((error as Error).message)
        }
        break
      }
      case "--keep-db":
        noValue()
        options.keepDb = true
        break
      case "--narration": {
        const value = (inline ?? argv[++i] ?? "").trim().toLowerCase()
        if (value !== "on" && value !== "off") {
          throw new UsageError("--narration needs on or off.")
        }
        options.narration = value
        break
      }
      case "--deadline": {
        const value = inline ?? argv[++i]
        if (!value || value.startsWith("--")) {
          throw new UsageError(
            "--deadline needs a duration or a time (e.g. --deadline 25m).",
          )
        }
        options.deadline = parseDeadline(value)
        break
      }
      case "--help":
      case "-h":
        options.help = true
        break
      default:
        throw new UsageError(`Unknown argument "${arg}".`)
    }
  }
  if (options.local && options.stagingOnly) {
    throw new UsageError("--local and --staging-only exclude each other.")
  }
  if (
    !(spec.tourModules as readonly string[]).includes(options.module) &&
    (options.areas || options.pace || options.keepDb)
  ) {
    throw new UsageError(
      `--area, --pace and --keep-db apply to --module ${spec.tourModules.join(" or ")} only.`,
    )
  }
  return options
}
