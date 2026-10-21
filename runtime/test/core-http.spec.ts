// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "@playwright/test"

import { ConfigError } from "../src/core/index.js"
import {
  assertRequestTimeoutMs,
  fetchWithin,
  formatBound,
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
