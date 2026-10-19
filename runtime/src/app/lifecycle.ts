// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs"
import { join } from "node:path"

import { UNDO_JSON, fileUndoStore, summarizeUndo } from "../core/undo.js"

// What the global setup, the global teardown and the summary reporter share
// about one run's sessions, all in Playwright's runner process: the setup's
// sign-ins while they run (the teardown waits for them, so a stop during
// sign-in does not leave a session behind), the sign-out the setup registers
// (the reporter's safety net when the teardown was cut short), and whether
// the teardown signed out. It lives on a global symbol: the setup, the
// teardown and the reporter are loaded separately and may each load this
// module through a different path. Internal: not exported from the barrel.

/** One run's session lifecycle. */
export interface RunLifecycle {
  /** The global setup while it runs (its sign-ins). */
  setup: Promise<unknown> | null
  /** Signs every persona session handed over so far out. */
  signOut: (() => Promise<void>) | null
  /** The sign-out once started (by the teardown or the reporter). */
  signOutRun: Promise<void> | null
  /** The sign-out finished. */
  signedOut: boolean
}

const KEY = Symbol.for("flowreel.runLifecycle")

type Holder = { [KEY]?: RunLifecycle }

/** This process's run lifecycle (created on first use). */
export function runLifecycle(): RunLifecycle {
  const holder = globalThis as Holder
  holder[KEY] ??= {
    setup: null,
    signOut: null,
    signOutRun: null,
    signedOut: false,
  }
  return holder[KEY]
}

/** Forgets the run lifecycle (tests). */
export function resetRunLifecycle(): void {
  delete (globalThis as Holder)[KEY]
}

/**
 * Whether `promise` settled (resolved or rejected) within `ms`. Never
 * rejects.
 */
export function settleWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  return new Promise((done) => {
    const timer = setTimeout(() => done(false), ms)
    const settled = () => {
      clearTimeout(timer)
      done(true)
    }
    promise.then(settled, settled)
  })
}

/**
 * Waits until the run's undo ledger (<dir>/undo.json) has no `pending`
 * entry, for at most `ms` (or until `signal` aborts), checking every
 * `pollMs`. Resolves with the pending count left (0 also when there is no
 * ledger or it cannot be read). Never rejects.
 */
export async function waitForRestores(
  dir: string,
  runId: string,
  ms: number,
  signal?: AbortSignal,
  pollMs = 250,
): Promise<number> {
  const pending = () => {
    if (!existsSync(join(dir, UNDO_JSON))) return 0
    try {
      return summarizeUndo(fileUndoStore(dir, runId).read()).pending
    } catch {
      return 0
    }
  }
  const until = Date.now() + ms
  let left = pending()
  while (left > 0 && Date.now() < until && !signal?.aborted) {
    await new Promise((r) => setTimeout(r, pollMs))
    left = pending()
  }
  return left
}
