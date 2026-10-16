// SPDX-License-Identifier: Apache-2.0

import { homedir } from "node:os"

import { type Env, envName, envNames, envValue } from "../core/env.js"
import { ConfigError } from "../core/errors.js"

import { parseEnvFile, readPrivateFile } from "./secrets.js"
import {
  type TargetName,
  type TargetPolicy,
  assertSafeBaseUrl,
  localBaseUrl,
  parseLocalPort,
  parseTarget,
} from "./targets.js"

// Where a run's settings come from. The rules:
//   - the target (FLOWREEL_TARGET or the project's alias) comes from process
//     env ONLY, so a secrets file can never turn a run into a staging run;
//     both names set to different targets is refused, never resolved;
//   - a local run never reads the secrets file;
//   - a staging run reads it (owner-only, see secrets.ts), and process env
//     overrides it: a key PRESENT in process env is authoritative even when
//     empty, so an empty value blanks a file value;
//   - empty values count as unset.
// Nothing here ever logs or echoes a value.

/** Where the secrets come from and how messages describe them. */
export interface SecretsOptions {
  /** The default secrets file for a home directory. */
  file: (home: string) => string
  /**
   * The variable that holds the staging base URL (process env or the
   * secrets file). Default "FLOWREEL_BASE_URL".
   */
  baseUrlKey?: string
  /** A template for the secrets file, named in messages. */
  template?: string
  /** How secrets usually arrive, e.g. "e.g. from a password manager". */
  envHint?: string
}

/**
 * Test seams for openConfigSource(): the environment, the file reader and the
 * home directory. Production callers pass nothing.
 */
export interface SourceOptions {
  /** Defaults to process.env. */
  env?: Env
  /**
   * Returns file contents, or undefined when the file does not exist. The
   * default (readPrivateFile) also refuses a file other users can read.
   */
  readFile?: (path: string) => string | undefined
  /** Defaults to os.homedir(). */
  homeDir?: string
}

/**
 * One run's settings, opened once per process for its target. get() reads
 * the process environment first, then (staging only) the private secrets
 * file; callers never read process.env for a setting directly.
 */
export interface ConfigSource {
  target: TargetName
  local: boolean
  /** The process environment the source was opened on. */
  env: Env
  /** The secrets file (read only for a staging run). */
  file: string
  /** A setting by its variable name: process env first, then the file. */
  get: (name: string) => string | undefined
}

const nonEmpty = (v: string | undefined) => (v === "" ? undefined : v)

/**
 * envValue(env, key), refusing when two of its names (FLOWREEL_<KEY> and a
 * project alias) are set to different values: for the keys that decide what
 * a run IS (target, run id, module), an inherited FLOWREEL_* must never
 * silently override what the caller's own name asked for (or the reverse).
 * Values are compared trimmed; empty counts as unset. Names, never values,
 * appear in the message.
 */
export function agreedEnvValue(env: Env, key: string): string | undefined {
  const set = envNames(key).filter((name) => nonEmpty(env[name]) !== undefined)
  const values = new Set(set.map((name) => env[name]!.trim()))
  if (values.size > 1) {
    throw new ConfigError(
      `${set.join(" and ")} are both set, to different values; unset one (they name the same setting).`,
    )
  }
  return envValue(env, key)
}

/**
 * The run's target from FLOWREEL_TARGET (or its alias): process env only
 * (never the file), so a run is staging only when the caller asked for it.
 * Two names set to different targets are refused (agreedEnvValue).
 */
export function readTarget(env: Env = process.env): TargetName {
  return parseTarget(agreedEnvValue(env, "TARGET"), envName(env, "TARGET"))
}

/**
 * Opens the run's settings: the target (readTarget, unless given), then for
 * staging the secrets file, read and permission-checked at once.
 */
export function openConfigSource(
  secrets: Pick<SecretsOptions, "file">,
  options: SourceOptions = {},
  target: TargetName = readTarget(options.env ?? process.env),
): ConfigSource {
  const env = options.env ?? process.env
  const readFile = options.readFile ?? readPrivateFile
  const home = options.homeDir ?? homedir()
  const local = target === "local"

  // Local runs never read the secrets file.
  const file = envValue(env, "ENV_FILE") ?? secrets.file(home)
  const contents = local ? undefined : readFile(file)
  const fromFile = contents === undefined ? {} : parseEnvFile(contents)

  return {
    target,
    local,
    env,
    file,
    get: (name) =>
      name in env
        ? nonEmpty(env[name])
        : local
          ? undefined
          : nonEmpty(fromFile[name]),
  }
}

/**
 * Throws naming every key of `keys` without a value (never a value).
 * Called for a staging run with the keys it cannot default.
 */
export function requireKeys(
  source: Pick<ConfigSource, "get" | "file" | "target">,
  keys: readonly string[],
  secrets: Pick<SecretsOptions, "template" | "envHint"> = {},
): void {
  const missing = keys.filter((key) => !source.get(key))
  if (missing.length === 0) return
  const hint = secrets.envHint ? ` (${secrets.envHint})` : ""
  const template = secrets.template
    ? ` (template: ${secrets.template}, chmod 600)`
    : " (chmod 600)"
  throw new ConfigError(
    `Missing required ${source.target} config: ${missing.join(", ")}. Pass them in the environment${hint} or set them in ${source.file}${template}.`,
  )
}

/**
 * Throws naming (never echoing) each key of `keys` whose value is still a
 * template placeholder (compared trimmed and lower-cased).
 */
export function assertNoPlaceholders(
  source: Pick<ConfigSource, "get" | "target">,
  keys: readonly string[],
  placeholders: ReadonlySet<string>,
  secrets: Pick<SecretsOptions, "template"> = {},
): void {
  const found = keys.filter((key) =>
    placeholders.has(source.get(key)?.trim().toLowerCase() ?? ""),
  )
  if (found.length === 0) return
  const template = secrets.template
    ? ` (${secrets.template} only shows the shape)`
    : ""
  throw new ConfigError(
    `Template placeholder values in ${source.target} config: ${found.join(", ")}. Replace them with the real values${template}.`,
  )
}

/**
 * The base URL: the secrets' base URL key when set (process env, or the file
 * on staging), else the development stage's localhost URL on
 * FLOWREEL_LOCAL_PORT (or its alias). Always checked against the policy.
 */
export function resolveBaseUrl(
  source: Pick<ConfigSource, "get" | "env" | "target">,
  policy: TargetPolicy,
  secrets: Pick<SecretsOptions, "baseUrlKey"> = {},
): string {
  const configured = source.get(secrets.baseUrlKey ?? "FLOWREEL_BASE_URL")
  return assertSafeBaseUrl(
    configured ??
      localBaseUrl(
        parseLocalPort(
          envValue(source.env, "LOCAL_PORT"),
          policy,
          envName(source.env, "LOCAL_PORT"),
        ),
        policy.local.host,
      ),
    source.target,
    policy,
  )
}

/**
 * The module a run belongs to, from FLOWREEL_MODULE (or its alias; process
 * env only): `fallback` when unset or blank, else one of `modules`. Two
 * names set to different modules are refused (agreedEnvValue).
 */
export function parseModule<M extends string>(
  env: Env,
  modules: readonly M[],
  fallback: M,
): M {
  const raw = agreedEnvValue(env, "MODULE")
  const value = raw?.trim() ? raw.trim() : fallback
  if ((modules as readonly string[]).includes(value)) return value as M
  throw new ConfigError(
    `${envName(env, "MODULE")} must be one of ${modules.join(", ")} (got ${JSON.stringify(value)}).`,
  )
}

/** A positive whole number of milliseconds; `label` names the setting. */
export function parsePositiveInt(label: string, raw: string): number {
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
    throw new ConfigError(`${label} must be a positive integer (milliseconds).`)
  }
  return Number(raw)
}

/**
 * Settles `key` in `env` (the Playwright runner's process, which workers
 * and the reporter inherit): the agreed value when one is set, else
 * `fallback()`; then written under EVERY name of the key, so whichever name
 * a reader tries first, it reads this value. Returns the value.
 */
export function settleEnvValue(
  env: Env,
  key: string,
  fallback: () => string,
): string {
  const value = agreedEnvValue(env, key) ?? fallback()
  for (const name of envNames(key)) env[name] = value
  return value
}
