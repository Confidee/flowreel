// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "@playwright/test"

import {
  GraphHttpError,
  GraphRequestTimeoutError,
  GraphTransportError,
} from "../src/mail-graph/index.js"
import {
  isTransientRead,
  isTransientToken,
  statusMayHaveSent,
  tokenBackoffMs,
  transportCode,
  transportMayHaveSent,
} from "../src/mail-graph/outcome.js"

// The pure classifiers behind #17 and #18 (internal, not exported from the
// mail-graph entry point). The tripwire: an error that may have sent mail
// is never transient, whatever its status, so no future caller can retry a
// send through waitFor's re-poll.

const TOKEN = "token request"

test.describe("the may-have-sent tripwire", () => {
  test("isTransientRead is false for anything that may have sent", () => {
    expect(
      isTransientRead(new GraphHttpError("m", "GET /x", 503, undefined)),
    ).toBe(true)
    for (const error of [
      new GraphHttpError("m", "GET /x", 503, undefined, { mayHaveSent: true }),
      new GraphHttpError("m", "GET /x", 429, 1_000, { mayHaveSent: true }),
      new GraphRequestTimeoutError("m", "GET /x", 1_000, true),
      new GraphTransportError("m", "GET /x", { mayHaveSent: true }),
    ]) {
      expect(isTransientRead(error), error.name).toBe(false)
    }
  })

  test("isTransientToken is false for anything that may have sent", () => {
    expect(
      isTransientToken(new GraphHttpError("m", TOKEN, 503, undefined)),
    ).toBe(true)
    expect(
      isTransientToken(new GraphRequestTimeoutError("m", TOKEN, 1, false)),
    ).toBe(true)
    for (const error of [
      new GraphHttpError("m", TOKEN, 503, undefined, { mayHaveSent: true }),
      new GraphHttpError("m", TOKEN, 400, undefined, {
        mayHaveSent: true,
        code: "temporarily_unavailable",
      }),
      new GraphRequestTimeoutError("m", TOKEN, 1_000, true),
    ]) {
      expect(isTransientToken(error), error.name).toBe(false)
    }
  })
})

test.describe("which failures are transient", () => {
  test("reads: 429, 503 and 504 of a Graph read only", () => {
    for (const status of [429, 503, 504]) {
      expect(
        isTransientRead(new GraphHttpError("m", "GET /x", status, undefined)),
      ).toBe(true)
      expect(
        isTransientRead(new GraphHttpError("m", TOKEN, status, undefined)),
      ).toBe(false)
    }
    for (const status of [400, 401, 403, 404, 500, 502]) {
      expect(
        isTransientRead(new GraphHttpError("m", "GET /x", status, undefined)),
      ).toBe(false)
    }
    // A Graph read that got no answer is re-polled; a token one is not a read.
    expect(
      isTransientRead(new GraphRequestTimeoutError("m", "GET /x", 1, false)),
    ).toBe(true)
    expect(
      isTransientRead(new GraphRequestTimeoutError("m", TOKEN, 1, false)),
    ).toBe(false)
    expect(isTransientRead(new Error("x"))).toBe(false)
    expect(isTransientRead(null)).toBe(false)
  })

  test("tokens: 429, 500, 502, 503, 504, or error temporarily_unavailable", () => {
    for (const status of [429, 500, 502, 503, 504]) {
      expect(
        isTransientToken(new GraphHttpError("m", TOKEN, status, undefined)),
      ).toBe(true)
    }
    for (const status of [400, 401, 403]) {
      expect(
        isTransientToken(new GraphHttpError("m", TOKEN, status, undefined)),
      ).toBe(false)
      expect(
        isTransientToken(
          new GraphHttpError("m", TOKEN, status, undefined, {
            code: "temporarily_unavailable",
          }),
        ),
      ).toBe(true)
    }
    // A Graph read's error is not a token error, and a token transport error
    // stays fatal here (re-polling transport errors inside waitFor is #23).
    expect(
      isTransientToken(new GraphHttpError("m", "GET /x", 503, undefined)),
    ).toBe(false)
    expect(
      isTransientToken(new GraphRequestTimeoutError("m", "GET /x", 1, false)),
    ).toBe(false)
    expect(
      isTransientToken(
        new GraphTransportError("m", TOKEN, { mayHaveSent: false }),
      ),
    ).toBe(false)
    expect(isTransientToken(undefined)).toBe(false)
  })
})

test.describe("send outcome", () => {
  test("statuses: not sent for 3xx, 4xx and 509; may have been sent for any other 5xx", () => {
    for (const status of [300, 302, 304, 400, 401, 429, 499, 509]) {
      expect(statusMayHaveSent(status), String(status)).toBe(false)
    }
    for (const status of [500, 501, 502, 503, 504, 507, 510, 599]) {
      expect(statusMayHaveSent(status), String(status)).toBe(true)
    }
  })

  test("transport: only a closed list proves the request never left", () => {
    const fetchFailed = (cause: unknown) =>
      new TypeError("fetch failed", { cause })
    expect(transportMayHaveSent(fetchFailed({ code: "ECONNREFUSED" }))).toBe(
      false,
    )
    expect(
      transportMayHaveSent(fetchFailed({ syscall: "connect", code: "X" })),
    ).toBe(false)
    expect(transportMayHaveSent(fetchFailed({ syscall: "getaddrinfo" }))).toBe(
      false,
    )
    expect(
      transportMayHaveSent(fetchFailed({ code: "ERR_SSL_ANYTHING" })),
    ).toBe(false)
    expect(transportMayHaveSent({ code: "ENOTFOUND" })).toBe(false)
    for (const cause of [
      { code: "ECONNRESET", syscall: "read" },
      { code: "UND_ERR_SOCKET" },
      { code: "EPIPE", syscall: "write" },
      { code: 42 },
      {},
      null,
      "text",
    ]) {
      expect(
        transportMayHaveSent(fetchFailed(cause)),
        JSON.stringify(cause),
      ).toBe(true)
    }
    expect(transportMayHaveSent(null)).toBe(true)
    expect(transportMayHaveSent(undefined)).toBe(true)
    expect(transportMayHaveSent(new TypeError("fetch failed"))).toBe(true)
  })

  test("transport: a syscall decides on its own; the code list is only for errors without one", () => {
    const fetchFailed = (cause: unknown) =>
      new TypeError("fetch failed", { cause })
    // A pre-send code on a post-connect syscall: the connection was up.
    for (const [syscall, code] of [
      ["write", "EHOSTUNREACH"],
      ["read", "ENETUNREACH"],
      ["write", "ECONNREFUSED"],
      ["read", "CERT_HAS_EXPIRED"],
      ["write", "ERR_SSL_WRONG_VERSION_NUMBER"],
    ]) {
      expect(
        transportMayHaveSent(fetchFailed({ syscall, code })),
        `${syscall} ${code}`,
      ).toBe(true)
    }
    // A pre-send syscall decides whatever the code.
    expect(
      transportMayHaveSent(fetchFailed({ syscall: "connect", code: "EPIPE" })),
    ).toBe(false)
    // The TLS codes carry no syscall: the list decides.
    for (const code of [
      "CERT_NOT_YET_VALID",
      "CERT_REVOKED",
      "UNABLE_TO_GET_ISSUER_CERT",
      "HOSTNAME_MISMATCH",
      "ERR_TLS_HANDSHAKE_TIMEOUT",
    ]) {
      expect(transportMayHaveSent(fetchFailed({ code })), code).toBe(false)
    }
  })

  test("transport: an AggregateError proves it only when every inner error does", () => {
    const agg = (...errors: object[]) =>
      new TypeError("fetch failed", {
        cause: Object.assign(new AggregateError(errors, ""), {
          code: "ECONNREFUSED",
        }),
      })
    expect(
      transportMayHaveSent(
        agg(
          { code: "ECONNREFUSED" },
          { code: "EHOSTUNREACH", syscall: "connect" },
        ),
      ),
    ).toBe(false)
    expect(
      transportMayHaveSent(
        agg({ code: "ECONNREFUSED" }, { code: "ECONNRESET", syscall: "read" }),
      ),
    ).toBe(true)
    expect(transportMayHaveSent(agg())).toBe(true)
  })
})

test.describe("the transport code", () => {
  test("the cause's code, else the error's, else an aggregate's first inner one; code-shaped only", () => {
    const fetchFailed = (cause: unknown) =>
      new TypeError("fetch failed", { cause })
    expect(transportCode(fetchFailed({ code: "ECONNRESET" }))).toBe(
      "ECONNRESET",
    )
    expect(transportCode({ code: "ENOTFOUND" })).toBe("ENOTFOUND")
    expect(
      transportCode(
        fetchFailed(new AggregateError([{ code: "EHOSTUNREACH" }], "")),
      ),
    ).toBe("EHOSTUNREACH")
    // May have sent: the inner error that decided it is named, not the
    // aggregate's own code.
    expect(
      transportCode(
        fetchFailed(
          Object.assign(
            new AggregateError(
              [
                { code: "ECONNREFUSED", syscall: "connect" },
                { code: "ECONNRESET", syscall: "read" },
              ],
              "",
            ),
            { code: "ECONNREFUSED" },
          ),
        ),
      ),
    ).toBe("ECONNRESET")
    // Proven not sent: the aggregate's own code.
    expect(
      transportCode(
        fetchFailed(
          Object.assign(
            new AggregateError(
              [
                { code: "ECONNREFUSED", syscall: "connect" },
                { code: "EHOSTUNREACH", syscall: "connect" },
              ],
              "",
            ),
            { code: "ECONNREFUSED" },
          ),
        ),
      ),
    ).toBe("ECONNREFUSED")
    expect(
      transportCode(fetchFailed(new AggregateError([], ""))),
    ).toBeUndefined()
    expect(
      transportCode(fetchFailed({ code: "has spaces; and more" })),
    ).toBeUndefined()
    expect(transportCode(fetchFailed({ code: 20 }))).toBeUndefined()
    expect(transportCode(null)).toBeUndefined()
    expect(transportCode(new TypeError("fetch failed"))).toBeUndefined()
  })
})

test.describe("the token back-off", () => {
  test("Retry-After exactly, else 5 s doubling up to 60 s, never past the time left", () => {
    expect(tokenBackoffMs(7_000, 1, 60_000)).toBe(7_000)
    expect(tokenBackoffMs(2_000, 3, 60_000)).toBe(2_000)
    expect(tokenBackoffMs(0, 1, 60_000)).toBe(0)
    expect(tokenBackoffMs(120_000, 1, 30_000)).toBe(30_000)
    expect(
      [1, 2, 3, 4, 5, 6, 40].map((n) => tokenBackoffMs(undefined, n, 1e9)),
    ).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000])
    expect(tokenBackoffMs(undefined, 2, 4_000)).toBe(4_000)
    expect(tokenBackoffMs(undefined, 1, -5)).toBe(0)
  })
})
