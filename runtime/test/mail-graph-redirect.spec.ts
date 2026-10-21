// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from "node:fs/promises"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "@playwright/test"

import {
  GraphHttpError,
  GraphMailDriver,
  type GraphMailDriverOptions,
} from "../src/mail-graph/index.js"
import {
  type Call,
  SECRET_FORMS,
  clocks,
  draftSteps,
  driver,
  fakeFetch,
  isCreateReply,
  isDraftSend,
  isHealth,
  isList,
  isMessageGet,
  isPatch,
  isSaveEml,
  isSendMail,
  isToken,
  json,
  mail,
  mailbox,
  original,
  query,
  rejected,
  replyMail,
} from "./graph-fake.js"
import { unhandledRejections, virtualClock } from "./virtual-clock.js"

// Issue #22: the driver's requests followed redirects. The fetch standard
// keeps the body on a 307/308, so a 307 on sendMail sent the mail twice (a
// redirect loop up to 21 times), and a 307 on the token request re-sent
// the form body, client_secret included, to the redirect target. Now every
// Graph and token request uses `redirect: "manual"`: a 3xx is the answer,
// a GraphHttpError that sent nothing, never followed and never retried.

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

test("every request kind asks fetch not to follow redirects", async () => {
  const c = virtualClock()
  const { fetch, calls } = fakeFetch(c, (call) => {
    if (isSaveEml(call)) return new Response("raw", { status: 200 })
    return mailbox(call) ?? draftSteps(call)
  })
  const d = driver(c, fetch)
  for (const run of [
    () => d.health(),
    () => d.waitFor(query(60_000)),
    () => d.send(mail),
    () => d.reply(original, replyMail),
  ] as (() => Promise<unknown>)[]) {
    expect((await c.run(run())).state).toBe("resolved")
  }
  const dir = await mkdtemp(join(tmpdir(), "flowreel-redirect-"))
  try {
    await d.saveEml(original, dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  for (const [name, kind] of [
    ["token", isToken],
    ["health", isHealth],
    ["list", isList],
    ["message read", isMessageGet],
    ["sendMail", isSendMail],
    ["createReply", isCreateReply],
    ["PATCH", isPatch],
    ["send", isDraftSend],
    ["saveEml", isSaveEml],
  ] as [string, (call: Call) => boolean][]) {
    const of = calls.filter(kind)
    expect(of.length, name).toBeGreaterThanOrEqual(1)
    for (const call of of) expect(call.redirect, name).toBe("manual")
  }
})

// ---------------------------------------------------------------------------
// A real loopback server and Node's own fetch: with `redirect: "manual"` it
// returns the real 3xx; without it, it follows.
// ---------------------------------------------------------------------------

interface Seen {
  method: string
  path: string
  body: string
}

/** Answers `redirectPath` with `status` + Location; records everything. */
async function redirectingServer(
  redirectPath: (path: string) => boolean,
  status: number,
) {
  const seen: Seen[] = []
  const server = http.createServer((req, res) => {
    let body = ""
    req.on("data", (d: Buffer) => {
      body += d.toString()
    })
    req.on("end", () => {
      const path = req.url ?? ""
      seen.push({ method: req.method ?? "", path, body })
      if (redirectPath(path)) {
        res.writeHead(status, { Location: "/elsewhere/target" })
        res.end()
        return
      }
      if (path.includes("/oauth2/")) {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ access_token: "tok", expires_in: 3600 }))
        return
      }
      if (path.endsWith("/createReply")) {
        res.writeHead(201, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ id: "draft-1" }))
        return
      }
      if (req.method === "PATCH") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ id: "draft-1" }))
        return
      }
      res.writeHead(202)
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  const close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  return { seen, port, close }
}

/** A driver whose Graph and token URLs point at the local server, on real fetch. */
function realDriver(port: number): GraphMailDriver {
  const local: GraphMailDriverOptions["fetch"] = (url, init) =>
    fetch(
      url
        .replace("https://graph.microsoft.com", `http://127.0.0.1:${port}`)
        .replace(
          "https://login.microsoftonline.com",
          `http://127.0.0.1:${port}`,
        ),
      init,
    )
  return new GraphMailDriver({
    tenantId: "tenant-1",
    clientId: "client-1",
    clientSecret: SECRET_FORMS[0],
    mailbox: "qa@example.com",
    replyDomain: "reply.example.com",
    defaultTimeoutMs: 10_000,
    fetch: local,
  })
}

const STEPS: [
  string,
  (path: string) => boolean,
  (d: GraphMailDriver) => Promise<unknown>,
  string,
][] = [
  [
    "sendMail",
    (p) => p.endsWith("/sendMail"),
    (d) => d.send(mail),
    "POST /users/qa%40example.com/sendMail",
  ],
  [
    "a reply's send",
    (p) => p.endsWith("/draft-1/send"),
    (d) => d.reply(original, replyMail),
    "POST /users/qa%40example.com/messages/draft-1/send",
  ],
  [
    "the token request",
    (p) => p.includes("/oauth2/"),
    (d) => d.send(mail),
    "token request",
  ],
]

for (const status of [302, 307, 308]) {
  for (const [name, redirected, run, operation] of STEPS) {
    test(`a ${status} on ${name} is the answer: one request, never followed`, async () => {
      const server = await redirectingServer(redirected, status)
      try {
        const error = await run(realDriver(server.port)).then(
          () => undefined,
          (e: unknown) => e,
        )
        expect(error).toBeInstanceOf(GraphHttpError)
        const httpError = error as GraphHttpError
        expect(httpError.status).toBe(status)
        expect(httpError.operation).toBe(operation)
        expect(httpError.mayHaveSent).toBe(false)
        // Exactly one request to the redirecting path, none to the target.
        expect(server.seen.filter((s) => redirected(s.path))).toHaveLength(1)
        expect(
          server.seen.filter((s) => s.path.startsWith("/elsewhere")),
        ).toEqual([])
        // The client secret went only to the token path, once.
        const carrying = server.seen.filter((s) =>
          SECRET_FORMS.some((form) => s.body.includes(form)),
        )
        expect(carrying.map((s) => s.path)).toEqual([
          "/tenant-1/oauth2/v2.0/token",
        ])
        // Nothing is sent after a token failure.
        if (name === "the token request") {
          expect(
            server.seen.filter((s) => s.path.endsWith("/sendMail")),
          ).toEqual([])
        }
      } finally {
        await server.close()
      }
    })
  }
}

test("a fake 307 on sendMail is one request and not sent", async () => {
  const c = virtualClock()
  const { fetch, calls } = fakeFetch(c, (call) =>
    isSendMail(call)
      ? json(307, {}, { Location: "https://example.com/elsewhere" })
      : undefined,
  )
  const error = rejected(await c.run(driver(c, fetch).send(mail)))
  expect(error).toBeInstanceOf(GraphHttpError)
  expect((error as GraphHttpError).status).toBe(307)
  expect((error as GraphHttpError).mayHaveSent).toBe(false)
  expect(calls.filter(isSendMail)).toHaveLength(1)
  expect(
    calls.every((call) => !call.url.includes("example.com/elsewhere")),
  ).toBe(true)
})
