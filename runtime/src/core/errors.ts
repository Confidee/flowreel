// SPDX-License-Identifier: Apache-2.0

// Error types shared across flowreel. Messages must be actionable (name what
// was awaited and the last observed state) and must NEVER contain a secret
// (password, mail-provider token, client secret).

export class TimeoutError extends Error {
  constructor(
    readonly waitingFor: string,
    readonly lastObserved: string,
    readonly timeoutMs: number,
  ) {
    super(
      `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${waitingFor}. Last observed: ${lastObserved}`,
    )
    this.name = "TimeoutError"
  }
}

/**
 * A failed sign-in. Never retried: an app's sign-in rate limiting counts
 * every attempt, so a retry can lock the account.
 */
export class LoginError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LoginError"
  }
}

/**
 * A send the send-domain guard refused. Nothing was sent: the guard runs
 * before any network call.
 */
export class SendRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SendRefusedError"
  }
}

/** Missing/invalid configuration (names the keys, never values). */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConfigError"
  }
}

/**
 * An inbound mail the budget refused (the per-run budget or the cross-run
 * inbound ledger). Nothing was sent: the budget is consumed before a send.
 */
export class InboundBudgetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InboundBudgetError"
  }
}
