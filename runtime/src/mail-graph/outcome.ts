// SPDX-License-Identifier: Apache-2.0

import {
  GraphHttpError,
  GraphRequestError,
  GraphRequestTimeoutError,
} from "./errors.js"

// What a failed Graph request means: whether a send may have gone out
// (#17) and which failures waitFor may re-poll (#18). Pure functions,
// internal to the mail-graph adapter (not exported from its entry point).
//
// The tripwire: both transient classifiers return false first thing for an
// error that may have sent mail, so a send can never be retried through
// waitFor's re-poll, whatever its status.

/** The operation name of the shared token request. */
export const TOKEN_OPERATION = "token request"

// Throttling / gateway blips on the waitFor list READ are re-polled.
const TRANSIENT_READ_STATUSES = new Set([429, 503, 504])
// A token request that is throttled or meets a server error (Entra's
// guidance for daemon apps): re-polled inside waitFor only.
const TRANSIENT_TOKEN_STATUSES = new Set([429, 500, 502, 503, 504])
/** The OAuth `error` that means "try again later", whatever the status. */
const TRANSIENT_TOKEN_ERROR = "temporarily_unavailable"
/** The first token back-off without Retry-After; it doubles from there. */
const MIN_TOKEN_BACKOFF_MS = 5_000
const MAX_TOKEN_BACKOFF_MS = 60_000

/** Phases in which nothing of the request was written. */
const PRE_SEND_SYSCALLS = new Set(["getaddrinfo", "connect"])
/**
 * Codes that prove the request never left: DNS, connect and TLS failures.
 * Consulted only for an error without a syscall (TLS errors carry none):
 * the same code on a read or write came after the connection was up.
 */
const PRE_SEND_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_FAIL",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_GET_ISSUER_CERT",
  "CERT_NOT_YET_VALID",
  "CERT_REVOKED",
  "HOSTNAME_MISMATCH",
  "ERR_TLS_HANDSHAKE_TIMEOUT",
])
const CODE_SHAPE = /^[A-Za-z0-9_]{1,64}$/

function mayHaveSent(error: unknown): boolean {
  return error instanceof GraphRequestError && error.mayHaveSent
}

/**
 * True when a sending POST answered with `status` may have sent the mail:
 * any 5xx but 509. Any 3xx or 4xx (429 included) and 509 were not
 * processed. 503 counts as may-have-sent on purpose: a false "may have
 * been sent" costs a search, a false "not sent" can cost a duplicate mail.
 */
export function statusMayHaveSent(status: number): boolean {
  return status >= 500 && status !== 509
}

/** The error's cause when it has one (fetch's TypeError), else the error itself. */
function subjectOf(error: unknown): unknown {
  return typeof error === "object" && error !== null && "cause" in error
    ? (error as { cause?: unknown }).cause
    : error
}

function provesNotSent(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const { syscall, code, errors } = error as {
    syscall?: unknown
    code?: unknown
    errors?: unknown
  }
  // Happy eyeballs: every address must have failed before any byte left.
  if (Array.isArray(errors)) {
    return errors.length > 0 && errors.every(provesNotSent)
  }
  // A syscall decides on its own: `write EHOSTUNREACH` or `read
  // ENETUNREACH` came after the connection was up.
  if (typeof syscall === "string") return PRE_SEND_SYSCALLS.has(syscall)
  return (
    typeof code === "string" &&
    (PRE_SEND_CODES.has(code) || code.startsWith("ERR_SSL_"))
  )
}

/**
 * True unless the transport error proves the request never left: its cause
 * (or the error itself, when it has no cause) failed in getaddrinfo or
 * connect, or, when it names no syscall, has a DNS, connect or TLS code;
 * an AggregateError only when every inner error does. Anything else (a reset or closed socket, a
 * "terminated" body, EPIPE, an unknown or missing code, a null rejection)
 * may have sent the request.
 */
export function transportMayHaveSent(error: unknown): boolean {
  return !provesNotSent(subjectOf(error))
}

/**
 * The transport error's code (from its cause, else itself), when it is
 * code-shaped. For an AggregateError that may have sent, the code of the
 * first inner error that did not prove the request never left (none when
 * that error has none); for one that proved it, its own code, else its
 * first inner one. Nothing else of the error.
 */
export function transportCode(error: unknown): string | undefined {
  const subject = subjectOf(error) as
    { code?: unknown; errors?: unknown } | null | undefined
  const shaped = (code: unknown) =>
    typeof code === "string" && CODE_SHAPE.test(code) ? code : undefined
  const own = shaped(subject?.code)
  const errors = Array.isArray(subject?.errors) ? subject.errors : []
  if (errors.length === 0) return own
  const deciding = errors.find((inner) => !provesNotSent(inner)) as
    { code?: unknown } | undefined
  if (deciding !== undefined) return shaped(deciding?.code)
  return own ?? shaped((errors[0] as { code?: unknown }).code)
}

/**
 * True for a waitFor read that may be polled again: a Graph read's 429,
 * 503 or 504, or a Graph read that got no answer. Never a token request
 * (isTransientToken decides those), and never anything that may have sent
 * mail.
 */
export function isTransientRead(
  error: unknown,
): error is GraphHttpError | GraphRequestTimeoutError {
  if (mayHaveSent(error)) return false
  if (
    !(
      error instanceof GraphHttpError ||
      error instanceof GraphRequestTimeoutError
    ) ||
    error.operation === TOKEN_OPERATION
  ) {
    return false
  }
  return (
    error instanceof GraphRequestTimeoutError ||
    TRANSIENT_READ_STATUSES.has(error.status)
  )
}

/**
 * True for a token request waitFor may try again: HTTP 429, 500, 502, 503
 * or 504, an OAuth `error` of temporarily_unavailable at any status, or no
 * answer. Never keyed on error_description. A bad secret, tenant or
 * consent (400, 401 otherwise) and a transport error are not transient,
 * and neither is anything that may have sent mail.
 */
export function isTransientToken(
  error: unknown,
): error is GraphHttpError | GraphRequestTimeoutError {
  if (mayHaveSent(error)) return false
  if (error instanceof GraphRequestTimeoutError) {
    return error.operation === TOKEN_OPERATION
  }
  return (
    error instanceof GraphHttpError &&
    error.operation === TOKEN_OPERATION &&
    (TRANSIENT_TOKEN_STATUSES.has(error.status) ||
      error.code === TRANSIENT_TOKEN_ERROR)
  )
}

/**
 * How long to wait before the next token attempt: Retry-After exactly when
 * the response sent one, else 5 s doubling with each consecutive failure
 * (`attempt` 1, 2, 3 …) up to 60 s; never more than `leftMs`, never less
 * than 0.
 */
export function tokenBackoffMs(
  retryAfterMs: number | undefined,
  attempt: number,
  leftMs: number,
): number {
  const ms =
    retryAfterMs ??
    Math.min(
      MAX_TOKEN_BACKOFF_MS,
      MIN_TOKEN_BACKOFF_MS * 2 ** Math.max(0, attempt - 1),
    )
  return Math.max(0, Math.min(ms, leftMs))
}
