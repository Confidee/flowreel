// SPDX-License-Identifier: Apache-2.0

// Environment variables. flowreel's own names use the FLOWREEL_ prefix
// (FLOWREEL_VOICE, FLOWREEL_VIDEO, …). Projects that adopted flowreel from
// an earlier harness keep their existing names working by registering an
// alias map at load (registerEnvAliases); flowreel itself registers none.
// FLOWREEL_<KEY> is read first, then each alias in order. A value that is
// unset or empty falls through to the next name.
//
//   registerEnvAliases({ VOICE: ["MY_APP_VOICE"] })
//   envValue(process.env, "VOICE")    // FLOWREEL_VOICE ?? MY_APP_VOICE
//   envVar(process.env, "VOICE")      // { name: "MY_APP_VOICE", value }
//
// Messages that name a variable name the one that was actually set (or the
// FLOWREEL_ name when none was), so an error reads in the user's own terms.

export type Env = Record<string, string | undefined>

export const ENV_PREFIX = "FLOWREEL_"

/**
 * Legacy names accepted after FLOWREEL_<KEY>, by key. Empty until a project
 * registers its own (registerEnvAliases).
 */
const aliases = new Map<string, readonly string[]>()

/**
 * Adds legacy names for keys (appended after any already known). A project
 * adapter calls this once at load; keys are given without the prefix.
 */
export function registerEnvAliases(
  map: Record<string, readonly string[]>,
): void {
  for (const [key, names] of Object.entries(map)) {
    const known = aliases.get(key) ?? []
    aliases.set(key, [...known, ...names.filter((n) => !known.includes(n))])
  }
}

/** Every name read for `key`, in order: FLOWREEL_<KEY>, then the aliases. */
export function envNames(key: string): string[] {
  return [`${ENV_PREFIX}${key}`, ...(aliases.get(key) ?? [])]
}

/**
 * The first of envNames(key) with a non-empty value, with the name it was
 * read from; undefined when none is set.
 */
export function envVar(
  env: Env,
  key: string,
): { name: string; value: string } | undefined {
  for (const name of envNames(key)) {
    const value = env[name]
    if (value !== undefined && value !== "") return { name, value }
  }
  return undefined
}

/** The value of envVar(env, key), or undefined. */
export function envValue(env: Env, key: string): string | undefined {
  return envVar(env, key)?.value
}

/** The name a message should use for `key`: the one set, else FLOWREEL_<KEY>. */
export function envName(env: Env, key: string): string {
  return envVar(env, key)?.name ?? `${ENV_PREFIX}${key}`
}
