// SPDX-License-Identifier: Apache-2.0

import { type Env, envValue } from "./env.js"

// The time a video composition is given before a pipeline's deadline
// (FLOWREEL_DEADLINE_AT in a stage, the --deadline in the pipeline). Less
// than this left and the composition is skipped, so a CI's hard kill never
// lands in the middle of it. Internal: not exported from the core barrel.

/** The default compose budget: 60 seconds. */
export const DEFAULT_COMPOSE_BUDGET_SEC = 60

/**
 * The compose budget in milliseconds: FLOWREEL_COMPOSE_BUDGET_SEC (a
 * non-negative number of seconds) or 60 s. An unreadable value is the
 * default. Pure.
 */
export function composeBudgetMs(env: Env): number {
  const raw = envValue(env, "COMPOSE_BUDGET_SEC")
  const seconds = raw === undefined ? Number.NaN : Number(raw)
  return (
    (Number.isFinite(seconds) && seconds >= 0
      ? seconds
      : DEFAULT_COMPOSE_BUDGET_SEC) * 1000
  )
}

/**
 * The stage's deadline from FLOWREEL_DEADLINE_AT (epoch ms, set by the
 * pipeline), or null when unset or unreadable. Pure.
 */
export function stageDeadlineAt(env: Env): number | null {
  const raw = envValue(env, "DEADLINE_AT")
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return null
  return Number(raw.trim())
}

/**
 * Why a composition should be skipped for lack of time before the deadline,
 * or null when there is time (or no deadline). Pure.
 */
export function composeSkipReason(
  deadlineAt: number | null,
  nowMs: number,
  budgetMs: number,
): string | null {
  if (deadlineAt === null) return null
  return deadlineAt - nowMs < budgetMs
    ? "skipped: not enough time before the deadline"
    : null
}
