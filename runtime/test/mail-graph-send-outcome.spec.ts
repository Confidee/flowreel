// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "@playwright/test"

import { SendRefusedError } from "../src/core/index.js"
import * as mailGraph from "../src/mail-graph/index.js"
import type { GraphMailDriver } from "../src/mail-graph/index.js"
import {
  type Answer,
  type Call,
  MAILBOX_PATH,
  MAY_HAVE_SENT,
  SECRET,
  TOKEN,
  UUID_V4,
  brokenBody,
  clientRequestIdOf,
  clocks,
  draftSteps,
  driver,
  fakeFetch,
  isCreateReply,
  isDraftSend,
  isOneLine,
  isPatch,
  isSendMail,
  isToken,
  json,
  leakedSecrets,
  mail,
  mayHaveSentOf,
  original,
  rejected,
  replyMail,
  stalledBody,
} from "./graph-fake.js"
import { unhandledRejections, virtualClock } from "./virtual-clock.js"

// Issue #17: what a failed sending POST (sendMail, a reply draft's /send)
// means for the mail. MAY have been sent: a transport error once the
// request may have left (anything but a closed list of connect-phase and
// TLS failures), HTTP 500, 502, 503, 504 and any other 5xx but 509, and no
// answer before the status line (#16). NOT sent: any 3xx or 4xx (429
// included), 509, a connect-phase or TLS failure, a guard refusal and a
// token failure. A 2xx status means sent, even when its (empty) body then
// fails. Nothing is ever retried. createReply and the PATCH never send.

// Read through the namespace: these classes are new in #17.
const { GraphHttpError, GraphRequestError, GraphTransportError } = mailGraph
type GraphRequestErrorShape = InstanceType<typeof mailGraph.GraphRequestError>
type GraphTransportErrorShape = InstanceType<
  typeof mailGraph.GraphTransportError
>
type GraphHttpErrorShape = InstanceType<typeof mailGraph.GraphHttpError>

/** An undici-like `fetch failed` with an optional cause. */
function fetchFailed(cause?: unknown, message = "fetch failed"): TypeError {
  return cause === undefined
    ? new TypeError(message)
    : new TypeError(message, { cause })
}

/** A system error whose message echoes the secret and the token. */
function systemError(code: string, syscall?: string): Error {
  return Object.assign(
    new Error(`${syscall ?? "io"} ${code} ${SECRET} Bearer ${TOKEN}`),
    syscall === undefined ? { code } : { code, syscall },
  )
}

/** undici's SocketError: the other side closed a request it had started. */
function socketError(): Error {
  return Object.assign(new Error("other side closed"), {
    name: "SocketError",
    code: "UND_ERR_SOCKET",
  })
}

/** Node's happy-eyeballs AggregateError: its own code is the first one's. */
function aggregate(...errors: Error[]): AggregateError {
  return Object.assign(new AggregateError(errors, ""), {
    code: (errors[0] as { code?: string } | undefined)?.code ?? "",
  })
}

function foreignAbort(): Error {
  const error = new Error("This operation was aborted")
  error.name = "AbortError"
  return error
}

/** A Graph error reply whose message echoes the token. */
function graphError(
  status: number,
  code: string,
  headers: Record<string, string> = {},
): Response {
  return json(
    status,
    { error: { code, message: `upstream said Bearer ${TOKEN} ${SECRET}` } },
    headers,
  )
}

/** The statuses after which the mail may have gone out. */
const MAY_HAVE_SENT_STATUSES: [number, string][] = [
  [500, "InternalServerError"],
  [502, "BadGateway"],
  // Decision (#17): 503 may have been sent too. A false "may have been
  // sent" costs a search; a false "not sent" can cost a duplicate mail.
  [503, "ServiceUnavailable"],
  [504, "GatewayTimeout"],
  [507, "InsufficientStorage"],
]

/** The statuses that mean the sending POST was not processed. */
const NOT_SENT_STATUSES: [number, string, Record<string, string>][] = [
  [302, "Found", { Location: "https://example.com/elsewhere" }],
  [400, "ErrorInvalidRecipients", {}],
  [401, "InvalidAuthenticationToken", {}],
  [403, "ErrorAccessDenied", {}],
  [404, "ErrorItemNotFound", {}],
  [413, "ErrorMessageSizeExceeded", {}],
  [429, "TooManyRequests", { "Retry-After": "7" }],
  [509, "BandwidthLimitExceeded", {}],
]

/** Transport failures after which the request may have left: [name, failure, code]. */
const MAY_HAVE_SENT_TRANSPORT: [string, () => Answer, string | undefined][] = [
  [
    "read ECONNRESET",
    () => fetchFailed(systemError("ECONNRESET", "read")),
    "ECONNRESET",
  ],
  [
    "UND_ERR_SOCKET other side closed",
    () => fetchFailed(socketError()),
    "UND_ERR_SOCKET",
  ],
  [
    "terminated",
    () => fetchFailed(socketError(), "terminated"),
    "UND_ERR_SOCKET",
  ],
  ["write EPIPE", () => fetchFailed(systemError("EPIPE", "write")), "EPIPE"],
  [
    "an unknown code",
    () => fetchFailed(systemError("ESOMETHINGNEW")),
    "ESOMETHINGNEW",
  ],
  ["a bare fetch failed", () => fetchFailed(), undefined],
  [
    "a cause with no code",
    () => fetchFailed(new Error(`other ${SECRET}`)),
    undefined,
  ],
  [
    "a null rejection",
    () => Promise.reject(null) as Promise<Response>,
    undefined,
  ],
  ["a foreign AbortError", foreignAbort, undefined],
  [
    "an AggregateError with one post-send error",
    () =>
      fetchFailed(
        aggregate(
          systemError("ECONNREFUSED", "connect"),
          systemError("ECONNRESET", "read"),
        ),
      ),
    // Review: the code named is the inner error's that decided it, not the
    // aggregate's own (first) one.
    "ECONNRESET",
  ],
  [
    "an AggregateError whose deciding error has no code",
    () =>
      fetchFailed(
        aggregate(
          systemError("ECONNREFUSED", "connect"),
          new Error("other side closed"),
        ),
      ),
    undefined,
  ],
  // Review: a pre-send code on a post-connect syscall proves nothing: the
  // connection was up, so the request may have left.
  [
    "write EHOSTUNREACH",
    () => fetchFailed(systemError("EHOSTUNREACH", "write")),
    "EHOSTUNREACH",
  ],
  [
    "read ENETUNREACH",
    () => fetchFailed(systemError("ENETUNREACH", "read")),
    "ENETUNREACH",
  ],
  [
    "write ECONNREFUSED",
    () => fetchFailed(systemError("ECONNREFUSED", "write")),
    "ECONNREFUSED",
  ],
  [
    "read ERR_TLS_HANDSHAKE_TIMEOUT",
    () => fetchFailed(systemError("ERR_TLS_HANDSHAKE_TIMEOUT", "read")),
    "ERR_TLS_HANDSHAKE_TIMEOUT",
  ],
  [
    "an AggregateError with no inner errors",
    () =>
      fetchFailed(
        Object.assign(new AggregateError([], ""), { code: "ECONNREFUSED" }),
      ),
    "ECONNREFUSED",
  ],
]

/** The codes that prove the request never left (closed list, #17). */
const PRE_SEND_CODES = [
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_FAIL",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_NOT_YET_VALID",
  "CERT_REVOKED",
  "UNABLE_TO_GET_ISSUER_CERT",
  "HOSTNAME_MISMATCH",
  "ERR_TLS_HANDSHAKE_TIMEOUT",
]

/**
 * Transport failures that prove the request never left: [name, failure,
 * code, the text the message shows before the code].
 */
const NOT_SENT_TRANSPORT: [string, () => Answer, string, string][] = [
  ...PRE_SEND_CODES.map((code): [string, () => Answer, string, string] => [
    code,
    () => fetchFailed(systemError(code)),
    code,
    "fetch failed",
  ]),
  ...PRE_SEND_CODES.map((code): [string, () => Answer, string, string] => [
    `AggregateError of ${code}`,
    () =>
      fetchFailed(
        aggregate(systemError(code, "connect"), systemError(code, "connect")),
      ),
    code,
    "fetch failed",
  ]),
  [
    "getaddrinfo with another code",
    () => fetchFailed(systemError("ESERVFAIL", "getaddrinfo")),
    "ESERVFAIL",
    "fetch failed",
  ],
  [
    "connect ECONNRESET (a reset TLS handshake)",
    () => fetchFailed(systemError("ECONNRESET", "connect")),
    "ECONNRESET",
    "fetch failed",
  ],
  [
    "a connect-phase error a custom fetch rejects with as is",
    () => systemError("ECONNREFUSED", "connect"),
    "ECONNREFUSED",
    "connect ECONNREFUSED [redacted] Bearer [redacted]",
  ],
]

interface Path {
  run: (d: GraphMailDriver) => Promise<unknown>
  /** The request that sends the mail. */
  sending: (call: Call) => boolean
  /** Answers for the steps before the sending POST. */
  before: (call: Call) => Answer
  /** The sending POST's operation, as errors name it. */
  operation: string
}

const PATHS: Record<"send" | "reply", Path> = {
  send: {
    run: (d) => d.send(mail),
    sending: isSendMail,
    before: () => undefined,
    operation: `POST ${MAILBOX_PATH}/sendMail`,
  },
  reply: {
    run: (d) => d.reply(original, replyMail),
    sending: isDraftSend,
    before: draftSteps,
    operation: `POST ${MAILBOX_PATH}/messages/draft-1/send`,
  },
}

let rejections: ReturnType<typeof unhandledRejections>
test.beforeEach(() => {
  rejections = unhandledRejections()
})
test.afterEach(async () => {
  for (const c of clocks.splice(0)) {
    expect(c.armed().map((h) => h.ms)).toEqual([])
  }
  expect(await rejections.stop()).toEqual([])
})

/** Runs `path` with the sending POST answered by `failure`. */
async function failSend(path: Path, failure: () => Answer) {
  const c = virtualClock()
  const { fetch, calls } = fakeFetch(c, (call) =>
    path.sending(call) ? failure() : path.before(call),
  )
  const error = rejected(await c.run(path.run(driver(c, fetch))))
  const sends = calls.filter(path.sending)
  // Never retried.
  expect(sends).toHaveLength(1)
  const id = clientRequestIdOf(sends[0])
  expect(id).toMatch(UUID_V4)
  return { error, id }
}

for (const [pathName, path] of Object.entries(PATHS)) {
  test.describe(`${pathName}: the sending POST`, () => {
    for (const [status, code] of MAY_HAVE_SENT_STATUSES) {
      test(`HTTP ${status} may have been sent, and is sent once`, async () => {
        const { error, id } = await failSend(path, () =>
          graphError(status, code),
        )
        expect(error).toBeInstanceOf(GraphHttpError)
        expect(error).toBeInstanceOf(GraphRequestError)
        const http = error as GraphHttpErrorShape
        expect(http.status).toBe(status)
        expect(http.operation).toBe(path.operation)
        expect(http.mayHaveSent).toBe(true)
        expect(http.clientRequestId).toBe(id)
        expect(http.message).toContain(`HTTP ${status} ${code}`)
        expect(http.message).toContain(MAY_HAVE_SENT)
        expect(http.message).toContain(`client-request-id ${id}`)
        expect(isOneLine(http.message)).toBe(true)
        expect(leakedSecrets(error)).toEqual([])
      })
    }

    for (const [status, code, headers] of NOT_SENT_STATUSES) {
      test(`HTTP ${status} was not sent, and is not retried`, async () => {
        const { error, id } = await failSend(path, () =>
          graphError(status, code, headers),
        )
        expect(error).toBeInstanceOf(GraphHttpError)
        expect(error).toBeInstanceOf(GraphRequestError)
        const http = error as GraphHttpErrorShape
        expect(http.status).toBe(status)
        expect(http.operation).toBe(path.operation)
        expect(http.mayHaveSent).toBe(false)
        expect(http.clientRequestId).toBe(id)
        // A not-sent message is unchanged: no hint and no ids.
        expect(http.message).toBe(
          `Graph ${path.operation} failed: HTTP ${status} ${code}: upstream said Bearer [redacted] [redacted]`,
        )
        expect(leakedSecrets(error)).toEqual([])
      })
    }

    for (const [name, failure, code] of MAY_HAVE_SENT_TRANSPORT) {
      test(`a transport error (${name}) may have been sent, and is sent once`, async () => {
        const { error, id } = await failSend(path, failure)
        expect(error).toBeInstanceOf(GraphTransportError)
        expect(error).toBeInstanceOf(GraphRequestError)
        expect(error).not.toBeInstanceOf(GraphHttpError)
        expect(error.name).toBe("GraphTransportError")
        const transport = error as GraphTransportErrorShape
        expect(transport.operation).toBe(path.operation)
        expect(transport.code).toBe(code)
        if (code !== undefined) {
          expect(transport.message).toContain(`(${code})`)
        }
        expect("cause" in transport).toBe(false)
        expect(transport.mayHaveSent).toBe(true)
        expect(transport.clientRequestId).toBe(id)
        expect(transport.message).toMatch(
          new RegExp(`^Graph ${path.operation} failed: `),
        )
        expect(transport.message).toContain(MAY_HAVE_SENT)
        expect(transport.message).toContain(`client-request-id ${id}`)
        expect(isOneLine(transport.message)).toBe(true)
        expect(leakedSecrets(error)).toEqual([])
      })
    }

    test("a transport error that proves the request never left was not sent", async () => {
      for (const [name, failure, code, text] of NOT_SENT_TRANSPORT) {
        const { error, id } = await failSend(path, failure)
        expect(error, name).toBeInstanceOf(GraphTransportError)
        const transport = error as GraphTransportErrorShape
        expect(transport.operation, name).toBe(path.operation)
        expect(transport.code, name).toBe(code)
        expect(transport.mayHaveSent, name).toBe(false)
        expect(transport.clientRequestId, name).toBe(id)
        expect("cause" in transport, name).toBe(false)
        // A not-sent message is unchanged: no hint and no ids.
        expect(transport.message, name).toBe(
          `Graph ${path.operation} failed: ${text} (${code})`,
        )
        expect(leakedSecrets(error), name).toEqual([])
      }
    })

    for (const [name, answer] of [
      ["202 whose body then fails (terminated)", () => brokenBody(202)],
      ["200 whose body never ends", () => stalledBody(200)],
    ] as [string, () => Response][]) {
      test(`a ${name} was sent: the send resolves`, async () => {
        const c = virtualClock()
        const { fetch, calls } = fakeFetch(c, (call) =>
          path.sending(call) ? answer() : path.before(call),
        )
        const out = await c.run(path.run(driver(c, fetch)))
        expect(out.state).toBe("resolved")
        // At once: the status decided it, the body was never waited for.
        expect(out.at).toBe(c.start)
        expect(calls.filter(path.sending)).toHaveLength(1)
      })
    }
  })
}

test.describe("failures before the sending POST sent nothing", () => {
  test("a guard refusal makes no request at all", async () => {
    for (const act of ["send", "reply"] as const) {
      const c = virtualClock()
      const { fetch, calls } = fakeFetch(c, () => undefined)
      const d = driver(c, fetch)
      const error = rejected(
        await c.run(
          act === "send"
            ? d.send({ ...mail, to: "someone@elsewhere.example.org" })
            : d.reply(
                {
                  ...original,
                  replyTo: [],
                  from: "support@elsewhere.example.org",
                },
                replyMail,
              ),
        ),
      )
      expect(error, act).toBeInstanceOf(SendRefusedError)
      expect(calls, act).toEqual([])
      expect(mayHaveSentOf(error), act).not.toBe(true)
      expect(error.message, act).not.toContain(MAY_HAVE_SENT)
    }
  })

  const tokenFailures: [string, () => Answer][] = [
    [
      "HTTP 401",
      () =>
        json(401, {
          error: "invalid_client",
          error_description: "AADSTS7000215: Invalid client secret provided.",
        }),
    ],
    ["HTTP 500", () => json(500, { error: "server_error" })],
    [
      "HTTP 429",
      () => json(429, { error: "throttled" }, { "Retry-After": "3" }),
    ],
    ["a transport error", () => fetchFailed(systemError("ECONNRESET", "read"))],
  ]
  for (const [pathName, path] of Object.entries(PATHS)) {
    for (const [name, failure] of tokenFailures) {
      test(`${pathName}: a token failure (${name}) sends nothing`, async () => {
        const c = virtualClock()
        const { fetch, calls } = fakeFetch(c, (call) =>
          isToken(call) ? failure() : path.before(call),
        )
        const error = rejected(await c.run(path.run(driver(c, fetch))))
        expect(calls.filter((call) => !isToken(call))).toEqual([])
        expect(error).toBeInstanceOf(GraphRequestError)
        // Always a boolean on the driver's own errors.
        expect(mayHaveSentOf(error)).toBe(false)
        expect((error as GraphRequestErrorShape).operation).toBe(
          "token request",
        )
        expect(error.message).not.toContain(MAY_HAVE_SENT)
        expect(leakedSecrets(error)).toEqual([])
      })
    }
  }
})

test.describe("reply draft steps are never may-have-sent", () => {
  const draftFailures: [string, () => Answer][] = [
    ...MAY_HAVE_SENT_STATUSES.map(([status, code]): [string, () => Answer] => [
      `HTTP ${status}`,
      () => graphError(status, code),
    ]),
    ...MAY_HAVE_SENT_TRANSPORT.map(
      ([name, failure]): [string, () => Answer] => [name, failure],
    ),
    ["no answer", () => "hang"],
  ]
  for (const step of ["createReply", "PATCH"] as const) {
    for (const [name, failure] of draftFailures) {
      test(`${step}: ${name} leaves at most an unsent draft`, async () => {
        const c = virtualClock()
        const failing = step === "createReply" ? isCreateReply : isPatch
        const { fetch, calls } = fakeFetch(c, (call) =>
          failing(call) ? failure() : draftSteps(call),
        )
        const error = rejected(
          await c.run(driver(c, fetch).reply(original, replyMail)),
        )
        expect(calls.filter(failing)).toHaveLength(1)
        expect(calls.filter(isDraftSend)).toHaveLength(0)
        expect(error).toBeInstanceOf(GraphRequestError)
        expect(mayHaveSentOf(error)).toBe(false)
        expect(error.message).not.toContain(MAY_HAVE_SENT)
        expect(error.message).not.toContain("client-request-id")
        expect(leakedSecrets(error)).toEqual([])
      })
    }
  }
})

test.describe("every message is one line", () => {
  test("a multi-line Graph error, transport message or timeout stays one line", async () => {
    const failures: [string, () => Answer][] = [
      [
        "a multi-line Graph error message",
        () =>
          json(500, {
            error: {
              code: "InternalServerError",
              message: "one\r\ntwo\nthree",
            },
          }),
      ],
      [
        "a multi-line transport message",
        () =>
          fetchFailed(
            systemError("ECONNRESET", "read"),
            "fetch failed\n    at somewhere (file.js:1:1)",
          ),
      ],
      ["no answer", () => "hang"],
    ]
    for (const [pathName, path] of Object.entries(PATHS)) {
      for (const [name, failure] of failures) {
        const { error } = await failSend(path, failure)
        expect(isOneLine(error.message), `${pathName}: ${name}`).toBe(true)
        expect(error.message, `${pathName}: ${name}`).toContain(MAY_HAVE_SENT)
      }
    }
  })

  test("every error class keeps its message on one line", () => {
    const made: Error[] = [
      new GraphRequestError("a\r\nb\nc", "op", false, undefined),
      new GraphHttpError("a\nb", "op", 500, undefined),
      new GraphTransportError("a\nb", "op", { mayHaveSent: true }),
      new mailGraph.GraphRequestTimeoutError("a\nb", "op", 1_000, true),
    ]
    for (const error of made) {
      expect(isOneLine(error.message), error.name).toBe(true)
      expect(error.message, error.name).toMatch(/^a b/)
      expect(error).toBeInstanceOf(GraphRequestError)
    }
  })

  test("GraphHttpError keeps its four positional arguments; the details are optional", () => {
    const plain = new GraphHttpError("m", "GET /x", 503, 7_000)
    expect(plain.mayHaveSent).toBe(false)
    expect(plain.clientRequestId).toBeUndefined()
    expect(plain.retryAfterMs).toBe(7_000)
    const detailed = new GraphHttpError("m", "POST /x", 500, undefined, {
      mayHaveSent: true,
      clientRequestId: "id-1",
    })
    expect(detailed.mayHaveSent).toBe(true)
    expect(detailed.clientRequestId).toBe("id-1")
    expect(detailed.name).toBe("GraphHttpError")
  })
})

test.describe("secrets", () => {
  test("no may-have-sent failure shows the secret or the token", async () => {
    for (const [pathName, path] of Object.entries(PATHS)) {
      for (const [name, failure] of [
        ...MAY_HAVE_SENT_TRANSPORT.map(([n, f]): [string, () => Answer] => [
          n,
          f,
        ]),
        ["HTTP 500", () => graphError(500, "InternalServerError")],
        ["no answer", () => "hang"],
      ] as [string, () => Answer][]) {
        const c = virtualClock()
        const { fetch } = fakeFetch(c, (call) =>
          path.sending(call) ? failure() : path.before(call),
        )
        const error = rejected(await c.run(path.run(driver(c, fetch))))
        expect(leakedSecrets(error), `${pathName}: ${name}`).toEqual([])
      }
    }
  })
})
