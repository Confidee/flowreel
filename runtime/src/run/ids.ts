// SPDX-License-Identifier: Apache-2.0

import { agreedEnvValue } from "../config/source.js"
import type { TargetName } from "../config/targets.js"
import { type Env, envName } from "../core/env.js"
import { ConfigError } from "../core/errors.js"

// Run identity. One RUN_ID per Playwright run ("loc-…" / "stg-…"), one
// PIPELINE_ID per development -> staging pipeline ("pipe-…"), all
// "<prefix>-YYYYMMDD-HHMM-xxxx" (UTC, four random hex digits). The runner
// process sets FLOWREEL_RUN_ID (or the project's alias) before workers
// start, so workers and the reporter share it.

export interface RunIdPrefixes {
  local: string
  staging: string
  pipeline: string
}

export const DEFAULT_RUN_ID_PREFIXES: RunIdPrefixes = {
  local: "loc",
  staging: "stg",
  pipeline: "pipe",
}

/** "<prefix>-YYYYMMDD-HHMM-xxxx" (UTC, four random hex digits). */
export function stampedId(
  prefix: string,
  now: Date = new Date(),
  random: () => number = Math.random,
): string {
  const iso = now.toISOString() // 2026-10-13T09:05:00.000Z
  const date = iso.slice(0, 10).replaceAll("-", "")
  const time = iso.slice(11, 16).replace(":", "")
  const suffix = Math.floor(random() * 0x10000)
    .toString(16)
    .padStart(4, "0")
  return `${prefix}-${date}-${time}-${suffix}`
}

/** "stg-…" for a staging run, "loc-…" for a local one. */
export function makeRunId(
  target: TargetName,
  now: Date = new Date(),
  random: () => number = Math.random,
  prefixes: RunIdPrefixes = DEFAULT_RUN_ID_PREFIXES,
): string {
  return stampedId(
    target === "staging" ? prefixes.staging : prefixes.local,
    now,
    random,
  )
}

/** "pipe-…": one development -> staging pipeline. */
export function makePipelineId(
  now: Date = new Date(),
  random: () => number = Math.random,
  prefixes: RunIdPrefixes = DEFAULT_RUN_ID_PREFIXES,
): string {
  return stampedId(prefixes.pipeline, now, random)
}

/**
 * When the run started (epoch ms, from its stamp), or null for an id that
 * is not "<prefix>-YYYYMMDD-HHMM-xxxx".
 */
export function runStartOf(runId: string): number | null {
  const m = /^[a-z]+-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})-[0-9a-f]{4}$/.exec(
    runId,
  )
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null
}

export interface CurrentRunIdOptions {
  /** The variable named when it is unset (default: FLOWREEL_RUN_ID). */
  label?: string
  /** What sets it (default: "the Playwright config must set it before workers start"). */
  hint?: string
}

/**
 * The run id shared by runner, workers and reporter. Two names of RUN_ID
 * set to different ids are refused (agreedEnvValue): evidence must never
 * split across two run folders.
 */
export function currentRunId(
  env: Env = process.env,
  options: CurrentRunIdOptions = {},
): string {
  const id = agreedEnvValue(env, "RUN_ID")
  if (!id) {
    throw new ConfigError(
      `${options.label ?? envName(env, "RUN_ID")} is not set; ${options.hint ?? "the Playwright config must set it before workers start"}.`,
    )
  }
  return id
}
