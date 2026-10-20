// SPDX-License-Identifier: Apache-2.0

import { STATE_ENV_PREFIX } from "../app/personas.js"
import { type Env, envNames } from "../core/env.js"

import type { StageName } from "./decisions.js"
import type { PipelineOptions } from "./options.js"

// A clean environment for one stage's child process. The pipeline decides
// the target, run id, module and (on request) pace, narration and video of
// each stage, so whatever the shell holds under those names (FLOWREEL_<KEY>
// or a project alias) never reaches a child; persona sessions are never
// inherited (the child's global setup makes its own); and the staging
// secrets reach ONLY the staging stage (a password injected for staging
// must not reach the local run, where process env overrides its defaults).
//
// A value is written under the project's preferred name: its first
// registered alias, else FLOWREEL_<KEY> (so a child that reads its own
// legacy names directly keeps working).

/** The name a value is written under: the first alias, else FLOWREEL_<KEY>. */
export function preferredEnvName(key: string): string {
  const names = envNames(key)
  return names[1] ?? names[0]
}

/**
 * The project's part of {@link stageEnv}: which inherited variables are
 * staging secrets, and which prefixes carry persona sessions. Part of the
 * PipelineSpec.
 */
export interface StageEnvSpec {
  /** True for a staging secret or staging targeting variable. */
  isSecret(name: string): boolean
  /** Extra prefixes of persona-session handoff variables (FLOWREEL_STATE_ always). */
  statePrefixes?: readonly string[]
}

/**
 * The keys the pipeline sets per stage: never inherited. PIPELINE_PID, HUP
 * and DEADLINE_AT tell the stage guard (installStageGuard) about the
 * pipeline; DEADLINE is the pipeline's own setting, never a stage's.
 */
const CONTROLLED_KEYS = [
  "TARGET",
  "RUN_ID",
  "MODULE",
  "DB_KEY",
  "PIPELINE_PID",
  "HUP",
  "DEADLINE",
  "DEADLINE_AT",
]

/**
 * What the pipeline tells each stage about itself (for the stage guard,
 * installStageGuard): its process id, whether a hangup should stop the
 * stage gracefully (the pipeline runs in a terminal), and its deadline.
 */
export interface StagePipelineEnv {
  /** Written as PIPELINE_PID: the stage stops when this process is gone. */
  pipelinePid?: number
  /** Written as HUP=graceful: a SIGHUP stops the stage as Ctrl-C would. */
  gracefulHangup?: boolean
  /** Written as DEADLINE_AT (epoch ms): the stage budgets its video by it. */
  deadlineAt?: number | null
}

/**
 * A clean environment for one stage's child process, built by the pipeline
 * runner for each stage it starts.
 *
 * Starts from `base` (the operator's shell) and drops: every name
 * (FLOWREEL_<KEY> and every project alias) of the keys the pipeline pins
 * per stage (target, run id, module, DB key, and pace / narration / video
 * when the options set them), persona-session handoff variables
 * (FLOWREEL_STATE_* and `spec.statePrefixes`), and, for the development
 * stage, every staging secret (`spec.isSecret`, the secrets-file and
 * base-URL keys), so a password injected for staging never reaches the
 * local run. Then writes the stage's values under each key's preferred
 * name, a 300 ms slowMo when headed and none is set, `pipeline` (the
 * pipeline's pid, hangup mode and deadline, for the stage guard) and, for
 * the development stage only, `extra` (its database copy). Pure: `base` is
 * not modified.
 */
export function stageEnv(
  stage: StageName,
  runId: string,
  base: Env,
  options: Pick<PipelineOptions, "headed" | "video"> &
    Partial<Pick<PipelineOptions, "module" | "pace" | "narration">>,
  spec: StageEnvSpec,
  /** The development stage's database copy (DbIsolation's env). */
  extra: Record<string, string> = {},
  /** The module when options carry none. */
  defaultModule = "",
  /** What the stage guard learns about the pipeline. */
  pipeline: StagePipelineEnv = {},
): Record<string, string> {
  const controlled = new Set(CONTROLLED_KEYS.flatMap((key) => envNames(key)))
  const statePrefixes = [STATE_ENV_PREFIX, ...(spec.statePrefixes ?? [])]
  // The secrets file and flowreel's default base-URL key are staging-only
  // too, whatever the project's own rule says.
  const secrets = new Set([...envNames("ENV_FILE"), ...envNames("BASE_URL")])
  const isHarness = (name: string) =>
    controlled.has(name) || statePrefixes.some((p) => name.startsWith(p))
  const isSecret = (name: string) => secrets.has(name) || spec.isSecret(name)

  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || isHarness(key)) continue
    if (stage !== "staging" && isSecret(key)) continue
    env[key] = value
  }
  /** Removes every name of `key`, then writes the preferred one. */
  const set = (key: string, value: string) => {
    for (const name of envNames(key)) delete env[name]
    env[preferredEnvName(key)] = value
  }
  set("TARGET", stage === "staging" ? "staging" : "local")
  set("RUN_ID", runId)
  set("MODULE", options.module ?? defaultModule)
  if (options.pace) set("PACE", options.pace)
  if (options.narration) set("NARRATION", options.narration)
  // FLOWREEL_VIDEO=on from the shell must not override --no-video.
  if (!options.video) set("VIDEO", "off")
  if (
    options.headed &&
    !envNames("SLOW_MO").some((n) => env[n] !== undefined)
  ) {
    env[preferredEnvName("SLOW_MO")] = "300"
  }
  if (pipeline.pipelinePid !== undefined) {
    set("PIPELINE_PID", String(pipeline.pipelinePid))
  }
  if (pipeline.gracefulHangup) set("HUP", "graceful")
  if (typeof pipeline.deadlineAt === "number") {
    set("DEADLINE_AT", String(Math.round(pipeline.deadlineAt)))
  }
  if (stage === "development") Object.assign(env, extra)
  return env
}
