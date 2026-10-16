// SPDX-License-Identifier: Apache-2.0

import type { APIRequestContext, APIResponse } from "@playwright/test"
import { expect, test } from "@playwright/test"

import {
  InertiaPropsReader,
  parseInitialPage,
} from "../src/rails-inertia/index.js"

// The Inertia props reader's less common paths: pages that look like the
// Inertia page but are not, partial reloads of paths not yet read, and the
// error text of a refused partial reload.

const page = (component: string, props: Record<string, unknown> = {}) => ({
  component,
  props,
  url: "/",
  version: "v1",
})

const html = (component: string) =>
  `<script data-page="app" type="application/json">${JSON.stringify(page(component))}</script>`

interface Reply {
  status?: number
  body?: unknown
  html?: string
}

function fakeRequest(handler: (url: string, inertia: boolean) => Reply) {
  const calls: { url: string; inertia: boolean }[] = []
  const request = {
    get(url: string, options: { headers?: Record<string, string> } = {}) {
      const inertia = Boolean(options.headers?.["X-Inertia"])
      calls.push({ url, inertia })
      const reply = handler(url, inertia)
      return Promise.resolve({
        status: () => reply.status ?? 200,
        url: () => `http://127.0.0.1:3000${url}`,
        text: () => Promise.resolve(reply.html ?? ""),
        json: () => Promise.resolve(reply.body),
      } as unknown as APIResponse)
    },
  }
  return { request: request as unknown as APIRequestContext, calls }
}

test.describe("parseInitialPage", () => {
  test("a data-page script that is not JSON is not the page", () => {
    expect(
      parseInitialPage(
        `<script data-page="app" type="text/template">${JSON.stringify(page("x"))}</script>`,
      ),
    ).toBeNull()
    expect(
      parseInitialPage(`<script data-page="app">{"component":"x"}</script>`),
    ).toBeNull()
  })
})

test.describe("partial reloads", () => {
  test("a path not read yet is read as HTML inside the reload", async () => {
    const { request, calls } = fakeRequest((url, inertia) =>
      inertia
        ? { body: page(url === "/b" ? "b/index" : "a/index", { n: 1 }) }
        : { html: html(url === "/b" ? "b/index" : "a/index") },
    )
    const reader = new InertiaPropsReader(request)
    await reader.htmlPage("/a")
    // /b was never read: its component is looked up by an HTML GET first.
    expect(await reader.props("/b", ["n"])).toEqual({ n: 1 })
    expect(calls).toEqual([
      { url: "/a", inertia: false },
      { url: "/b", inertia: false },
      { url: "/b", inertia: true },
    ])
  })

  test("a refused partial reload names the props it asked for", async () => {
    const { request } = fakeRequest((_url, inertia) =>
      inertia ? { status: 403 } : { html: html("a/index") },
    )
    const reader = new InertiaPropsReader(request, { persona: "viewer" })
    await reader.htmlPage("/a")
    await expect(reader.props("/a", ["records", "total"])).rejects.toThrow(
      "GET /a (Inertia, partial records,total) as the viewer persona returned HTTP 403.",
    )
  })

  test("a full Inertia read is not held to the component read before", async () => {
    let n = 0
    const { request } = fakeRequest((_url, inertia) =>
      inertia ? { body: page(`c${++n}`, { n }) } : { html: html("first") },
    )
    const reader = new InertiaPropsReader(request)
    await reader.htmlPage("/a")
    // No partial: the answer may be any component, and it is remembered.
    expect((await reader.page("/a")).component).toBe("c1")
    expect((await reader.page("/a")).component).toBe("c2")
  })

  test("a response that is not an Inertia page object is refused", async () => {
    const { request } = fakeRequest((_url, inertia) =>
      inertia ? { body: { component: "x" } } : { html: html("a/index") },
    )
    const reader = new InertiaPropsReader(request)
    await reader.htmlPage("/a")
    await expect(reader.page("/a")).rejects.toThrow(
      "GET /a is not an Inertia page object.",
    )
  })
})
