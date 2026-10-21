// SPDX-License-Identifier: Apache-2.0

// A virtual clock for tests of code that bounds its own waits: one source of
// truth for now(), sleep(), setTimeout() and clearTimeout(), so a 30-second
// request bound runs in microseconds and its arithmetic can be asserted
// exactly. run() drives a promise to settlement by firing the earliest
// armed timer whenever nothing else can make progress, and reports a
// deadlock (the promise is pending and no timer is armed: nothing can ever
// settle it) instead of hanging the test.

/** The handle the clock's setTimeout returns (shaped like Node's). */
export interface VirtualHandle {
  readonly id: number
  /** The delay it was armed with. */
  readonly ms: number
  /** True once unref() was called on it. */
  unrefd: boolean
  unref(): VirtualHandle
}

export type Outcome<T> =
  | { state: "resolved"; value: T; at: number }
  | { state: "rejected"; error: unknown; at: number }
  | { state: "deadlock"; at: number }
  | { state: "runaway"; at: number }

interface Armed {
  at: number
  fn: () => void
  /** A setTimeout() timer (the code's), not a sleep() (the clock's own). */
  handle?: VirtualHandle
}

export interface VirtualClock {
  readonly start: number
  now(): number
  sleep(ms: number): Promise<void>
  setTimeout(fn: () => void, ms: number): VirtualHandle
  clearTimeout(handle: unknown): void
  /** Every timer armed through setTimeout, in order. */
  readonly timers: VirtualHandle[]
  /** Every sleep() delay, in order. */
  readonly sleeps: number[]
  /** setTimeout timers still armed (not fired, not cleared). */
  armed(): VirtualHandle[]
  /** Drives `promise` to settlement; `at` is the clock's time then. */
  run<T>(promise: Promise<T>): Promise<Outcome<T>>
}

/** Turns of the event loop to let settled I/O-free work run between timers. */
const FLUSH_TURNS = 20

export function virtualClock(
  start = Date.parse("2026-10-13T10:00:00.000Z"),
): VirtualClock {
  let t = start
  let ids = 0
  const queue = new Map<number, Armed>()
  const timers: VirtualHandle[] = []
  const sleeps: number[] = []

  const arm = (fn: () => void, ms: number, handle?: VirtualHandle) => {
    const id = ++ids
    queue.set(id, { at: t + ms, fn, handle })
    return id
  }

  const clock: VirtualClock = {
    start,
    now: () => t,
    sleep: (ms) => {
      sleeps.push(ms)
      return new Promise<void>((resolve) => {
        arm(resolve, ms)
      })
    },
    setTimeout: (fn, ms) => {
      const handle: VirtualHandle = {
        id: 0,
        ms,
        unrefd: false,
        unref() {
          this.unrefd = true
          return this
        },
      }
      const id = arm(fn, ms, handle)
      ;(handle as { id: number }).id = id
      timers.push(handle)
      return handle
    },
    clearTimeout: (handle) => {
      const id = (handle as VirtualHandle | undefined)?.id
      if (id !== undefined) queue.delete(id)
    },
    timers,
    sleeps,
    armed: () =>
      [...queue.values()]
        .map((entry) => entry.handle)
        .filter((h): h is VirtualHandle => h !== undefined),
    async run<T>(promise: Promise<T>): Promise<Outcome<T>> {
      let outcome: Outcome<T> | undefined
      promise.then(
        (value) => {
          outcome = { state: "resolved", value, at: t }
        },
        (error: unknown) => {
          outcome = { state: "rejected", error, at: t }
        },
      )
      for (let step = 0; step < 10_000; step++) {
        for (let turn = 0; turn < FLUSH_TURNS && !outcome; turn++) {
          await new Promise((resolve) => setImmediate(resolve))
        }
        if (outcome) return outcome
        const next = [...queue.entries()].sort((a, b) => a[1].at - b[1].at)[0]
        // Pending with no timer armed: nothing can ever settle it.
        if (!next) return { state: "deadlock", at: t }
        queue.delete(next[0])
        t = Math.max(t, next[1].at)
        next[1].fn()
      }
      return { state: "runaway", at: t }
    },
  }
  return clock
}

/** Collects unhandled promise rejections while installed. */
export function unhandledRejections(): {
  readonly seen: unknown[]
  /** Lets pending rejections surface, then removes the listener. */
  stop(): Promise<unknown[]>
} {
  const seen: unknown[] = []
  const listener = (reason: unknown) => {
    seen.push(reason)
  }
  process.on("unhandledRejection", listener)
  return {
    seen,
    async stop() {
      for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      process.off("unhandledRejection", listener)
      return seen
    },
  }
}
