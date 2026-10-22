// SPDX-License-Identifier: Apache-2.0

import type { APIRequest, APIRequestContext } from "@playwright/test"

import type { Env } from "../core/env.js"
import { ConfigError } from "../core/errors.js"
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  assertRequestTimeoutMs,
} from "../core/http.js"

import {
  STATE_ENV_PREFIX,
  type StorageState,
  stateEnvKey,
  storageStateFromEnv,
} from "./personas.js"

// Building blocks for a project's fixtures. No fixture signs in: every
// session comes from global setup through the handoff variables, and a
// persona that is not configured on this target fails with an actionable
// message instead of signing in.

export interface RequireStateOptions {
  env?: Env
  prefix?: string
  /** The message when the persona has no session (default names the variable). */
  message?: (persona: string, variable: string) => string
}

/** The persona's session from global setup; throws when there is none. */
export function requireStorageState(
  persona: string,
  options: RequireStateOptions = {},
): StorageState {
  const prefix = options.prefix ?? STATE_ENV_PREFIX
  const state = storageStateFromEnv(persona, options.env, prefix)
  if (!state) {
    const variable = stateEnvKey(persona, prefix)
    throw new ConfigError(
      options.message?.(persona, variable) ??
        `The ${persona} persona is not signed in for this run (${variable} unset): run through the flowreel Playwright config, whose global setup signs in once per persona, or configure the persona on this target.`,
    )
  }
  return state
}

/** Per-persona API access over the sessions from global setup. */
export interface PersonaApis<P extends string, A> {
  /** The persona's app client (one per persona, created on first use). */
  as: (persona: P) => A
  /** The persona's authenticated request context (created on first use). */
  request: (persona: P) => Promise<APIRequestContext>
  /** Disposes every context opened so far. */
  dispose: () => Promise<void>
}

export interface PersonaApisOptions<P extends string, A> {
  /** Playwright's request API (the `playwright.request` fixture). */
  api: Pick<APIRequest, "newContext">
  baseURL: string
  /** The persona's storageState (requireStorageState, usually). */
  stateFor: (persona: P) => StorageState
  /** Wraps a persona's (lazily opened) context in the project's client. */
  client: (context: APIRequestContext, persona: P) => A
  /**
   * How long each request of a persona's context may take, from the
   * connection to the last byte of the body, in milliseconds (the
   * context's `timeout`; a request's own `timeout` still wins). Default
   * 30 000, which overrides the project's actionTimeout for these
   * requests. A whole number from 1 to 2 147 483 647, else a ConfigError.
   */
  requestTimeoutMs?: number
}

/**
 * Lazily opened, per-persona request contexts and clients. A client is
 * built synchronously over a proxy that opens its persona's context on the
 * first call, so a persona that is never used never gets a context; asking
 * for an unconfigured persona fails at once (stateFor throws). Every
 * context is opened with `timeout: requestTimeoutMs` (#24).
 */
export function createPersonaApis<P extends string, A>(
  options: PersonaApisOptions<P, A>,
): PersonaApis<P, A> {
  const timeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  assertRequestTimeoutMs(timeout, "createPersonaApis option requestTimeoutMs")
  const contexts = new Map<P, APIRequestContext>()
  const clients = new Map<P, A>()
  const request = async (persona: P) => {
    let context = contexts.get(persona)
    if (!context) {
      context = await options.api.newContext({
        baseURL: options.baseURL,
        storageState: options.stateFor(persona),
        timeout,
      })
      contexts.set(persona, context)
    }
    return context
  }
  // A client needs a context synchronously: a lazy proxy resolves it per call.
  const lazyContext = (persona: P): APIRequestContext =>
    new Proxy({} as APIRequestContext, {
      get(_target, prop) {
        return async (...args: unknown[]) => {
          const context = await request(persona)
          const member = (context as unknown as Record<string, unknown>)[
            prop as string
          ] as (...a: unknown[]) => unknown
          return member.apply(context, args)
        }
      },
    })
  return {
    as: (persona) => {
      let client = clients.get(persona)
      if (!client) {
        options.stateFor(persona) // fail fast with the actionable message
        client = options.client(lazyContext(persona), persona)
        clients.set(persona, client)
      }
      return client
    },
    request,
    dispose: async () => {
      for (const context of contexts.values()) await context.dispose()
      contexts.clear()
    },
  }
}
