// SPDX-License-Identifier: Apache-2.0

import type { APIRequest, Browser } from "@playwright/test"

import type { TargetName } from "../config/targets.js"

import type { Persona, StorageState } from "./personas.js"
import type { SessionAnswer } from "./session.js"

// AppAdapter: the project's side of signing in and out of the app under
// test. flowreel decides WHEN (once per distinct persona per run, never
// retried, every session revoked at the end); the adapter knows HOW (a
// test-only sign-in seam locally, the real sign-in form on staging, the
// app's sign-out request, what a signed-out answer looks like).

/**
 * What {@link AppAdapter.signIn} gets for one sign-in: the target, its
 * allowlisted base URL, Playwright's request API and, when the adapter asked
 * for one, a browser launched outside any test.
 */
export interface SignInContext {
  target: TargetName
  baseURL: string
  /** Playwright's request API (local seams, API sign-in). */
  api: APIRequest
  /**
   * A browser launched outside any test (so no trace records a fill() of a
   * password), when the adapter asked for one (needsBrowser); else null.
   */
  browser: Browser | null
}

/**
 * The project's side of signing in and out of the app under test.
 *
 * The project implements it once (e.g. the rails-inertia subpath's
 * adapter, or one written for its own sign-in form) and hands it to the
 * global setup/teardown factories and to tourFixtures(). flowreel decides
 * WHEN: each distinct persona signs in once per run in the global setup,
 * never retried (a retry feeds the target's lockout counter), the session
 * handed to the workers, and every session revoked by the global teardown.
 * The adapter knows HOW: a test-only sign-in seam locally, the real sign-in
 * form on staging, the app's sign-out request and what a signed-out answer
 * looks like.
 *
 * Invariants: signIn throws on failure (a LoginError naming the persona and
 * the step, never a password) and is never retried; signOut never throws;
 * nothing returned or thrown carries a secret.
 *
 * @typeParam P - the project's persona keys ("agent", "admin", …).
 */
export interface AppAdapter<P extends string = string> {
  /**
   * Signs `persona` in ONCE and returns its storageState. Never retried by
   * flowreel: a sign-in that fails throws (a LoginError naming the persona
   * and the step, never a password).
   */
  signIn(ctx: SignInContext, key: P, persona: Persona): Promise<StorageState>
  /**
   * The kind of session a persona gets ("staff", "portal", …): personas
   * that share an email AND a kind share one session (default: one kind).
   */
  sessionKind?(key: P): string
  /** Whether signIn needs a browser on `target` (default: staging only). */
  needsBrowser?(target: TargetName): boolean
  /** Revokes a session at the end of a run. Never throws. */
  signOut(
    api: APIRequest,
    baseURL: string,
    state: StorageState,
  ): Promise<{ revoked: boolean; detail: string }>
  /**
   * True when an authenticated request's answer means "signed out". Read by
   * the session keepalive (tourFixtures' `app`).
   */
  isSignedOut(answer: SessionAnswer): boolean
  /**
   * Is the target up? Null when healthy, else what is wrong (no secret).
   * Optional. Reserved for a generic preflight (docs/design/architecture.md,
   * "Public interfaces"): nothing in the runtime calls it yet.
   */
  health?(api: APIRequest, baseURL: string): Promise<string | null>
  /** The keepalive request, GET (default "/"; tourFixtures' `app`). */
  keepalivePath?: string
  /**
   * Development stage only, before any sign-in: prepare the database, seeds
   * and assets the run needs. Throws to stop the run.
   */
  prepareLocal?(): Promise<void> | void
}
