// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "@playwright/test"

import * as core from "../src/core/index.js"
import { ConfigError } from "../src/core/index.js"
import {
  assertRequestTimeoutMs,
  fetchWithin,
  formatBound,
  requestFailure,
  withoutCallLog,
  withoutUrlQueries,
} from "../src/core/http.js"

// The internal bounded-request helper (#20) shared by the Graph driver and
// the seam client. Its timing is proven through both callers on the
// virtual clock (mail-graph-timeout.spec.ts, rails-seam-timeout.spec.ts);
// these are the edges they do not reach.

test("assertRequestTimeoutMs names the option, never the value", () => {
  for (const bad of [0, 1.5, 2 ** 31, "5", undefined, null]) {
    expect(() =>
      assertRequestTimeoutMs(bad, "X option requestTimeoutMs"),
    ).toThrow(
      new ConfigError(
        "X option requestTimeoutMs must be a whole number of milliseconds from 1 to 2147483647.",
      ),
    )
  }
  expect(() => assertRequestTimeoutMs(1, "X")).not.toThrow()
})

test("formatBound: whole seconds as s, else ms", () => {
  expect([30_000, 1_000, 300, 1_500].map(formatBound)).toEqual([
    "30 s",
    "1 s",
    "300 ms",
    "1500 ms",
  ])
})

test("a body it was told not to read is cancelled, and a cancel that throws changes nothing", async () => {
  const cancelled: string[] = []
  const answers = [
    // A real body: cancelled.
    new Response(
      new ReadableStream({
        cancel() {
          cancelled.push("stream")
        },
      }),
      { status: 202 },
    ),
    // A body whose cancel throws at once.
    {
      ok: true,
      status: 202,
      headers: new Headers(),
      body: {
        cancel() {
          throw new Error("locked")
        },
      },
    } as unknown as Response,
    // A body whose cancel rejects.
    {
      ok: true,
      status: 202,
      headers: new Headers(),
      body: { cancel: () => Promise.reject(new Error("locked")) },
    } as unknown as Response,
  ]
  for (const answer of answers) {
    const reply = await fetchWithin(
      () => Promise.resolve(answer),
      "http://localhost/x",
      { method: "POST" },
      1_000,
      new Error("bound"),
      { readBody: () => false },
    )
    expect(reply).toEqual({
      status: 202,
      ok: true,
      headers: answer.headers,
      text: "",
    })
  }
  expect(cancelled).toEqual(["stream"])
})

test("#26 withoutCallLog: everything from Playwright's Call log line on is dropped", () => {
  expect(
    withoutCallLog(
      "apiRequestContext.get: Timeout 5ms exceeded.\nCall log:\n  - cookie: s=X\n",
    ),
  ).toBe("apiRequestContext.get: Timeout 5ms exceeded.")
  expect(withoutCallLog("a\nb\n  Call log:\n  - x")).toBe("a\nb")
  // Only a line that starts with it.
  expect(withoutCallLog("see the Call log: below")).toBe(
    "see the Call log: below",
  )
  expect(withoutCallLog("no log here")).toBe("no log here")
})

test("#26 withoutUrlQueries: an http(s) URL keeps its path, never its query or fragment", () => {
  expect(
    withoutUrlQueries(
      "at https://h.test/reset?token=A&b=c#x then http://h:3000/p#frag and HTTP://H/q?z",
    ),
  ).toBe("at https://h.test/reset then http://h:3000/p and HTTP://H/q")
  expect(withoutUrlQueries('"http://h/a?b=c"')).toBe('"http://h/a"')
  expect(withoutUrlQueries("not a url ?a=b")).toBe("not a url ?a=b")
})

test("#26 requestFailure: the first line only, no query, at most 300 characters", () => {
  const error = new Error(
    "apiRequestContext.post: connect ECONNREFUSED http://h/x?t=SECRET\nCall log:\n  - cookie: s=COOKIE",
  )
  expect(requestFailure(error)).toBe(
    "apiRequestContext.post: connect ECONNREFUSED http://h/x",
  )
  expect(requestFailure(new Error(`${"a".repeat(400)}\nb`))).toHaveLength(300)
  expect(requestFailure(new Error(""))).toBe("request failed")
  expect(requestFailure(new Error("\nCall log:\n - cookie: s=C"))).toBe(
    "request failed",
  )
  expect(requestFailure("plain string\nsecond")).toBe("plain string")
  expect(requestFailure(undefined)).toBe("unknown error")
  expect(requestFailure(null)).toBe("unknown error")
  // Public: an adapter describes its own request failures with it.
  expect(core.requestFailure).toBe(requestFailure)
})
