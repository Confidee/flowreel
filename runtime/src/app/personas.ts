// SPDX-License-Identifier: Apache-2.0

import type { APIRequestContext } from "@playwright/test"

import type { Env } from "../core/env.js"
import { ConfigError } from "../core/errors.js"

// Personas and the storageState handoff. Global setup signs in ONCE per
// distinct persona per run and hands each session to the workers as JSON in
// an environment variable (<prefix><PERSONA>, never written to disk);
// workers, fixtures and teardown read it back from there. Nothing here ever
// logs a password or a cookie value.

export interface Persona {
  email: string
  password: string
}

export type StorageState = Awaited<
  ReturnType<APIRequestContext["storageState"]>
>

/** The default prefix of the handoff variables: FLOWREEL_STATE_<PERSONA>. */
export const STATE_ENV_PREFIX = "FLOWREEL_STATE_"

/** process.env key carrying a persona's storageState JSON to workers. */
export function stateEnvKey(
  persona: string,
  prefix: string = STATE_ENV_PREFIX,
): string {
  return `${prefix}${persona.toUpperCase()}`
}

/** The persona's storageState handed over by global setup, or null. */
export function storageStateFromEnv(
  persona: string,
  env: Env = process.env,
  prefix: string = STATE_ENV_PREFIX,
): StorageState | null {
  const key = stateEnvKey(persona, prefix)
  const raw = env[key]
  if (!raw) return null
  try {
    return JSON.parse(raw) as StorageState
  } catch {
    throw new ConfigError(`${key} is not valid JSON.`)
  }
}

/**
 * The personas that carry a session, one per distinct session: personas
 * that share an email share one session (global setup signs in once), so
 * keepalive pings and teardown sign-outs touch each session once. In
 * `personas` order.
 */
export function distinctSessions<P extends string>(
  personas: readonly P[],
  env: Env = process.env,
  prefix: string = STATE_ENV_PREFIX,
): P[] {
  const seen = new Set<string>()
  return personas.filter((persona) => {
    const raw = env[stateEnvKey(persona, prefix)]
    if (!raw || seen.has(raw)) return false
    seen.add(raw)
    return true
  })
}

/** The persona's config entry (null = not configured for this run). */
export function personaOf<P extends string>(
  cfg: Partial<Record<P, Persona | null>>,
  key: P,
): Persona | null {
  return cfg[key] ?? null
}
