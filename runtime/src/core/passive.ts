// SPDX-License-Identifier: Apache-2.0

// Signal listeners flowreel adds only to observe or to end its own work
// (the stage guard's SIGINT observer, the summary reporter's stop
// listeners). They are marked, so code that asks "is Playwright's runner
// handling Ctrl-C right now?" can leave them out. Internal: not exported
// from the core barrel.

const PASSIVE = Symbol.for("flowreel.passiveSignalListener")

/** Marks `listener` as one of flowreel's passive signal listeners. */
export function markPassive<T extends (...args: never[]) => unknown>(
  listener: T,
): T {
  ;(listener as unknown as Record<symbol, boolean>)[PASSIVE] = true
  return listener
}

/** Whether `listener` was marked with {@link markPassive}. */
export function isPassive(listener: unknown): boolean {
  return (
    typeof listener === "function" &&
    (listener as unknown as Record<symbol, boolean>)[PASSIVE] === true
  )
}
