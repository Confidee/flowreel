// SPDX-License-Identifier: Apache-2.0

import type { APIRequest, Browser, FullConfig } from "@playwright/test"

import type { TargetName } from "../config/targets.js"
import { type Env, envValue } from "../core/env.js"
import { ConfigError } from "../core/errors.js"
import { requestFailure } from "../core/http.js"

import type { AppAdapter } from "./adapter.js"
import { runLifecycle, settleWithin } from "./lifecycle.js"
import {
  type Persona,
  STATE_ENV_PREFIX,
  type StorageState,
  stateEnvKey,
  storageStateFromEnv,
} from "./personas.js"

// Global setup and teardown over an AppAdapter.
//   setup:    (development only) adapter.prepareLocal(), then ONE sign-in per
//             distinct persona session, handing each storageState to the
//             workers as <prefix><PERSONA> (JSON, never on disk). A browser
//             is launched here, outside any test, only when the adapter asks
//             for one (no trace ever records the fill() of a password).
//             Never retried.
//   teardown: revokes every session (pass or fail): traces and the HTML
//             report record the session cookie. A failed revoke is a loud
//             warning, never a test failure. A run stopped during setup
//             (Ctrl-C, a CI's stop) runs the teardown while the sign-ins
//             are still in flight, so the teardown first waits for them
//             (up to 60 s): a session signed in after the stop is revoked
//             too. The setup also registers its sign-out, which the summary
//             reporter runs when the teardown was cut short (lifecycle.ts).

/** How long the teardown waits for sign-ins still in flight. */
const SETUP_WAIT_MS = 60_000

/** What setup and teardown need to know about this run. */
export interface RunPersonas<P extends string> {
  target: TargetName
  baseURL: string
  /** Every persona key, in sign-in order. */
  keys: readonly P[]
  /** The persona's credentials, or null when it is not configured. */
  persona(key: P): Persona | null
}

export interface SignInAllOptions {
  api: APIRequest
  /** Launches the sign-in browser (only called when the adapter needs one). */
  launchBrowser: () => Promise<Browser>
  /** Default process.env (the handoff is written there). */
  env?: Env
  /** The handoff variable prefix (default FLOWREEL_STATE_). */
  prefix?: string
}

/**
 * Signs in once per distinct persona session and writes the handoff
 * variables (an unconfigured persona's variable is deleted). Returns how
 * many sessions were created.
 */
export async function signInAll<P extends string>(
  run: RunPersonas<P>,
  adapter: AppAdapter<P>,
  options: SignInAllOptions,
): Promise<number> {
  const env = options.env ?? process.env
  const prefix = options.prefix ?? STATE_ENV_PREFIX
  const sessions = new Map<string, StorageState>()
  const wantsBrowser =
    adapter.needsBrowser?.(run.target) ?? run.target === "staging"
  const browser = wantsBrowser ? await options.launchBrowser() : null
  try {
    for (const key of run.keys) {
      const persona = run.persona(key)
      if (!persona) {
        delete env[stateEnvKey(key, prefix)]
        continue
      }
      // Personas sharing an email share one session, per session kind.
      const sessionKey = `${persona.email}|${adapter.sessionKind?.(key) ?? "default"}`
      let state = sessions.get(sessionKey)
      if (!state) {
        state = await adapter.signIn(
          {
            target: run.target,
            baseURL: run.baseURL,
            api: options.api,
            browser,
          },
          key,
          persona,
        )
        sessions.set(sessionKey, state)
      }
      env[stateEnvKey(key, prefix)] = JSON.stringify(state)
    }
  } finally {
    await browser?.close()
  }
  return sessions.size
}

export interface SignOutAllOptions {
  api: APIRequest
  env?: Env
  prefix?: string
  /** The log prefix, shown as "[<logPrefix>]" (default "flowreel"). */
  logPrefix?: string
  /** What may leave the machine once the cookies are dead (default "summary.md"). */
  shareable?: string
  log?: (line: string) => void
  warn?: (line: string) => void
}

/**
 * Revokes every persona session handed over by setup, once per distinct
 * session. Never throws for a failed revoke: it is logged as a warning
 * naming the persona and what to do.
 */
export async function signOutAll<P extends string>(
  run: Pick<RunPersonas<P>, "target" | "baseURL" | "keys">,
  adapter: Pick<AppAdapter<P>, "signOut">,
  options: SignOutAllOptions,
): Promise<{ persona: P; revoked: boolean; detail: string }[]> {
  const env = options.env ?? process.env
  const prefix = options.prefix ?? STATE_ENV_PREFIX
  const logPrefix = `[${options.logPrefix ?? "flowreel"}]`
  const log = options.log ?? ((line) => console.log(line))
  const warn = options.warn ?? ((line) => console.warn(line))
  const done = new Set<string>()
  const results: { persona: P; revoked: boolean; detail: string }[] = []
  for (const key of run.keys) {
    const state = storageStateFromEnv(key, env, prefix)
    if (!state) continue
    // Personas that share an email share one session.
    const raw = env[stateEnvKey(key, prefix)] ?? ""
    if (done.has(raw)) continue
    done.add(raw)

    // signOut must never throw; one that does still gets its warning,
    // and the other personas are still signed out.
    let outcome: { revoked: boolean; detail: string }
    try {
      outcome = await adapter.signOut(options.api, run.baseURL, state)
    } catch (error) {
      outcome = {
        revoked: false,
        detail: `signOut threw: ${requestFailure(error)}`,
      }
    }
    const { revoked, detail } = outcome
    results.push({ persona: key, revoked, detail })
    if (revoked) {
      log(`${logPrefix} signed out the ${key} persona (${detail}).`)
    } else {
      warn(
        `${logPrefix} WARNING: could not sign out the ${key} persona (${detail}). Its session cookie is in this run's traces and HTML report: sign that account out on ${run.target} (or wait for the session idle timeout) before sharing anything but ${options.shareable ?? "summary.md"}.`,
      )
    }
  }
  return results
}

export interface GlobalHooksOptions<P extends string> {
  /** Reads this run's config (called once per hook, in the runner process). */
  load: () => RunPersonas<P> & { module?: string }
  adapter: AppAdapter<P>
  /** The handoff variable prefix (default FLOWREEL_STATE_). */
  prefix?: string
  /** The log prefix, shown as "[<logPrefix>]" (default "flowreel"). */
  logPrefix?: string
  /** Launches the sign-in browser (default: Chromium). Injectable for tests. */
  launchBrowser?: () => Promise<Browser>
}

/**
 * Refuses a run that would repeat a test. createConfig sets retries: 0, but
 * Playwright's command line overrides it (--retries, --repeat-each), and a
 * repeated test repeats its sign-ins and mail sends. The config Playwright
 * hands globalSetup already carries those overrides, so this holds whatever
 * the command line says.
 */
export function refuseRepeats(
  config: Pick<FullConfig, "projects"> | undefined,
): void {
  for (const project of config?.projects ?? []) {
    const name = project.name ? `project "${project.name}"` : "a project"
    if (project.retries > 0) {
      throw new ConfigError(
        `flowreel never retries a test (${name} has retries: ${project.retries}). A retry repeats sign-ins and mail sends. Drop --retries (or the retries setting) and run again.`,
      )
    }
    if (project.repeatEach > 1) {
      throw new ConfigError(
        `flowreel never repeats a test (${name} has repeatEach: ${project.repeatEach}). A repeat repeats sign-ins and mail sends. Drop --repeat-each (or the repeatEach setting) and run again.`,
      )
    }
  }
}

/**
 * A Playwright globalSetup: refuses retries and repeats (refuseRepeats),
 * then prepareLocal() on the development stage, then one sign-in per
 * distinct persona session (signInAll).
 */
export function createGlobalSetup<P extends string>(
  options: GlobalHooksOptions<P>,
): (config?: FullConfig) => Promise<void> {
  return async (config?: FullConfig) => {
    refuseRepeats(config)
    const state = runLifecycle()
    const work = (async () => {
      const { chromium, request } = await import("@playwright/test")
      const run = options.load()
      // The reporter's safety net: whatever sessions exist when it runs.
      state.signOut = async () => {
        await signOutAll(run, options.adapter, {
          api: request,
          prefix: options.prefix,
          logPrefix: options.logPrefix,
        })
      }
      state.signOutRun = null
      state.signedOut = false
      if (run.target === "local") await options.adapter.prepareLocal?.()
      const count = await signInAll(run, options.adapter, {
        api: request,
        launchBrowser: options.launchBrowser ?? chromium.launch.bind(chromium),
        prefix: options.prefix,
      })
      console.log(
        `[${options.logPrefix ?? "flowreel"}] ${run.target}${run.module ? ` (${run.module})` : ""}: signed in ${count} persona(s) for run ${envValue(process.env, "RUN_ID") ?? "(no run id)"}.`,
      )
    })()
    state.setup = work
    try {
      await work
    } finally {
      if (state.setup === work) state.setup = null
    }
  }
}

/**
 * A Playwright globalTeardown: signs every persona out (signOutAll). When
 * the run was stopped while the global setup was still signing in, it
 * first waits for those sign-ins (up to 60 s, then signs out what exists),
 * so no session made after the stop is left behind. Records that the
 * sign-out ran, so the summary reporter's safety net does not repeat it.
 */
export function createGlobalTeardown<P extends string>(
  options: GlobalHooksOptions<P>,
  /** How long to wait for sign-ins still in flight (default 60 s). */
  setupWaitMs = SETUP_WAIT_MS,
): () => Promise<void> {
  return async () => {
    const state = runLifecycle()
    // Marked first: a reporter safety net that runs while this teardown
    // still waits (it was cut short) waits for it instead of signing out a
    // second time.
    let finish: () => void = () => undefined
    state.signOutRun = new Promise<void>((resolve) => {
      finish = resolve
    })
    if (state.setup && !(await settleWithin(state.setup, setupWaitMs))) {
      console.warn(
        `[${options.logPrefix ?? "flowreel"}] WARNING: the global setup was still signing in after ${Math.round(setupWaitMs / 1000)} s; signing out the sessions made so far.`,
      )
    }
    try {
      const { request } = await import("@playwright/test")
      await signOutAll(options.load(), options.adapter, {
        api: request,
        prefix: options.prefix,
        logPrefix: options.logPrefix,
      })
      state.signedOut = true
    } finally {
      finish()
    }
  }
}
