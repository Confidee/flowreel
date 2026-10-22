// SPDX-License-Identifier: Apache-2.0

import type {
  Fixtures,
  PlaywrightTestArgs,
  PlaywrightWorkerArgs,
  TestInfo,
} from "@playwright/test"

import type { AppAdapter } from "../app/adapter.js"
import { type PersonaApis, createPersonaApis } from "../app/fixtures.js"
import {
  type KeepaliveBoundOptions,
  type KeepaliveOptions,
  SessionKeepalive,
  keepaliveDeadline,
} from "../app/keepalive.js"
import { type StorageState, distinctSessions } from "../app/personas.js"
import type { Env } from "../core/env.js"
import {
  type UndoChange,
  type UndoHandle,
  UndoLedger,
  type UndoStore,
} from "../core/undo.js"

import type { InboundMailBudget } from "./budget.js"
import { pauseFor } from "./page.js"
import { PACE_PAUSE_MS, type Pace } from "./policy.js"

// The tour's generic fixtures, for a project's `test.extend(...)`:
//   worker: pace, personaApis (lazy per-persona API clients over global
//           setup's sessions), the bounded session keepalive (auto), the
//           undo ledger (flushed at the worker's end) and the per-run
//           inbound-mail budget;
//   test:   as(persona), undo (the feature's view of the ledger, flushed
//           newest first at the test's end: pass, fail or timeout) and
//           pause() (the pace's hold after a key assertion).
// The project adds its own on top (the recorded page, its cleanup, mail).
// Restores never get the test's page: they run after it is gone and use
// the worker-scoped persona APIs.

/** What a restore gets: worker-scoped persona APIs (never the test's page). */
export interface UndoContext<P extends string, A> {
  as: (persona: P) => A
  request: PersonaApis<P, A>["request"]
}

/** A feature's view of the undo ledger. */
export interface FeatureUndo<P extends string, A> {
  /**
   * Records `what` / `before` / `manual` BEFORE you make the change; the
   * handle's restoreNow() puts it back inside the test. Anything not
   * restored runs LIFO at the test's teardown.
   */
  change(change: UndoChange<UndoContext<P, A>>): Promise<UndoHandle>
}

/** The worker-scoped fixtures tourFixtures() adds. */
export interface TourWorkerFixtures<P extends string, A> {
  pace: Pace
  personaApis: PersonaApis<P, A>
  undoLedger: UndoLedger<UndoContext<P, A>>
  inboundBudget: InboundMailBudget
  _sessionKeepalive: void
}

/** The test-scoped fixtures tourFixtures() adds. */
export interface TourTestFixtures<P extends string, A> {
  /** The persona's app client (the project's own, e.g. a props reader). */
  as: (persona: P) => A
  undo: FeatureUndo<P, A>
  /** Holds at demo pace after a key assertion; nothing at qa pace. */
  pause: () => Promise<void>
}

/**
 * What a project supplies to tourFixtures(): personas, the run's
 * URL / id / pace, the session handoff, its client, and the run's undo and
 * inbound-budget stores.
 */
export interface TourFixtureOptions<P extends string, A> {
  /** Every persona that may hold a session, in a stable order. */
  personas: readonly P[]
  baseURL: () => string
  runId: () => string
  pace: () => Pace
  /** The persona's session from global setup (throws when unconfigured). */
  stateFor: (persona: P) => StorageState
  /** The handoff variable prefix (for the keepalive's session list). */
  statePrefix?: string
  /** The project's client over a persona's request context. */
  client: Parameters<typeof createPersonaApis<P, A>>[0]["client"]
  /**
   * The bound of every persona request (createPersonaApis): default 30 000
   * ms, which overrides the project's actionTimeout for them.
   */
  requestTimeoutMs?: number
  /** The run's undo store (its run folder). */
  undoStore: (runId: string) => UndoStore
  /** The run's inbound budget (a file in its run folder). */
  inboundBudget: (runId: string) => InboundMailBudget
  /** The test's key in the ledger (its feature id, or its title). */
  featureKey: (info: Pick<TestInfo, "title">) => string
  /**
   * The app's session rules, read from the project's AppAdapter (pass the
   * adapter itself): what a signed-out answer is, and the keepalive request
   * (keepalivePath, default "/").
   */
  app: Pick<AppAdapter<P>, "isSignedOut" | "keepalivePath">
  /**
   * The keepalive's log wording (logPrefix, idleMinutes, reference) and its
   * ceiling (maxMinutes: the highest FLOWREEL_KEEPALIVE_MAX_MIN accepted).
   */
  keepalive?: Omit<KeepaliveOptions, "deadline" | "now" | "isSignedOut"> &
    Pick<KeepaliveBoundOptions, "maxMinutes">
  /** Default process.env. */
  env?: Env
}

type Base = PlaywrightTestArgs
type BaseWorker = PlaywrightWorkerArgs

/** The generic tour fixtures; spread into the project's test.extend(). */
export function tourFixtures<P extends string, A>(
  options: TourFixtureOptions<P, A>,
): Fixtures<
  TourTestFixtures<P, A>,
  TourWorkerFixtures<P, A>,
  Base,
  BaseWorker
> {
  const env = () => options.env ?? process.env
  return {
    pace: [
      // eslint-disable-next-line no-empty-pattern
      async ({}, use) => {
        await use(options.pace())
      },
      { scope: "worker" },
    ],

    personaApis: [
      async ({ playwright }, use) => {
        const apis = createPersonaApis<P, A>({
          api: playwright.request,
          baseURL: options.baseURL(),
          stateFor: options.stateFor,
          client: options.client,
          requestTimeoutMs: options.requestTimeoutMs,
        })
        await use(apis)
        await apis.dispose()
      },
      { scope: "worker" },
    ],

    _sessionKeepalive: [
      async ({ personaApis }, use) => {
        // One request per signed-in session every few minutes; a persona is
        // never signed in twice. Bounded: never past its deadline, never
        // under the Playwright inspector.
        const personas = distinctSessions(
          options.personas,
          env(),
          options.statePrefix,
        )
        const bound = keepaliveDeadline(options.runId(), env(), Date.now(), {
          idleMinutes: options.keepalive?.idleMinutes,
          maxMinutes: options.keepalive?.maxMinutes,
        })
        if (bound.deadline === null) {
          console.log(
            `[${options.keepalive?.logPrefix ?? "flowreel"}] keepalive: ${bound.why}.`,
          )
          await use()
          return
        }
        const keepalive = new SessionKeepalive(
          personas,
          async (persona) => {
            const response = await (
              await personaApis.request(persona)
            ).get(options.app.keepalivePath ?? "/", {
              maxRedirects: 0,
              failOnStatusCode: false,
            })
            return {
              status: response.status(),
              location: response.headers().location,
            }
          },
          {
            ...options.keepalive,
            isSignedOut: (answer) => options.app.isSignedOut(answer),
            deadline: bound.deadline,
          },
        )
        const stop = keepalive.start()
        await use()
        await stop()
      },
      { scope: "worker", auto: true },
    ],

    undoLedger: [
      async ({ personaApis }, use) => {
        const ledger = new UndoLedger<UndoContext<P, A>>(
          options.undoStore(options.runId()),
          () => personaApis,
        )
        await use(ledger)
        // Anything a test's own teardown could not reach.
        await ledger.flush()
      },
      { scope: "worker" },
    ],

    inboundBudget: [
      // eslint-disable-next-line no-empty-pattern
      async ({}, use) => {
        await use(options.inboundBudget(options.runId()))
      },
      { scope: "worker" },
    ],

    as: async ({ personaApis }, use) => {
      await use((persona) => personaApis.as(persona))
    },

    undo: async ({ undoLedger }, use, testInfo) => {
      const key = options.featureKey(testInfo)
      await use({ change: (change) => undoLedger.change(key, change) })
      // Runs on pass, fail and timeout: this feature's changes, newest first.
      await undoLedger.flush(key)
    },

    pause: async ({ pace }, use) => {
      await use(() => pauseFor(PACE_PAUSE_MS[pace]))
    },
  }
}
