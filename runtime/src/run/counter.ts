// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import { ConfigError } from "../core/errors.js"

// A round-robin position persisted between runs, so consecutive runs spread
// across a list (senders, accounts, …) instead of always starting with the
// first. A missing or corrupt counter restarts at 0.

/**
 * Where a round-robin position persists between runs (fileCounter() by
 * default). read() returns undefined when nothing is stored yet.
 */
export interface CounterStore {
  read(): string | undefined
  write(value: string): void
}

/** A counter in a small file (created with its folder on first write). */
export function fileCounter(path: string): CounterStore {
  return {
    read() {
      try {
        return readFileSync(path, "utf8")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
        throw error
      }
    },
    write(value) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, value)
    },
  }
}

/**
 * The next item, round-robin over `items`, persisting the position. With a
 * single item it always returns that one. `emptyMessage` is the error for
 * an empty list.
 */
export function nextRoundRobin<T>(
  items: readonly T[],
  store: CounterStore,
  emptyMessage = "Nothing to rotate through.",
): T {
  if (items.length === 0) throw new ConfigError(emptyMessage)
  const parsed = Number.parseInt(store.read() ?? "", 10)
  const index = Number.isInteger(parsed) && parsed >= 0 ? parsed : 0
  const position = index % items.length
  store.write(String(position + 1))
  return items[position]
}
