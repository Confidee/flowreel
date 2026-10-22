// SPDX-License-Identifier: Apache-2.0

import type { APIRequest } from "@playwright/test"

import { ConfigError } from "../core/errors.js"
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  assertRequestTimeoutMs,
  requestFailure,
} from "../core/http.js"
import type { StorageState } from "./personas.js"

// Session protocol helpers: is a stored session still signed in, and
// revoking it at the end of a run. Traces and the HTML report record
// request headers, so every one of them holds the personas' session cookie;
// teardown revokes each server-side session so the cookie in those files is
// dead before anyone opens them. Never throws; never echoes a cookie value.

/** What one authenticated request answered. */
export interface SessionAnswer {
  status: number
  /** The Location header of a redirect, if any. */
  location?: string
}

/** How the app under test signs a session out and shows a signed-out one. */
export interface SessionProtocol {
  /** A page every signed-in persona can GET (default "/"). */
  probePath?: string
  /** True for the path a signed-out request is redirected to. */
  isSignInPath(pathname: string): boolean
  /** The request that revokes the current session. */
  signOut: { method: "DELETE" | "POST"; path: string }
  /**
   * CSRF: the cookie a page GET sets, sent back URL-decoded in `header` on
   * the sign-out request (omit when the app needs none).
   */
  csrf?: { cookie: string; header: string }
  /**
   * How long each probe and the sign-out may take, from the connection to
   * the last byte of the body, in milliseconds. Default 30 000. A whole
   * number from 1 to 2 147 483 647, else a ConfigError. It overrides the
   * project's actionTimeout for these requests.
   */
  requestTimeoutMs?: number
}

/** The protocol's request bound, validated (a ConfigError naming the option). */
function boundOf(protocol: SessionProtocol): number {
  const ms = protocol.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  assertRequestTimeoutMs(ms, "SessionProtocol requestTimeoutMs")
  return ms
}

/** Path only: never echo a query string (a reset token could live there). */
export function safePath(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return "(unknown)"
  }
}

/**
 * "Signed out" for a keepalive answer: a 401, or a redirect whose path is
 * exactly `signInPath`.
 */
export function signedOutBy(
  signInPath: string,
): (answer: SessionAnswer) => boolean {
  return (answer) => {
    if (answer.status === 401) return true
    if (answer.status < 300 || answer.status >= 400) return false
    try {
      return new URL(answer.location ?? "", "http://x").pathname === signInPath
    } catch {
      return false
    }
  }
}

/**
 * True when the probe with this state is bounced to the sign-in page. A
 * probe that fails (no answer within requestTimeoutMs, a refused
 * connection) throws an Error naming the probe and the first line of
 * Playwright's message only: its call log carries the session cookie.
 */
export async function isSessionSignedOut(
  api: APIRequest,
  baseURL: string,
  state: StorageState,
  protocol: SessionProtocol,
): Promise<boolean> {
  const timeout = boundOf(protocol)
  const probePath = protocol.probePath ?? "/"
  const context = await api.newContext({
    baseURL,
    storageState: state,
    maxRedirects: 0,
    timeout,
  })
  try {
    let response: Awaited<ReturnType<typeof context.get>>
    try {
      response = await context.get(probePath)
    } catch (error) {
      // No cause: the original's message and stack hold the call log.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(
        `Session probe GET ${probePath.split("?")[0]} failed: ${requestFailure(error)}`,
      )
    }
    const location = response.headers().location ?? ""
    return (
      response.status() >= 300 &&
      response.status() < 400 &&
      protocol.isSignInPath(safePath(new URL(location, baseURL).href))
    )
  } finally {
    await context.dispose()
  }
}

/**
 * Revokes a persona's session: sign-out request (CSRF from the cookie a
 * probe GET refreshes), then a fresh context with the ORIGINAL state proves
 * the session is dead. Never throws: a failure is revoked: false, whose
 * detail names the HTTP status, the error's class or, for a bad
 * requestTimeoutMs, the option; never a cookie.
 */
export async function revokeSession(
  api: APIRequest,
  baseURL: string,
  state: StorageState,
  protocol: SessionProtocol,
): Promise<{ revoked: boolean; detail: string }> {
  const { method, path } = protocol.signOut
  try {
    // A bad requestTimeoutMs ends here too: teardown must go on to the
    // next persona, and its revoked: false is the loud warning.
    const timeout = boundOf(protocol)
    if (await isSessionSignedOut(api, baseURL, state, protocol)) {
      return { revoked: true, detail: "already signed out" }
    }
    const context = await api.newContext({
      baseURL,
      storageState: state,
      maxRedirects: 0,
      timeout,
    })
    let status: number
    try {
      await context.get(protocol.probePath ?? "/")
      const csrf = protocol.csrf
      const token = csrf
        ? (await context.storageState()).cookies.find(
            (cookie) => cookie.name === csrf.cookie,
          )
        : undefined
      const headers =
        csrf && token ? { [csrf.header]: decodeURIComponent(token.value) } : {}
      const response =
        method === "DELETE"
          ? await context.delete(path, { headers })
          : await context.post(path, { headers })
      status = response.status()
    } finally {
      await context.dispose()
    }
    return (await isSessionSignedOut(api, baseURL, state, protocol))
      ? { revoked: true, detail: `${method} ${path} -> ${status}` }
      : {
          revoked: false,
          detail: `${method} ${path} -> ${status}, session still valid`,
        }
  } catch (error) {
    // A ConfigError names the option, never a value; anything else only
    // by its class (a Playwright message carries the session cookie).
    return {
      revoked: false,
      detail:
        error instanceof ConfigError ? error.message : (error as Error).name,
    }
  }
}
