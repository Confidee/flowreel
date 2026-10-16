// SPDX-License-Identifier: Apache-2.0

import { ConfigError } from "../core/errors.js"

// The target allowlist. A run is either "local" (the development stage: a
// server on this machine, on a loopback host and a fixed port range) or
// "staging" (an explicit list of origins). Production hosts are refused with
// their own message for every target, even when passed explicitly and even
// when a policy lists one; nothing else is ever a target.

export type TargetName = "local" | "staging"
export const TARGETS: readonly TargetName[] = ["local", "staging"]

/**
 * The project's target allowlist: where a run may point.
 *
 * Implemented as data by the project (its defineConfig `targets`) and read
 * by assertSafeBaseUrl, parseLocalPort and defaultLocalPort whenever a
 * base URL is chosen, before any request. A "local" run may only use a loopback
 * host and a port in [portMin, portMax]; a "staging" run only one of the
 * exact `staging` origins. A production host (isProductionHost) is refused
 * for every target with its own message, even when listed; anything else is
 * refused too. assertTargetPolicy checks the policy itself when defineConfig
 * builds the config.
 */
export interface TargetPolicy {
  /** The development stage: http://<host>:<portMin..portMax>. */
  local: {
    /**
     * A loopback host (LOOPBACK_HOSTS): "localhost" (the default),
     * "127.0.0.1" or "[::1]". The local stage points test seams at it, so
     * nothing off this machine is ever accepted.
     */
    host?: string
    portMin: number
    portMax: number
    /** The port when none is configured (default portMin). */
    defaultPort?: number
  }
  /** Exact origins ("https://staging.example.com") a staging run may use. */
  staging: readonly string[]
  /**
   * True for a production host name (lower-cased): refused for every target
   * with a dedicated message.
   */
  isProductionHost: (host: string) => boolean
}

/** The hosts a development stage may use (URL.hostname spelling). */
export const LOOPBACK_HOSTS: readonly string[] = [
  "localhost",
  "127.0.0.1",
  "[::1]",
]

const localHost = (policy: TargetPolicy) =>
  (policy.local.host ?? "localhost").toLowerCase()

/** "http://<host>:<port>" for the development stage. */
export function localBaseUrl(port: number, host = "localhost"): string {
  return `http://${host}:${port}`
}

/** The development stage's default port. */
export function defaultLocalPort(policy: TargetPolicy): number {
  return policy.local.defaultPort ?? policy.local.portMin
}

/** "local" (default when unset) or "staging"; `label` names the variable. */
export function parseTarget(
  raw: string | undefined,
  label: string,
): TargetName {
  const value = raw ?? "local"
  if (value === "local" || value === "staging") return value
  throw new ConfigError(
    `${label} must be "local" or "staging" (got ${JSON.stringify(value)}).`,
  )
}

/** http://<local host>:<port in range>, nothing else. */
function isLocalOrigin(url: URL, policy: TargetPolicy): boolean {
  if (url.protocol !== "http:" || url.hostname !== localHost(policy)) {
    return false
  }
  const port = Number(url.port)
  return (
    /^\d+$/.test(url.port) &&
    port >= policy.local.portMin &&
    port <= policy.local.portMax
  )
}

/**
 * Throws unless `url` is exactly an allowlisted origin for `target`.
 * Production hosts are refused with a dedicated message even when passed
 * explicitly. Never echoes userinfo. Returns the normalised origin.
 */
export function assertSafeBaseUrl(
  url: string,
  target: TargetName,
  policy: TargetPolicy,
): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ConfigError("Base URL is not a valid URL.")
  }
  const host = parsed.hostname.toLowerCase()
  const clean =
    !parsed.username &&
    !parsed.password &&
    (parsed.pathname === "/" || parsed.pathname === "") &&
    !parsed.search &&
    !parsed.hash
  // Before either allowlist: a production host is refused even when a
  // (mis)configured policy lists it.
  if (policy.isProductionHost(host)) {
    throw new ConfigError(
      `Refusing ${parsed.origin}: production hosts are never a QA target.`,
    )
  }
  if (
    clean &&
    target === "local" &&
    LOOPBACK_HOSTS.includes(host) &&
    isLocalOrigin(parsed, policy)
  ) {
    return parsed.origin
  }
  if (clean && target === "staging" && policy.staging.includes(parsed.origin)) {
    return parsed.origin
  }
  const allowed =
    target === "local"
      ? [
          `http://${localHost(policy)}:${policy.local.portMin}-${policy.local.portMax}`,
        ]
      : policy.staging
  // Never echo userinfo: build the message from the credential-free parts.
  const shown = `${parsed.origin}${parsed.pathname}${parsed.search}${parsed.hash}`
  throw new ConfigError(
    `Refusing base URL ${shown} for target "${target}". Allowed: ${allowed.join(", ")}.`,
  )
}

/**
 * The development stage's port: the default when `raw` is unset or blank,
 * else a whole number inside the policy's range. `label` names the variable.
 */
export function parseLocalPort(
  raw: string | undefined,
  policy: TargetPolicy,
  label: string,
): number {
  const { portMin, portMax } = policy.local
  if (raw === undefined || raw.trim() === "") return defaultLocalPort(policy)
  const port = Number(raw.trim())
  if (!/^\d+$/.test(raw.trim()) || port < portMin || port > portMax) {
    throw new ConfigError(
      `${label} must be a port from ${portMin} to ${portMax} (got ${JSON.stringify(raw)}).`,
    )
  }
  return port
}

/** Throws unless the policy itself is coherent (defineConfig calls it). */
export function assertTargetPolicy(policy: TargetPolicy): void {
  const { portMin, portMax } = policy.local
  const host = localHost(policy)
  if (policy.isProductionHost(host)) {
    throw new ConfigError(
      `targets.local.host: ${host} is a production host by the policy's own rule.`,
    )
  }
  if (!LOOPBACK_HOSTS.includes(host)) {
    throw new ConfigError(
      `targets.local.host must be a loopback host (${LOOPBACK_HOSTS.join(", ")}); got ${JSON.stringify(policy.local.host)}.`,
    )
  }
  const port = (n: number) => Number.isInteger(n) && n > 0 && n < 65536
  if (!port(portMin) || !port(portMax) || portMin > portMax) {
    throw new ConfigError(
      `targets.local: portMin..portMax must be a port range (got ${portMin}..${portMax}).`,
    )
  }
  const fallback = defaultLocalPort(policy)
  if (!port(fallback) || fallback < portMin || fallback > portMax) {
    throw new ConfigError(
      `targets.local.defaultPort ${fallback} is outside ${portMin}..${portMax}.`,
    )
  }
  for (const origin of policy.staging) {
    let parsed: URL
    try {
      parsed = new URL(origin)
    } catch {
      throw new ConfigError(`targets.staging: ${origin} is not a URL.`)
    }
    if (parsed.origin !== origin || parsed.protocol !== "https:") {
      throw new ConfigError(
        `targets.staging: ${origin} must be a bare https origin (${parsed.origin}).`,
      )
    }
    if (policy.isProductionHost(parsed.hostname.toLowerCase())) {
      throw new ConfigError(
        `targets.staging: ${origin} is a production host by the policy's own rule.`,
      )
    }
  }
}
