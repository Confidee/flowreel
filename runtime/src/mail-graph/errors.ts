// SPDX-License-Identifier: Apache-2.0

// The errors of the Graph mail driver. Every one is a GraphRequestError:
// it names the operation (e.g. "POST /users/qa%40example.com/sendMail" or
// "token request", never a URL's query or the request itself), whether the
// mail may have been sent, and the request's client-request-id. Messages
// arrive redacted from the driver and are kept on one line.

/** `message` on one line: every run of CR/LF (and the spaces around it) becomes one space. */
export function oneLine(message: string): string {
  return message.replace(/[^\S\r\n]*[\r\n]+[^\S\r\n]*/g, " ")
}

/**
 * The base of every error a Graph or token request ends in. The message is
 * already redacted and always one line (any line break becomes a space).
 *
 * `mayHaveSent` is true only for a request that sends mail (sendMail, a
 * reply draft's /send) that failed in a way that leaves the outcome open:
 * Graph may have accepted it. The driver never sends it again; check in
 * the mailbox (or the Exchange message trace) before any re-run.
 * `clientRequestId` is the id the request was sent with (the
 * `client-request-id` header): quote it to Microsoft support. It is
 * undefined only for a caller that waited for a token request another
 * caller had started.
 */
export class GraphRequestError extends Error {
  constructor(
    message: string,
    readonly operation: string,
    readonly mayHaveSent: boolean,
    readonly clientRequestId: string | undefined,
  ) {
    super(oneLine(message))
    this.name = "GraphRequestError"
  }
}

/** What a GraphHttpError knows besides its status (all optional). */
export interface GraphHttpErrorDetails {
  /** Default false. */
  mayHaveSent?: boolean
  clientRequestId?: string
  /** Graph's request-id (response header, else the body's innerError), GUID-shaped only. */
  requestId?: string
  /** The response's Date header, as an ISO 8601 instant, when it parses. */
  date?: string
  /** An Entra token error's trace_id, GUID-shaped only. */
  traceId?: string
  /** An Entra token error's correlation_id, GUID-shaped only. */
  correlationId?: string
  /**
   * The API's error code: Graph's `error.code` or Entra's `error` (e.g.
   * temporarily_unavailable), when code-shaped. Unlike
   * GraphTransportError.code, which is an OS or undici code.
   */
  code?: string
}

/**
 * A non-2xx Graph or Entra response. The message is already redacted and
 * names the status, the error code and the first line of the error text;
 * when the mail may have been sent it also names the client-request-id,
 * and Graph's request-id and date when known. The ids are kept as fields
 * whatever the outcome; none of them is a secret.
 */
export class GraphHttpError extends GraphRequestError {
  readonly requestId: string | undefined
  readonly date: string | undefined
  readonly traceId: string | undefined
  readonly correlationId: string | undefined
  readonly code: string | undefined

  constructor(
    message: string,
    operation: string,
    readonly status: number,
    /** From Retry-After (seconds or HTTP date), when the response sent one. */
    readonly retryAfterMs: number | undefined,
    details: GraphHttpErrorDetails = {},
  ) {
    super(
      message,
      operation,
      details.mayHaveSent ?? false,
      details.clientRequestId,
    )
    this.name = "GraphHttpError"
    this.requestId = details.requestId
    this.date = details.date
    this.traceId = details.traceId
    this.correlationId = details.correlationId
    this.code = details.code
  }
}

/**
 * A Graph or token request that got no answer within its bound
 * (requestTimeoutMs, or what a waitFor had left); the driver aborted it.
 * The message is already redacted and names the operation, never the
 * request. It carries no `cause`, and it is never a GraphHttpError or a
 * core TimeoutError. `mayHaveSent` is true only for a request that sends
 * mail: no answer came before the status line, so Graph may have accepted
 * it.
 */
export class GraphRequestTimeoutError extends GraphRequestError {
  constructor(
    message: string,
    operation: string,
    /** The bound the request had, in milliseconds. */
    readonly timeoutMs: number,
    mayHaveSent: boolean,
    clientRequestId?: string,
  ) {
    super(message, operation, mayHaveSent, clientRequestId)
    this.name = "GraphRequestTimeoutError"
  }
}

/**
 * A Graph or token request that failed below HTTP: no connection, a TLS
 * failure, a reset or closed socket, or a fetch that rejected. The message
 * is the transport error's own text, redacted, plus its system error code
 * when it has one; nothing else of the original error is kept, and there
 * is no `cause` (it may echo the request, Authorization header included).
 * On a sending request `mayHaveSent` is false only when the code proves
 * the request never left (a DNS, connect or TLS failure).
 */
export class GraphTransportError extends GraphRequestError {
  /** The system or undici error code (ECONNRESET, UND_ERR_SOCKET), when known. */
  readonly code: string | undefined

  constructor(
    message: string,
    operation: string,
    details: { code?: string; mayHaveSent: boolean; clientRequestId?: string },
  ) {
    super(message, operation, details.mayHaveSent, details.clientRequestId)
    this.name = "GraphTransportError"
    this.code = details.code
  }
}
