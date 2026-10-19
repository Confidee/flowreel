// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks"

// The stop signal of a video composition. The summary reporter runs the
// project's composer inside withMediaSignal(); every tool the composition
// starts (ffmpeg, ffprobe, the voice engine) and the card renderer's browser
// read it with mediaSignal() and stop when it aborts, so a Ctrl-C during
// composition ends the run within moments instead of after the encode. The
// store lives on a global symbol: the reporter and the project's composer
// may load this module through different paths (import and require).
// Internal: not exported from the video barrel.

const KEY = Symbol.for("flowreel.mediaSignal")

function store(): AsyncLocalStorage<AbortSignal> {
  const holder = globalThis as { [KEY]?: AsyncLocalStorage<AbortSignal> }
  holder[KEY] ??= new AsyncLocalStorage<AbortSignal>()
  return holder[KEY]
}

/** Runs `work` with `signal` as the media stop signal (none: as it is). */
export function withMediaSignal<T>(
  signal: AbortSignal | undefined,
  work: () => Promise<T>,
): Promise<T> {
  return signal ? store().run(signal, work) : work()
}

/** The stop signal of the composition this code runs in, if any. */
export function mediaSignal(): AbortSignal | undefined {
  return store().getStore()
}

/** Whether a tool's error is the stop signal's doing. */
export function stoppedError(error: { name?: string } | null): boolean {
  return error?.name === "AbortError"
}
