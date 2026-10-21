// SPDX-License-Identifier: Apache-2.0

import { ConfigError } from "./errors.js"

// One HTTP request bounded as a whole, shared by the Graph mail driver and
// the seam client (issues #16 and #20). Internal: not exported from the
// core entry point. Nothing here knows about Graph or the seams: the caller
// builds its own timeout error, and wraps or redacts any other failure.

/** The bound of one request when the project sets none. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
/** setTimeout's longest delay. */
export const MAX_TIMER_MS = 2_147_483_647

/** A timer handle (Node's, or a test's). */
export interface TimerHandle {
  unref?(): unknown
}

/** The timer seams a caller may inject (tests). */
export interface BoundTimers {
  /** Arms a request's bound. Default: setTimeout. Always unref'd. */
  setTimeout?: (fn: () => void, ms: number) => TimerHandle
  /** Default: clearTimeout. */
  clearTimeout?: (timer: TimerHandle) => void
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** One request's answer, its body read in full within the bound. */
export interface BoundedReply {
  status: number
  ok: boolean
  headers: Headers
  text: string
}

export interface FetchWithinOptions extends BoundTimers {
  /**
   * Whether to read this response's body. Default: always. When false, the
   * body is cancelled (any error ignored) and the reply's text is "": the
   * status alone is the answer.
   */
  readBody?: (response: Response) => boolean
  /** Called once the status line arrived, before the body is read. */
  onResponse?: (response: Response) => void
}

/**
 * Throws a ConfigError unless `value` is a whole number of milliseconds
 * from 1 to 2 147 483 647. The message names the option (`optionName`,
 * e.g. "GraphMailDriver option requestTimeoutMs"), never the value.
 */
export function assertRequestTimeoutMs(
  value: unknown,
  optionName: string,
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_TIMER_MS
  ) {
    throw new ConfigError(
      `${optionName} must be a whole number of milliseconds from 1 to ${MAX_TIMER_MS}.`,
    )
  }
}

/** A URL's query string or fragment: a reset or sign-in token can live there. */
const URL_QUERY = /(\bhttps?:\/\/[^\s?#"'<>]*)[?#][^\s"'<>]*/gi

/** `text` with every http(s) URL's query string and fragment removed. */
export function withoutUrlQueries(text: string): string {
  return text.replace(URL_QUERY, "$1")
}

/**
 * `text` up to Playwright's "Call log:" line: the log below it names the
 * full URL, every request header (a session cookie, a CSRF token) and a
 * response's set-cookie (#26).
 */
export function withoutCallLog(text: string): string {
  const at = text.search(/^\s*Call log:/m)
  return at === -1 ? text : text.slice(0, at).trimEnd()
}

/**
 * What may be said of a failed Playwright request: the first line of its
 * message, without a URL query, at most 300 characters. Never its call
 * log, its stack or its cause. Rethrow it in a new error with no cause.
 */
export function requestFailure(error: unknown): string {
  const message =
    error instanceof Error ? error.message : String(error ?? "unknown error")
  const first = withoutCallLog(message).split(/\r?\n/)[0]?.trim() ?? ""
  return withoutUrlQueries(first).slice(0, 300) || "request failed"
}

/** "30 s" for whole seconds, else "300 ms". */
export function formatBound(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`
}

/**
 * Runs `fetchImpl(url, init + signal)` and reads the whole body, all within
 * `ms`. At the bound the request is aborted (with `timeout` as the reason)
 * and the returned promise rejects with `timeout` itself, the caller's own
 * error instance: the caller tells its bound from any other AbortError by
 * identity, never by name. A fetch that ignores its signal, or a body that
 * never ends, still ends at the bound: both are raced against it.
 *
 * Any other failure is rethrown as is: the caller wraps and redacts it. A
 * non-2xx whose body cannot be read comes back with an empty text (its
 * status is the answer); a 2xx whose body cannot be read is a failure,
 * unless `readBody` said not to read it.
 *
 * One AbortController and one timer per request. The timer never keeps the
 * process alive on its own (unref'd) and is cleared however the request
 * ends. A plain AbortController and timer on purpose, not
 * AbortSignal.timeout or AbortSignal.any: on Node 20 their signals can be
 * garbage-collected mid-request and never fire (nodejs/node#57736).
 */
export async function fetchWithin(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  ms: number,
  timeout: Error,
  options: FetchWithinOptions = {},
): Promise<BoundedReply> {
  const setTimer = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer =
    options.clearTimeout ??
    ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const controller = new AbortController()
  let expire!: (reason: Error) => void
  const expired = new Promise<never>((_, reject) => {
    expire = reject
  })
  expired.catch(() => {})
  const timer = setTimer(() => {
    // Rejected first, so the race settles with the caller's own error.
    expire(timeout)
    controller.abort(timeout)
  }, ms)
  // A real fetch holds a socket until the bound fires; a mocked or custom
  // fetch that holds no handle may let the process exit before it does.
  timer.unref?.()
  try {
    const response = await Promise.race([
      fetchImpl(url, { ...init, signal: controller.signal }),
      expired,
    ])
    options.onResponse?.(response)
    if (options.readBody && !options.readBody(response)) {
      try {
        response.body?.cancel().catch(() => {})
      } catch {
        // A body that cannot even be cancelled changes nothing: unread.
      }
      return {
        status: response.status,
        ok: response.ok,
        headers: response.headers,
        text: "",
      }
    }
    const text = await Promise.race([response.text(), expired]).catch(
      (error: unknown) => {
        // A failed reply whose body cannot be read is reported by its
        // status alone; a 2xx whose body cannot be read is a failure.
        if (response.ok || controller.signal.reason === timeout) throw error
        return ""
      },
    )
    return {
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      text,
    }
  } catch (error) {
    if (error === timeout || controller.signal.reason === timeout) {
      throw timeout
    }
    throw error
  } finally {
    clearTimer(timer)
  }
}
