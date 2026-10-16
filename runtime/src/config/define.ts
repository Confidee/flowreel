// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path"

import { registerEnvAliases } from "../core/env.js"
import { ConfigError } from "../core/errors.js"

import type { SecretsOptions } from "./source.js"
import { type TargetPolicy, assertTargetPolicy } from "./targets.js"

// One project file (flowreel.config.ts) instead of scattered constants:
// the target allowlist, the modules a pipeline can run, the personas, where
// secrets and results live, and the project's own names for flowreel's
// environment variables. defineConfig() checks it once and registers the
// aliases; everything else in the runtime takes the result as a parameter.

/**
 * A project's flowreel configuration (its flowreel.config.ts), as
 * defineConfig() returns it: checked once, aliases registered, defaults
 * filled. The runtime takes it as a parameter and never reads a project
 * constant of its own.
 */
export interface FlowreelConfig<
  M extends string = string,
  P extends string = string,
> {
  /** The log prefix, "[<logPrefix>] …" (default "flowreel"). */
  logPrefix: string
  targets: TargetPolicy
  /** What a pipeline can run (a round trip, a tour, …) and the default. */
  modules: { names: readonly M[]; default: M }
  /** Every persona, in sign-in order. */
  personas: readonly P[]
  secrets: SecretsOptions
  /** Per-run evidence: <results>/<RUN_ID>/ (git-ignored). */
  results: string
  /**
   * The project's own names for flowreel's variables (FLOWREEL_<KEY> is
   * always read first): { TARGET: ["MY_TARGET"] }.
   */
  envAliases: Record<string, readonly string[]>
}

/**
 * What a project writes in defineConfig(): FlowreelConfig with
 * `logPrefix` and `envAliases` optional.
 */
export type FlowreelConfigInput<
  M extends string = string,
  P extends string = string,
> = Omit<FlowreelConfig<M, P>, "logPrefix" | "envAliases"> &
  Partial<Pick<FlowreelConfig<M, P>, "logPrefix" | "envAliases">>

const KEY = /^[A-Z][A-Z0-9_]*$/
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Checks a project's configuration, registers its environment aliases
 * (registerEnvAliases, idempotent) and returns it with defaults filled in.
 * Throws a ConfigError naming the first problem.
 */
export function defineConfig<const M extends string, const P extends string>(
  input: FlowreelConfigInput<M, P>,
): FlowreelConfig<M, P> {
  assertTargetPolicy(input.targets)
  const { names, default: fallback } = input.modules
  if (names.length === 0) throw new ConfigError("modules.names is empty.")
  if (new Set(names).size !== names.length) {
    throw new ConfigError(`modules.names repeats a name (${names.join(", ")}).`)
  }
  if (!names.includes(fallback)) {
    throw new ConfigError(
      `modules.default "${fallback}" is not one of ${names.join(", ")}.`,
    )
  }
  if (new Set(input.personas).size !== input.personas.length) {
    throw new ConfigError(
      `personas repeats a name (${input.personas.join(", ")}).`,
    )
  }
  const envAliases = input.envAliases ?? {}
  for (const [key, aliases] of Object.entries(envAliases)) {
    if (!KEY.test(key)) {
      throw new ConfigError(
        `envAliases: "${key}" is not a key (upper case, without the FLOWREEL_ prefix).`,
      )
    }
    for (const alias of aliases) {
      if (!NAME.test(alias) || alias.startsWith("FLOWREEL_")) {
        throw new ConfigError(
          `envAliases.${key}: "${alias}" is not a variable name of the project's own.`,
        )
      }
    }
  }
  registerEnvAliases(envAliases)
  return {
    ...input,
    logPrefix: input.logPrefix ?? "flowreel",
    results: resolve(input.results),
    envAliases,
  }
}

/** <results>/<runId>: one run's evidence folder. */
export function resultsDir(
  config: Pick<FlowreelConfig, "results">,
  runId: string,
): string {
  return resolve(config.results, runId)
}

/** The run's Playwright HTML report (credential-bearing, like its traces). */
export function reportDir(
  config: Pick<FlowreelConfig, "results">,
  runId: string,
): string {
  return resolve(resultsDir(config, runId), "report")
}
