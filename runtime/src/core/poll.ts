// SPDX-License-Identifier: Apache-2.0

import { TimeoutError } from "./errors.js"

export interface PollOptions {
  /** What is being awaited, for the TimeoutError message. */
  waitingFor: string
  timeoutMs: number
  /** First delay; doubles each attempt up to maxIntervalMs. Default 1000. */
  initialIntervalMs?: number
  /** Default 5000. */
  maxIntervalMs?: number
  /** Injectable for unit tests. */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/**
 * Polls `attempt` until it returns a non-undefined value. `attempt` returns
 * `{ value }` on success or `{ observed }` (a short description of the
 * current state, used in the timeout message) when not yet satisfied.
 * Exceptions thrown by `attempt` propagate immediately (no retry): a failed
 * HTTP call is a real failure, not a "not yet".
 */
export async function poll<T>(
  attempt: () => Promise<{ value: T } | { observed: string }>,
  options: PollOptions,
): Promise<T> {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const now = options.now ?? (() => Date.now())
  const maxInterval = options.maxIntervalMs ?? 5000
  let interval = options.initialIntervalMs ?? 1000
  const deadline = now() + options.timeoutMs
  let lastObserved: string

  for (;;) {
    const result = await attempt()
    if ("value" in result) return result.value
    lastObserved = result.observed
    const remaining = deadline - now()
    if (remaining <= 0) {
      throw new TimeoutError(
        options.waitingFor,
        lastObserved,
        options.timeoutMs,
      )
    }
    await sleep(Math.min(interval, remaining))
    interval = Math.min(interval * 2, maxInterval)
  }
}
