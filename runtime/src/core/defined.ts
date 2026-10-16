// SPDX-License-Identifier: Apache-2.0

/**
 * The object without its undefined-valued keys (shallow); `{}` for
 * undefined. The define* helpers (defineBrand, defineCardCopy,
 * defineNarrationCopy) spread overrides through this, so an override passed
 * explicitly as `undefined` (`{ latencyLabels: cfg.labels }` with the label
 * unset) keeps the default instead of replacing it.
 */
export function defined<T extends object>(value: T | undefined): T {
  if (!value) return {} as T
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as T
}
